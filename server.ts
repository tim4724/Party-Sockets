import type { ServerWebSocket } from "bun";
import * as dns from "node:dns/promises";
import * as base58 from "./base58";
import { encodeRegion, decodeRegion, REGION_BITS } from "./regions";

// --- Types ---

type ClientMessage =
  | { type: "create"; clientId: string; maxClients: number }
  | { type: "join"; clientId: string; room: string }
  | { type: "send"; to?: number; data: unknown };

type ServerMessage =
  | { type: "created"; room: string; instance: string; region: string; index: number }
  | { type: "joined"; room: string; index: number; peers: number[] }
  | { type: "peer_joined"; index: number }
  | { type: "peer_left"; index: number }
  | { type: "message"; from: number; data: unknown }
  | { type: "error"; message: string };

interface ClientData {
  clientId?: string;
  room?: string;
  origin?: string;
  index?: number;
}

interface Member {
  clientId: string;
  ws?: ServerWebSocket<ClientData>;
}

// `members` slot index = the public peer id we put on the wire. clientId stays
// server-side and acts as the bearer secret for that slot — only a connection
// presenting the same clientId can replace the existing socket. Slots are
// never reassigned to a different clientId, so a `peer_joined`/`peer_left`
// pair keeps a stable meaning for the room's lifetime.
interface Room {
  maxClients: number;
  origin: string;
  members: Member[];
  active: number;
}

// --- Constants ---

const { version: VERSION } = await import("./package.json");

const PORT = parseInt(process.env.PORT || "3000", 10);

// Generic identity for instance-pinned routing. FLY_* fallbacks are the only
// platform leak; on other platforms set INSTANCE_ID / REGION directly.
const INSTANCE_ID = process.env.INSTANCE_ID ?? process.env.FLY_MACHINE_ID ?? "";
const REGION = process.env.REGION ?? process.env.FLY_REGION ?? "";
const FLY_APP = process.env.FLY_APP_NAME ?? "";
const DASHBOARD_URL = process.env.DASHBOARD_URL
  ?? (FLY_APP ? `https://fly-metrics.net/d/fly-app/fly-app?var-app=${encodeURIComponent(FLY_APP)}` : null);
// Peer probe (findRoomOnPeers) blocks the user's request when typing a code,
// but cross-region cold-connections need real headroom. 3s tolerates a single
// slow sibling without giving up.
const PEER_PROBE_TIMEOUT_MS = 3000;

// Cap per-origin Prometheus series to avoid blowing up cardinality on a
// scanner cycling through random Origin headers. The total-origin count
// is exposed separately as `party_sockets_origins_tracked` so visibility
// of "are we capping?" stays.
const MAX_ORIGIN_SERIES = 100;

// Storage cap for originCounters. Without this, a scanner cycling unique
// Origin headers leaks ~50 bytes per request indefinitely. Sized larger
// than MAX_ORIGIN_SERIES so the overflow `__other__` bucket still has
// signal beyond the visible window. Eviction is LRU on increment.
const MAX_ORIGIN_COUNTERS = 500;

// --- State ---

const rooms = new Map<string, Room>();
const serverStartedAt = Date.now();
let draining = false;

// --- Stats ---
// Counters since process start. Lost on machine restart / scale-to-zero, so
// the *_total metrics in /metrics are scoped to the current process — Grafana
// rate() handles the resets.

interface OriginCounters {
  connections: number;
  rooms: number;
}

const originCounters = new Map<string, OriginCounters>();

function incrementStat(origin: string, field: keyof OriginCounters) {
  // Re-insert on touch so Map iteration order is LRU: the oldest entry
  // (front of the map) is the next eviction candidate, and busy origins
  // keep getting moved to the back.
  let entry = originCounters.get(origin);
  if (entry) {
    originCounters.delete(origin);
  } else {
    if (originCounters.size >= MAX_ORIGIN_COUNTERS) {
      const oldest = originCounters.keys().next().value;
      if (oldest !== undefined) originCounters.delete(oldest);
    }
    entry = { connections: 0, rooms: 0 };
  }
  entry[field]++;
  originCounters.set(origin, entry);
}

// --- Room code generation ---
// 6-char base58 codes. When FLY_REGION is set, the top 5 bits encode the
// region index so any peer can decode the code and fly-replay directly to the
// home region. Locally (no FLY_REGION) we use the full 35-bit random space;
// the routing layer is a no-op there because FLY_APP_NAME is also unset.

