import type { ServerWebSocket } from "bun";
import * as base58 from "./base58";
import { encodeRegion, decodeRegion, REGION_BITS } from "./regions";

// --- Types ---

type ClientMessage =
  | { type: "create"; clientId: string; maxClients: number }
  | { type: "join"; clientId: string; room: string }
  | { type: "send"; to?: string; data: unknown };

type ServerMessage =
  | { type: "created"; room: string; instance: string; region: string }
  | { type: "joined"; room: string; clients: string[] }
  | { type: "peer_joined"; clientId: string }
  | { type: "peer_left"; clientId: string }
  | { type: "message"; from: string; data: unknown }
  | { type: "error"; message: string };

interface ClientData {
  clientId?: string;
  room?: string;
  origin?: string;
}

interface Room {
  maxClients: number;
  origin: string;
  clients: Map<string, ServerWebSocket<ClientData>>;
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
  let entry = originCounters.get(origin);
  if (!entry) { entry = { connections: 0, rooms: 0 }; originCounters.set(origin, entry); }
  entry[field]++;
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
  const dns = await import("node:dns/promises");
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
  const probes = peers.map(async ({ id }) => {
    try {
      const res = await fetch(
        `http://${id}.vm.${app}.internal:${PORT}/room/${encodeURIComponent(code)}`,
        { signal: AbortSignal.timeout(PEER_PROBE_TIMEOUT_MS) },
      );
      return res.ok ? id : null;
    } catch {
      return null;
    }
  });
  return (await Promise.all(probes)).find((x) => x) ?? null;
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

function broadcast(room: Room, msg: ServerMessage, exclude?: string) {
  const payload = JSON.stringify(msg);
  for (const [id, client] of room.clients) {
    if (id !== exclude) {
      client.send(payload);
    }
  }
}

function removeFromRoom(ws: ServerWebSocket<ClientData>) {
  const { clientId, room: roomCode } = ws.data;
  if (!clientId || !roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  // Only remove if this ws is still the active connection for this clientId
  if (room.clients.get(clientId) === ws) {
    room.clients.delete(clientId);
    broadcast(room, { type: "peer_left", clientId });

    if (room.clients.size === 0) {
      rooms.delete(roomCode);
    }
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
  const room: Room = { maxClients: msg.maxClients, origin, clients: new Map() };
  room.clients.set(msg.clientId, ws);
  rooms.set(code, room);

  ws.data.clientId = msg.clientId;
  ws.data.room = code;

  incrementStat(origin, "rooms");
  send(ws, { type: "created", room: code, instance: INSTANCE_ID, region: REGION });
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

  const existingWs = room.clients.get(msg.clientId);
  if (existingWs) {
    // Reconnect: detach and close the old connection before swapping in the new one
    existingWs.data.room = undefined;
    existingWs.data.clientId = undefined;
    existingWs.close(4000, "replaced");
    room.clients.set(msg.clientId, ws);
    ws.data.clientId = msg.clientId;
    ws.data.room = msg.room;

    const clients = Array.from(room.clients.keys());
    send(ws, { type: "joined", room: msg.room, clients });
    return;
  }

  if (room.clients.size >= room.maxClients) {
    return send(ws, { type: "error", message: "Room is full" });
  }

  room.clients.set(msg.clientId, ws);
  ws.data.clientId = msg.clientId;
  ws.data.room = msg.room;

  const clients = Array.from(room.clients.keys());
  send(ws, { type: "joined", room: msg.room, clients });
  broadcast(room, { type: "peer_joined", clientId: msg.clientId }, msg.clientId);
}

function handleSend(ws: ServerWebSocket<ClientData>, msg: { to?: string; data: unknown }) {
  const { clientId, room: roomCode } = ws.data;
  if (!clientId || !roomCode) {
    return send(ws, { type: "error", message: "Not in a room" });
  }

  const room = rooms.get(roomCode);
  if (!room) {
    return send(ws, { type: "error", message: "Room not found" });
  }

  if (msg.to) {
    const target = room.clients.get(msg.to);
    if (!target) {
      return send(ws, { type: "error", message: "Target client not found" });
    }
    send(target, { type: "message", from: clientId, data: msg.data });
  } else {
    broadcast(room, { type: "message", from: clientId, data: msg.data }, clientId);
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
    const clients = room.clients.size;
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
  const region = promLabel(REGION || "local");
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
      const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      };
      if (!room) {
        return new Response(JSON.stringify({ error: "Room not found" }), { status: 404, headers });
      }
      return new Response(JSON.stringify({
        clients: room.clients.size,
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
      for (const room of rooms.values()) clients += room.clients.size;
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