const CODE_LENGTH = 6;
const BODY_BITS = 30;
const TOTAL_BITS = BODY_BITS + REGION_BITS;
const MAX_CODE_VALUE = Math.pow(2, TOTAL_BITS) - 1;
const REGION_IDX = REGION ? encodeRegion(REGION) : null;

// Multiplication, not <<, when packing the region prefix. JS bitwise ops
// coerce to int32, so any region index whose bit pattern lands in the int32
// sign bit (idx 2 with BODY_BITS=30, i.e. nearly every entry now that
// REGIONS is alphabetical) would shift into the sign bit and silently
// produce a negative value.
const BODY_DIVISOR = Math.pow(2, BODY_BITS);
const REGION_PREFIX = REGION_IDX !== null ? REGION_IDX * BODY_DIVISOR : 0;
const BODY_BIT_COUNT = REGION_IDX !== null ? BODY_BITS : TOTAL_BITS;

function randomBits(bits: number): number {
  // BigInt avoids the float-precision loss we'd hit combining two 32-bit
  // words into a >32-bit Number. Result fits Number for bits <= 53.
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const combined = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
  return Number(combined & ((1n << BigInt(bits)) - 1n));
}

// Caller must rooms.set the returned code synchronously. Bun's WS message
// handler is single-threaded JS so no other create can race between the
// has() check here and the caller's set().
function generateRoomCode(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const value = REGION_PREFIX + randomBits(BODY_BIT_COUNT);
    const code = base58.encode(value, CODE_LENGTH);
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not generate a unique room code");
}

// Pure decode: returns the region name if the code is a valid 6-char base58
// code whose top 5 bits map to a known region. Returns null for any malformed
// or unassigned-region code. Caller decides what to do with the result (route
// on Fly, ignore locally, etc).
export function tryDecodeRoomCode(code: string): string | null {
  if (code.length !== CODE_LENGTH) return null;
  const value = base58.decode(code);
  if (value === null) return null;
  if (value < 0 || value > MAX_CODE_VALUE) return null;
  const regionIdx = Math.floor(value / BODY_DIVISOR);
  return decodeRegion(regionIdx);
}


// --- Peer discovery ---
// Manual room-code entry has no ?instance= to pin against. Use Fly's internal
// DNS to enumerate peers, probe each via 6PN, and fly-replay to whichever one
// holds the room. No-op when FLY_APP_NAME is unset (local dev / non-Fly).

interface Peer {
  id: string;
  region: string;
}

async function getPeers(): Promise<Peer[]> {
  // Re-read env at call time so tests can mutate FLY_APP_NAME after module
  // load. The module-level FLY_APP constant is for code paths that genuinely
  // need a snapshot (e.g. DASHBOARD_URL).
  const app = process.env.FLY_APP_NAME ?? "";
  if (!app) return [];
  try {
    const records = await dns.resolveTxt(`vms.${app}.internal`);
    return records.flat().join("")
      .split(",")
      .map((s) => {
        const [id, region] = s.trim().split(" ");
        return { id, region: region ?? "" };
      })
      .filter((p) => p.id && p.id !== INSTANCE_ID);
  } catch {
    return [];
  }
}

// Probes siblings in the given region to find which one holds the code. All
// codes encode their home region, so callers always pass a specific region —
// we never probe across regions. Empty `region` short-circuits to null.
export async function findRoomOnPeers(code: string, region: string): Promise<string | null> {
  const app = process.env.FLY_APP_NAME ?? "";
  if (!app || !region) return null;
  const peers = (await getPeers()).filter((p) => p.region === region);
  if (peers.length === 0) return null;

  // Resolve on the first peer that claims the room and abort the rest.
  // Promise.any rejects only if every probe rejects, so we throw on miss
  // (404 / network error / per-probe timeout) to keep the contract.
  const controller = new AbortController();
  const probes = peers.map(async ({ id }) => {
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(PEER_PROBE_TIMEOUT_MS),
    ]);
    const res = await fetch(
      `http://${id}.vm.${app}.internal:${PORT}/room/${encodeURIComponent(code)}`,
      { signal },
    );
    if (!res.ok) throw new Error("miss");
    return id;
  });
  try {
    const winner = await Promise.any(probes);
    controller.abort();
    return winner;
  } catch {
    return null;
  }
}

function flyReplayToInstance(id: string): Response {
  // instance= forces cross-region routing; timeout=5s lets a scaled-to-zero
  // or suspended target wake up; fallback=force_self handles unreachable or
  // unknown IDs by serving locally. We don't pre-validate the ID because
  // Fly's 6PN DNS only lists running machines — pre-filtering would block
  // wake-ups for stopped/suspended targets.
  return new Response(null, {
    status: 409,
    headers: { "fly-replay": `instance=${id};timeout=5s;fallback=force_self` },
  });
}

function flyReplayToRegion(region: string): Response {
  return new Response(null, {
    status: 409,
    headers: { "fly-replay": `region=${region};timeout=5s;fallback=force_self` },
  });
}

// --- Helpers ---

function send(ws: ServerWebSocket<ClientData>, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

// Bun pub/sub: ws.publish broadcasts to all topic subscribers except the
// caller, server.publish to all of them. We push the fanout into the uWS
// layer so we don't iterate clients in JS for every message — meaningful
// at room sizes where multiple peers exchange real-time state.
function topicForRoom(code: string): string {
  return `room:${code}`;
}

function broadcast(code: string, msg: ServerMessage, fromWs?: ServerWebSocket<ClientData>) {
  const payload = JSON.stringify(msg);
  const topic = topicForRoom(code);
  if (fromWs) fromWs.publish(topic, payload);
  else server.publish(topic, payload);
}

function removeFromRoom(ws: ServerWebSocket<ClientData>) {
  const { index, room: roomCode } = ws.data;
  if (index === undefined || !roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  // Only remove if this ws is still the active connection for this slot.
  // After a reconnect-replace the old ws's data.index is cleared, so this
  // path never fires for it — but keep the ws-identity check as a belt.
  const member = room.members[index];
  if (!member || member.ws !== ws) return;

  member.ws = undefined;
  room.active--;
  ws.data.room = undefined;
  ws.data.clientId = undefined;
  ws.data.index = undefined;

  if (room.active === 0) {
    rooms.delete(roomCode);
  } else {
    // Closing ws is auto-unsubscribed by Bun, so server.publish naturally
    // skips it. No explicit unsubscribe needed.
    broadcast(roomCode, { type: "peer_left", index });
  }
}

// --- Message handlers ---

function handleCreate(ws: ServerWebSocket<ClientData>, msg: { clientId: string; maxClients: number }) {
  if (draining) {
    return send(ws, { type: "error", message: "Server draining" });
  }
  if (ws.data.room) {
    return send(ws, { type: "error", message: "Already in a room" });
  }
  if (!msg.clientId || typeof msg.clientId !== "string") {
    return send(ws, { type: "error", message: "clientId is required" });
  }
  if (!msg.maxClients || typeof msg.maxClients !== "number" || msg.maxClients < 1) {
    return send(ws, { type: "error", message: "maxClients must be a positive number" });
  }

  const code = generateRoomCode();
  const origin = ws.data.origin || "unknown";
  const room: Room = {
    maxClients: msg.maxClients,
    origin,
    members: [{ clientId: msg.clientId, ws }],
    active: 1,
  };
  rooms.set(code, room);
  ws.subscribe(topicForRoom(code));

  ws.data.clientId = msg.clientId;
  ws.data.room = code;
  ws.data.index = 0;

  incrementStat(origin, "rooms");
  send(ws, { type: "created", room: code, instance: INSTANCE_ID, region: REGION, index: 0 });
}

function handleJoin(ws: ServerWebSocket<ClientData>, msg: { clientId: string; room: string }) {
  if (ws.data.room) {
    return send(ws, { type: "error", message: "Already in a room" });
  }
  if (!msg.clientId || typeof msg.clientId !== "string") {
    return send(ws, { type: "error", message: "clientId is required" });
  }
  if (!msg.room || typeof msg.room !== "string") {
    return send(ws, { type: "error", message: "room is required" });
  }

  const room = rooms.get(msg.room);
  if (!room) {
    return send(ws, { type: "error", message: "Room not found" });
  }

  // Linear scan over members. clientId never crosses the wire — matching it
  // is the proof-of-ownership that lets the new ws displace the old one.
  // O(n) is fine: n is small (party-game lobby sizes).
  const existingIndex = room.members.findIndex((m) => m?.clientId === msg.clientId);
  if (existingIndex !== -1) {
    const existing = room.members[existingIndex]!;
    const wasActive = existing.ws !== undefined;
    if (existing.ws) {
      // Detach the old ws so its close handler doesn't tear down the slot we're
      // about to hand to the new ws.
      existing.ws.data.room = undefined;
      existing.ws.data.clientId = undefined;
      existing.ws.data.index = undefined;
      existing.ws.close(4000, "replaced");
    } else {
      room.active++;
    }

    existing.ws = ws;
    ws.subscribe(topicForRoom(msg.room));
    ws.data.clientId = msg.clientId;
    ws.data.room = msg.room;
    ws.data.index = existingIndex;

    const peers = peerIndices(room, existingIndex);
    send(ws, { type: "joined", room: msg.room, index: existingIndex, peers });
    if (!wasActive) broadcast(msg.room, { type: "peer_joined", index: existingIndex }, ws);
    return;
  }

  if (room.members.length >= room.maxClients) {
    return send(ws, { type: "error", message: "Room is full" });
  }

  const index = room.members.length;
  room.members.push({ clientId: msg.clientId, ws });
  room.active++;
  ws.subscribe(topicForRoom(msg.room));
  ws.data.clientId = msg.clientId;
  ws.data.room = msg.room;
  ws.data.index = index;

  const peers = peerIndices(room, index);
  send(ws, { type: "joined", room: msg.room, index, peers });
  broadcast(msg.room, { type: "peer_joined", index }, ws);
}

function peerIndices(room: Room, selfIndex: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < room.members.length; i++) {
    if (i !== selfIndex && room.members[i]?.ws) out.push(i);
  }
  return out;
}

function handleSend(ws: ServerWebSocket<ClientData>, msg: { to?: number; data: unknown }) {
  const { index, room: roomCode } = ws.data;
  if (index === undefined || !roomCode) {
    return send(ws, { type: "error", message: "Not in a room" });
  }

  const room = rooms.get(roomCode);
  if (!room) {
    return send(ws, { type: "error", message: "Room not found" });
  }

  if (msg.to !== undefined) {
    if (!Number.isSafeInteger(msg.to) || msg.to < 0) {
      return send(ws, { type: "error", message: "Target peer not found" });
    }
    const target = room.members[msg.to];
    if (!target?.ws) {
      return send(ws, { type: "error", message: "Target peer not found" });
    }
    send(target.ws, { type: "message", from: index, data: msg.data });
  } else {
    broadcast(roomCode, { type: "message", from: index, data: msg.data }, ws);
  }
}

// --- Metrics ---

interface OriginStats {
  rooms: number;
  clients: number;
}

function getOriginStats(): { roomCount: number; clientCount: number; origins: Map<string, OriginStats> } {
  let roomCount = 0;
  let clientCount = 0;
  const origins = new Map<string, OriginStats>();
  for (const room of rooms.values()) {
    roomCount++;
    const clients = room.active;
    clientCount += clients;
    const key = room.origin;
    const entry = origins.get(key);
    if (entry) {
      entry.rooms++;
      entry.clients += clients;
    } else {
      origins.set(key, { rooms: 1, clients });
    }
  }
  return { roomCount, clientCount, origins };
}

// Escape Prometheus label values per exposition format: backslash, newline,
// double quote.
function promLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function metricsText(): string {
  const { roomCount, clientCount, origins } = getOriginStats();
  const mem = process.memoryUsage();
  const uptimeS = (Date.now() - serverStartedAt) / 1000;
  const inst = promLabel(INSTANCE_ID || "local");
  const region = promLabel((REGION || "local").toUpperCase());
  const ver = promLabel(VERSION);
  const lbl = `instance="${inst}",region="${region}",version="${ver}"`;
  const lines: string[] = [];

  lines.push(`# HELP party_sockets_clients Live WebSocket clients`);
  lines.push(`# TYPE party_sockets_clients gauge`);
  lines.push(`party_sockets_clients{${lbl}} ${clientCount}`);

  lines.push(`# HELP party_sockets_rooms Live rooms`);
  lines.push(`# TYPE party_sockets_rooms gauge`);
  lines.push(`party_sockets_rooms{${lbl}} ${roomCount}`);

  lines.push(`# HELP party_sockets_origins_tracked Distinct origins seen since boot`);
  lines.push(`# TYPE party_sockets_origins_tracked gauge`);
  lines.push(`party_sockets_origins_tracked{${lbl}} ${originCounters.size}`);

  // Cap per-origin series. Sort by the union of live clients + since-boot
  // connections so a noisy/abusive origin doesn't crowd out a legitimate
  // active one. Origins beyond the cap are aggregated into a single bucket.
  const allOrigins = new Set<string>([...origins.keys(), ...originCounters.keys()]);
  const ranked = [...allOrigins]
    .map((n) => {
      const live = origins.get(n) ?? { rooms: 0, clients: 0 };
      const tot = originCounters.get(n) ?? { connections: 0, rooms: 0 };
      return { name: n, live, tot, score: live.clients * 1000 + tot.connections };
    })
    .sort((a, b) => b.score - a.score);
  const visible = ranked.slice(0, MAX_ORIGIN_SERIES);
  const overflow = ranked.slice(MAX_ORIGIN_SERIES);
  function emitOriginSamples(metric: string, getValue: (e: typeof ranked[number]) => number) {
    for (const e of visible) {
      lines.push(`${metric}{${lbl},origin="${promLabel(e.name)}"} ${getValue(e)}`);
    }
    if (overflow.length > 0) {
      const sum = overflow.reduce((a, e) => a + getValue(e), 0);
      lines.push(`${metric}{${lbl},origin="__other__"} ${sum}`);
    }
  }

  lines.push(`# HELP party_sockets_clients_by_origin Live clients labeled by origin`);
  lines.push(`# TYPE party_sockets_clients_by_origin gauge`);
  emitOriginSamples("party_sockets_clients_by_origin", (e) => e.live.clients);

  lines.push(`# HELP party_sockets_rooms_by_origin Live rooms labeled by origin`);
  lines.push(`# TYPE party_sockets_rooms_by_origin gauge`);
  emitOriginSamples("party_sockets_rooms_by_origin", (e) => e.live.rooms);

  lines.push(`# HELP party_sockets_connections_total WebSocket connections opened since boot`);
  lines.push(`# TYPE party_sockets_connections_total counter`);
  emitOriginSamples("party_sockets_connections_total", (e) => e.tot.connections);

  lines.push(`# HELP party_sockets_rooms_created_total Rooms created since boot`);
  lines.push(`# TYPE party_sockets_rooms_created_total counter`);
  emitOriginSamples("party_sockets_rooms_created_total", (e) => e.tot.rooms);

  lines.push(`# HELP process_resident_memory_bytes Resident memory size of the bun process`);
  lines.push(`# TYPE process_resident_memory_bytes gauge`);
  lines.push(`process_resident_memory_bytes{${lbl}} ${mem.rss}`);
  lines.push(`# HELP process_heap_used_bytes Used JS heap size`);
  lines.push(`# TYPE process_heap_used_bytes gauge`);
  lines.push(`process_heap_used_bytes{${lbl}} ${mem.heapUsed}`);
  // Monotonic — counter, not gauge. Resets on process restart.
  lines.push(`# HELP process_uptime_seconds Process uptime`);
  lines.push(`# TYPE process_uptime_seconds counter`);
  lines.push(`process_uptime_seconds{${lbl}} ${uptimeS.toFixed(2)}`);

  return lines.join("\n") + "\n";
}
// --- Server ---

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    // Platform-specific (Fly.io). URL/QR clients pin via ?instance=<id>; manual
    // entry uses /<code> in the path and we discover the holding machine via
    // peer probe. We don't pre-validate the ID — fly-replay's
    // fallback=force_self handles stale/unknown IDs by serving locally, and
    // pre-validation against DNS would block wakes for stopped/suspended
    // machines (DNS only lists running ones).
    //
    // Loop prevention: when force_self fires, Fly delivers the request back
    // here with a fly-replay-src header indicating the prior replay. If we
    // see it, we're the fallback target — don't re-emit a replay.
    const requestedInstance = url.searchParams.get("instance");
    const isReplayFallback = req.headers.has("fly-replay-src");
    if (requestedInstance && requestedInstance !== INSTANCE_ID) {
      if (!isReplayFallback) {
        return flyReplayToInstance(requestedInstance);
      }
      // Fallback target: the pinned machine is unreachable. For plain HTTP
      // requests, redirect to a clean URL so a stale bookmark doesn't stay
      // pinned. Use a relative redirect so the browser keeps the original
      // scheme + host (req.url has the internal localhost:3000). WS upgrades
      // fall through to local handling — the user lands on a healthy machine
      // and gets the usual "Room not found" on join.
      const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!isUpgrade) {
        url.searchParams.delete("instance");
        const path = url.pathname + (url.search || "");
        return new Response(null, { status: 302, headers: { Location: path } });
      }
    }

    // Per-machine endpoints — handled before candidate-code routing so a path
    // like /health (also 6 chars) can't be mistaken for a room code. (See the
    // /health-as-room-code prod incident.) Sits below ?instance= because
    // /health?instance=foo legitimately means "/health on machine foo".
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/metrics") {
      return new Response(metricsText(), {
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      });
    }

    // Pull a candidate room code out of either /<code> (WS upgrade) or
    // /room/<code> (HTTP existence check). The path form is exactly 6 chars,
    // matching a real code length.
    const pathRoomMatch = url.pathname.match(/^\/([A-Za-z0-9]{6})$/);
    const apiRoomMatch = pathRoomMatch ? null : url.pathname.match(/^\/room\/([^/]+)$/);
    const candidateCode = pathRoomMatch?.[1]
      ?? (apiRoomMatch ? decodeURIComponent(apiRoomMatch[1]) : null);

    if (candidateCode && !requestedInstance && REGION_IDX !== null) {
      // Codes self-route: decode the region from the code's top 5 bits.
      // Skip locally (REGION_IDX null) — no fly-replay outside Fly.
      const region = tryDecodeRoomCode(candidateCode);
      if (region && region !== REGION) {
        return flyReplayToRegion(region);
      }
      // Same-region: probe siblings to find which one holds the room.
      if (region === REGION && !rooms.has(candidateCode)) {
        const peerInstance = await findRoomOnPeers(candidateCode, REGION);
        if (peerInstance) return flyReplayToInstance(peerInstance);
      }
    }

    if (apiRoomMatch && candidateCode) {
      const room = rooms.get(candidateCode);
      // Echo the responding instance so callers can confirm where a request
      // landed — useful for verifying cross-region replay end-to-end.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Instance-Id": INSTANCE_ID,
      };
      if (!room) {
        return new Response(JSON.stringify({ error: "Room not found" }), { status: 404, headers });
      }
      return new Response(JSON.stringify({
        clients: room.active,
        maxClients: room.maxClients,
        origin: room.origin,
      }), { headers });
    }
    const origin = req.headers.get("origin") || undefined;
    const upgraded = server.upgrade(req, { data: { origin } as ClientData });
    if (!upgraded) {
      // Browser hit on root or unknown path. With DASHBOARD_URL set (Fly
      // default, or explicit override) redirect to Grafana for cluster-wide
      // metrics. Otherwise fall back to a per-instance text snapshot — this
      // machine only, since there's no aggregator off-Fly.
      if (DASHBOARD_URL) {
        return new Response(null, {
          status: 302,
          headers: { Location: DASHBOARD_URL },
        });
      }
      let clients = 0;
      for (const room of rooms.values()) clients += room.active;
      return new Response(`rooms: ${rooms.size}\nclients: ${clients}\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
  websocket: {
    idleTimeout: 10,
    open(ws) {
      incrementStat(ws.data.origin || "unknown", "connections");
    },
    message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw as string);
      } catch {
        return send(ws, { type: "error", message: "Invalid JSON" });
      }

      switch (msg.type) {
        case "create":
          return handleCreate(ws, msg);
        case "join":
          return handleJoin(ws, msg);
        case "send":
          return handleSend(ws, msg);
        default:
          return send(ws, { type: "error", message: "Unknown message type" });
      }
    },
    close(ws) {
      removeFromRoom(ws);
    },
  },
});

console.log(`Party-Sockets running on port ${server.port}`);

// --- Graceful shutdown ---
// On SIGTERM, refuse new `create` messages so fresh games land on the new
// pod, then wait for in-progress rooms to empty before exiting. The platform
// owns the upper bound (Fly's kill_timeout sends SIGKILL after that). The
// `deadlineMs` option exists only so tests can bound their own runs.

const DRAIN_POLL_INTERVAL_MS = 500;

async function drain(options: { exitOnComplete?: boolean; deadlineMs?: number } = {}): Promise<number> {
  if (draining) return rooms.size;
  draining = true;
  const deadline = options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : null;
  console.log(`[drain] starting with ${rooms.size} rooms`);
  while (rooms.size > 0 && (deadline === null || Date.now() < deadline)) {
    await new Promise((r) => setTimeout(r, DRAIN_POLL_INTERVAL_MS));
  }
  const remaining = rooms.size;
  console.log(`[drain] complete; ${remaining} rooms remaining`);
  if (options.exitOnComplete !== false) process.exit(0);
  return remaining;
}

function _resetDrainForTest() {
  draining = false;
}

process.on("SIGTERM", () => { drain(); });
process.on("SIGINT", () => { drain(); });

export { server, rooms, drain, _resetDrainForTest };
