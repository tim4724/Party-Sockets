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
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a1a1a"/><line x1="32" y1="18" x2="18" y2="42" stroke="#888" stroke-width="3.5" stroke-linecap="round"/><line x1="32" y1="18" x2="46" y2="42" stroke="#888" stroke-width="3.5" stroke-linecap="round"/><line x1="18" y1="42" x2="46" y2="42" stroke="#888" stroke-width="3.5" stroke-linecap="round"/><circle cx="32" cy="18" r="8" fill="#f472b6"/><circle cx="18" cy="42" r="8" fill="#60a5fa"/><circle cx="46" cy="42" r="8" fill="#4ade80"/></svg>`;

const PORT = parseInt(process.env.PORT || "3000", 10);

// Generic identity for instance-pinned routing. FLY_* fallbacks are the only
// platform leak; on other platforms set INSTANCE_ID / REGION directly.
const INSTANCE_ID = process.env.INSTANCE_ID ?? process.env.FLY_MACHINE_ID ?? "";
const REGION = process.env.REGION ?? process.env.FLY_REGION ?? "";
const PEER_PROBE_TIMEOUT_MS = 500;

// --- State ---

const rooms = new Map<string, Room>();
const serverStartedAt = Date.now();
let draining = false;

// --- Stats ---
// Counters since process start. Lost on machine restart / scale-to-zero, which
// is why the status page frames numbers as "since boot" alongside the uptime.

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

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

// --- Room code generation ---
// 6-char base58 codes. When FLY_REGION is set, the top 5 bits encode the
// region index so any peer can decode the code and fly-replay directly to the
// home region — no peer probe needed for new-format codes. Locally (no
// FLY_REGION) we use the full 35-bit random space and skip region routing.

const CODE_LENGTH = 6;
const BODY_BITS = 30;
const TOTAL_BITS = BODY_BITS + REGION_BITS;
const MAX_CODE_VALUE = Math.pow(2, TOTAL_BITS) - 1;
const REGION_IDX = REGION ? encodeRegion(REGION) : null;

function randomBits(bits: number): number {
  // BigInt avoids the float-precision loss we'd hit combining two 32-bit
  // words into a >32-bit Number. Result fits Number for bits <= 53.
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  const combined = (BigInt(buf[0]) << 32n) | BigInt(buf[1]);
  return Number(combined & ((1n << BigInt(bits)) - 1n));
}

// Multiplication, not <<. JS bitwise ops coerce to int32, so any region
// index >= 2 with BODY_BITS = 30 would shift into the sign bit and
// silently produce a negative value.
export function packRoomCodeValue(regionIdx: number | null, body: number): number {
  return regionIdx !== null ? regionIdx * Math.pow(2, BODY_BITS) + body : body;
}

// Caller must rooms.set the returned code synchronously. Bun's WS message
// handler is single-threaded JS so no other create can race between the
// has() check here and the caller's set().
function generateRoomCode(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const body = randomBits(REGION_IDX !== null ? BODY_BITS : TOTAL_BITS);
    const value = packRoomCodeValue(REGION_IDX, body);
    const code = base58.encode(value, CODE_LENGTH);
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not generate a unique room code");
}

interface DecodedCode {
  region: string | null;
}

// Pure decode: returns { region } if the code is a valid 6-char base58 code
// whose top 5 bits map to a known region. Caller decides what to do with
// that information (route on Fly, ignore locally, etc).
export function tryDecodeRoomCode(code: string): DecodedCode | null {
  if (code.length !== CODE_LENGTH) return null;
  const value = base58.decode(code);
  if (value === null) return null;
  if (value < 0 || value > MAX_CODE_VALUE) return null;
  const regionIdx = Math.floor(value / Math.pow(2, BODY_BITS));
  return { region: decodeRegion(regionIdx) };
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

// Empty `region` means "probe everywhere" — used for legacy codes that
// don't encode their home region.
export async function findRoomOnPeers(code: string, region: string): Promise<string | null> {
  const app = process.env.FLY_APP_NAME ?? "";
  let peers = await getPeers();
  if (region) peers = peers.filter((p) => p.region === region);
  if (peers.length === 0) return null;
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

interface OriginAgg {
  live: { rooms: number; clients: number };
  totals: { connections: number; rooms: number };
}

interface PeerStats {
  instance: string;
  region: string;
  uptimeMs: number;
  rooms: number;
  clients: number;
  origins: Record<string, OriginAgg>;
}

interface PeerView {
  stats: PeerStats;
  link: string;
}

function isOriginAgg(x: unknown): x is OriginAgg {
  if (!x || typeof x !== "object") return false;
  const o = x as { live?: { rooms?: unknown; clients?: unknown }; totals?: { connections?: unknown; rooms?: unknown } };
  return typeof o.live?.rooms === "number" && typeof o.live?.clients === "number"
    && typeof o.totals?.connections === "number" && typeof o.totals?.rooms === "number";
}

async function fetchPeerStats(): Promise<PeerView[]> {
  // PEERS=http://localhost:3001,http://localhost:3002 enables a non-Fly path
  // for local multi-instance demos. Fly normally discovers via 6PN DNS instead.
  const peersEnv = process.env.PEERS;
  let targets: { url: string; link: string }[];
  if (peersEnv) {
    targets = peersEnv.split(",").map(s => s.trim()).filter(Boolean).map((u) => {
      const base = u.replace(/\/$/, "");
      return { url: `${base}/stats`, link: base };
    });
  } else {
    const app = process.env.FLY_APP_NAME ?? "";
    if (!app) return [];
    const peers = await getPeers();
    if (peers.length === 0) return [];
    targets = peers.map(({ id }) => ({
      url: `http://${id}.vm.${app}.internal:${PORT}/stats`,
      link: `?instance=${encodeURIComponent(id)}`,
    }));
  }
  const fetches = targets.map(async ({ url, link }): Promise<PeerView | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PEER_PROBE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const body = await res.json() as Partial<PeerStats>;
      if (typeof body?.instance !== "string") return null;
      const origins: Record<string, OriginAgg> = {};
      if (body.origins && typeof body.origins === "object") {
        for (const [k, v] of Object.entries(body.origins)) {
          if (isOriginAgg(v)) origins[k] = v;
        }
      }
      return {
        stats: {
          instance: body.instance,
          region: typeof body.region === "string" ? body.region : "",
          uptimeMs: typeof body.uptimeMs === "number" ? body.uptimeMs : 0,
          rooms: typeof body.rooms === "number" ? body.rooms : 0,
          clients: typeof body.clients === "number" ? body.clients : 0,
          origins,
        },
        link,
      };
    } catch {
      return null;
    }
  });
  return (await Promise.all(fetches)).filter((p): p is PeerView => p !== null);
}

function buildOriginAggForSelf(origins: Map<string, OriginStats>): Record<string, OriginAgg> {
  const out: Record<string, OriginAgg> = {};
  const names = new Set<string>([...origins.keys(), ...originCounters.keys()]);
  for (const name of names) {
    out[name] = {
      live: origins.get(name) ?? { rooms: 0, clients: 0 },
      totals: originCounters.get(name) ?? { connections: 0, rooms: 0 },
    };
  }
  return out;
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

// --- Status page ---

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

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function statusPage(origins: Map<string, OriginStats>, peers: PeerView[], ipFamily?: string): string {
  const uptimeMs = Date.now() - serverStartedAt;
  const isLocalOrigin = (o: string) => /^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(o);

  // Merge per-machine origins into a cluster view. Live counts aggregate cleanly
  // (sum of right-now numbers); since-boot totals are summed too — slightly
  // lossy when machines have different uptimes, but consistent with how we
  // already frame the data.
  const cluster = new Map<string, OriginAgg>();
  function addOrigin(name: string, agg: OriginAgg) {
    const e = cluster.get(name) ?? { live: { rooms: 0, clients: 0 }, totals: { connections: 0, rooms: 0 } };
    e.live.rooms += agg.live.rooms;
    e.live.clients += agg.live.clients;
    e.totals.connections += agg.totals.connections;
    e.totals.rooms += agg.totals.rooms;
    cluster.set(name, e);
  }
  const selfOrigins = buildOriginAggForSelf(origins);
  for (const [n, a] of Object.entries(selfOrigins)) addOrigin(n, a);
  for (const p of peers) for (const [n, a] of Object.entries(p.stats.origins)) addOrigin(n, a);

  const hasLocal = Array.from(cluster.keys()).some(isLocalOrigin);

  let allRooms = 0, allClients = 0, publicRooms = 0, publicClients = 0;
  for (const [name, agg] of cluster) {
    allRooms += agg.live.rooms;
    allClients += agg.live.clients;
    if (!isLocalOrigin(name)) {
      publicRooms += agg.live.rooms;
      publicClients += agg.live.clients;
    }
  }
  const machineCount = peers.length + 1;

  // Origin rows: filled dot when live, hollow when only since-boot.
  const originRows = Array.from(cluster)
    .sort((a, b) => b[1].live.clients - a[1].live.clients || b[1].totals.connections - a[1].totals.connections)
    .map(([name, agg]) => {
      const display = name.replace(/^https?:\/\//, "");
      const local = isLocalOrigin(name);
      const isLive = agg.live.clients > 0 || agg.live.rooms > 0;
      const mark = isLive ? "●" : "○";
      const liveText = `${fmt(agg.live.clients)}c · ${fmt(agg.live.rooms)}r`;
      const totalsText = agg.totals.connections === 0 && agg.totals.rooms === 0
        ? "no traffic yet"
        : `${fmt(agg.totals.connections)} conn · ${fmt(agg.totals.rooms)} room${agg.totals.rooms !== 1 ? "s" : ""} since boot`;
      return `<div class="row origin${isLive ? "" : " idle"}"${local ? " data-local" : ""}>
  <span class="mark">${mark}</span>
  <span class="o-name">${display}</span>
  <span class="o-live">${liveText}</span>
  <span class="o-totals">${totalsText}</span>
</div>`;
    })
    .join("");

  // Machine rows: current first, peers below as links. Region · uptime sit
  // beneath the id (full ipFamily lives in the splash; rows stay tight).
  const shortenId = (id: string) => (id.length > 10 ? id.slice(0, 6) : id);
  const selfId = INSTANCE_ID ? shortenId(INSTANCE_ID) : "local";
  const selfMetaRow = [REGION, formatUptime(uptimeMs)].filter(Boolean).join(" · ");
  const selfMetaSplash = [formatUptime(uptimeMs), REGION, ipFamily?.toLowerCase()].filter(Boolean).join(" · ");
  let selfRoomCount = 0, selfClientCount = 0;
  for (const s of origins.values()) { selfRoomCount += s.rooms; selfClientCount += s.clients; }
  const selfRow = `<div class="row machine current">
  <span class="mark">●</span>
  <span class="m-id">${selfId}</span>
  <span class="m-counts">${fmt(selfClientCount)}c · ${fmt(selfRoomCount)}r</span>
  <span class="m-meta">${selfMetaRow}</span>
</div>`;
  const peerRows = peers
    .slice()
    .sort((a, b) => b.stats.clients - a.stats.clients || b.stats.rooms - a.stats.rooms)
    .map(({ stats: p, link }) => {
      const idShort = p.instance ? shortenId(p.instance) : "peer";
      const meta = [p.region, formatUptime(p.uptimeMs)].filter(Boolean).join(" · ");
      return `<a class="row machine peer" href="${link}">
  <span class="mark">●</span>
  <span class="m-id">${idShort}</span>
  <span class="m-counts">${fmt(p.clients)}c · ${fmt(p.rooms)}r</span>
  <span class="m-meta">${meta}</span>
</a>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<title>Party-Sockets</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #050b14;
    --panel: #0c1622;
    --cyan: #7dd3fc;
    --green: #4ade80;
    --fg: #e2e8f0;
    --muted: #64748b;
    --dim: #334155;
    --faint: #1e293b;
  }
  * { margin: 0; box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
  body {
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
    background: var(--bg);
    color: var(--fg);
    font-size: 12px;
    line-height: 1.5;
    font-weight: 400;
    font-feature-settings: 'tnum' 1;
    display: flex;
    justify-content: center;
    min-height: 100vh;
    padding: 1.5rem 1rem 2rem;
  }
  main { width: 100%; max-width: 720px; animation: fade 0.25s ease-out; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

  /* ── splash ── */
  .splash {
    background: var(--panel);
    border: 1px solid var(--cyan);
    padding: 0.7rem 0.85rem;
    margin-bottom: 0.6rem;
  }
  .splash .row1 {
    display: flex; justify-content: space-between; align-items: baseline;
    color: var(--cyan); font-weight: 700;
    margin-bottom: 0.15rem;
  }
  .splash h1 {
    font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase;
    font-weight: 700;
  }
  .splash .ver { color: var(--cyan); font-weight: 400; font-size: 11px; }
  .splash .row2 {
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0 0.6rem;
    color: var(--muted); font-size: 11px;
  }
  .splash .row2 .ok { color: var(--green); }
  .splash .row2 .self { color: var(--fg); }
  .splash .stats {
    display: flex; gap: 1.4rem; margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--dim);
    font-size: 11px; flex-wrap: wrap;
  }
  .splash .stat { display: flex; gap: 0.4rem; }
  .splash .stat .k { color: var(--muted); }
  .splash .stat .num { color: var(--green); font-weight: 700; font-variant-numeric: tabular-nums; }

  /* ── two panes ── */
  .panes {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }
  @media (max-width: 600px) {
    .panes { grid-template-columns: 1fr; }
  }
  .panel {
    border: 1px solid var(--cyan);
    background: var(--panel);
    display: flex; flex-direction: column;
    margin: 0;
  }
  .titlebar {
    background: var(--cyan); color: var(--bg);
    padding: 0.3rem 0.6rem;
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase;
    display: flex; justify-content: space-between; align-items: center;
    gap: 0.5rem;
  }
  .titlebar .meta { font-weight: 400; opacity: 0.75; }
  .panel-c { padding: 0.5rem 0.6rem; flex: 1; }

  /* ── rows (machines + origins) ── */
  .row {
    display: grid; column-gap: 0.5rem;
    padding: 0.35rem 0;
    align-items: baseline;
    text-decoration: none; color: inherit;
  }
  .row + .row { border-top: 1px dotted var(--dim); }
  .mark { color: var(--green); font-size: 13px; line-height: 1; }
  .row.idle .mark { color: var(--dim); }

  .row.machine {
    grid-template-columns: 1ch 1fr auto;
    row-gap: 0.05rem;
  }
  .m-id { color: var(--fg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .m-meta { color: var(--muted); font-size: 10px; grid-column: 2 / span 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m-counts { color: var(--green); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .row.machine.peer .m-counts { color: var(--cyan); }
  a.row.machine { transition: background 0.12s; cursor: pointer; }
  a.row.machine:hover { background: rgba(125, 211, 252, 0.05); }

  .row.origin {
    grid-template-columns: 1ch 1fr auto;
    row-gap: 0.05rem;
  }
  .o-name { color: var(--fg); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .o-live { color: var(--green); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .row.idle .o-live { color: var(--dim); }
  .o-totals { grid-column: 2 / span 2; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }

  .o-empty { color: var(--dim); font-size: 11px; padding: 0.4rem 0.2rem; }

  /* ── localhost toggle (in titlebar) ── */
  .lt {
    display: inline-flex; align-items: center; gap: 0.3rem;
    cursor: pointer; user-select: none;
    color: var(--bg); font-weight: 700;
    letter-spacing: 0.06em; font-size: 10px;
  }
  .lt input { display: none; }
  .lt-box {
    width: 9px; height: 9px;
    border: 1px solid var(--bg); position: relative; flex-shrink: 0;
  }
  .lt input:checked + .lt-box::after {
    content: '';
    position: absolute; inset: 1px;
    background: var(--bg);
  }
  html.hide-local [data-local] { display: none; }
  .paused-tag { display: none; color: var(--muted); }
  html.paused .paused-tag { display: inline; }

  /* ── latency test ── */
  .test {
    background: var(--panel);
    border: 1px solid var(--cyan);
    color: var(--fg);
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    width: 100%;
    text-align: left;
    font-weight: 500;
    transition: background 0.12s;
    position: relative;
    margin-bottom: 0.6rem;
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }
  .test:hover { background: rgba(125, 211, 252, 0.05); }
  .test:disabled { opacity: 0.6; cursor: default; }
  .test::after { content: '→'; position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--cyan); }
  .test:disabled::after { display: none; }

  #test-chart { width: 100%; height: 100px; display: none; border: 1px solid var(--dim); margin-bottom: 0.5rem; }
  #test-stats { display: none; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.4rem; margin-bottom: 0.6rem; font-size: 10px; text-align: center; }
  .ts { border: 1px solid var(--dim); padding: 0.4rem; background: var(--panel); }
  .ts-val { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  .ts-label { color: var(--muted); font-size: 9px; margin-top: 0.1rem; text-transform: uppercase; letter-spacing: 0.05em; }

  /* ── function-key footer ── */
  .foot {
    background: var(--cyan); color: var(--bg);
    padding: 0.3rem 0.7rem;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.05em; font-weight: 700;
    flex-wrap: wrap; gap: 0.3rem 1rem;
  }
  .foot .keys { display: flex; gap: 1rem; flex-wrap: wrap; }
  .foot .key {
    color: var(--bg); text-decoration: none;
    cursor: pointer;
  }
  .foot .key sup {
    color: rgba(5,11,20,0.55);
    margin-right: 0.2rem;
    font-size: 0.8em;
  }
  .foot a.key:hover, .foot .key:hover { text-decoration: underline; }

  @media (max-width: 360px) {
    .splash .stats { gap: 0.9rem; }
    #test-stats { grid-template-columns: 1fr 1fr; }
  }
</style>
<script>if(localStorage.getItem('show-local')!=='1')document.documentElement.classList.add('hide-local');</script>
</head>
<body>
<main>
  <section class="splash" data-refresh="splash">
    <div class="row1">
      <h1>party-sockets</h1>
      <span class="ver">v${VERSION}</span>
    </div>
    <div class="row2">
      <span><span class="ok">● online</span>${selfMetaSplash ? ' · ' + selfMetaSplash : ''}<span class="paused-tag"> · paused</span></span>
      <span class="self">${selfId}</span>
    </div>
    <div class="stats">
      <span class="stat"><span class="k">clients</span><span class="num sn" data-all="${allClients}" data-public="${publicClients}">${publicClients}</span></span>
      <span class="stat"><span class="k">rooms</span><span class="num sn" data-all="${allRooms}" data-public="${publicRooms}">${publicRooms}</span></span>
      <span class="stat"><span class="k">machines</span><span class="num">${machineCount}</span></span>
    </div>
  </section>

  <div class="panes">
    <section class="panel" data-refresh="machines">
      <div class="titlebar"><span>≡  machines</span><span class="meta">${machineCount}</span></div>
      <div class="panel-c">
        ${selfRow}${peerRows}
      </div>
    </section>
    <section class="panel" data-refresh="origins">
      <div class="titlebar">
        <span>≡  origins</span>
        ${hasLocal
          ? '<label class="lt"><input type="checkbox" id="show-local"><span class="lt-box"></span><span>local</span></label>'
          : `<span class="meta">${cluster.size}</span>`}
      </div>
      <div class="panel-c">
        ${cluster.size > 0 ? originRows : '<div class="o-empty">no traffic yet</div>'}
      </div>
    </section>
  </div>

  <button class="test" id="test-btn">test latency</button>
  <canvas id="test-chart"></canvas>
  <div id="test-stats"></div>

  <div class="foot">
    <div class="keys">
      <a class="key" href="https://github.com/tim4724/Party-Sockets"><sup>F1</sup>github</a>
      <span class="key" data-key="refresh"><sup>F2</sup>refresh</span>
      <span class="key" data-key="test"><sup>F3</sup>test</span>
    </div>
    <span>v${VERSION}</span>
  </div>
</main>
<script>
function runTest() {
  const btn = document.getElementById('test-btn');
  const canvas = document.getElementById('test-chart');
  const statsEl = document.getElementById('test-stats');
  const ctx = canvas.getContext('2d');

  btn.disabled = true;
  btn.textContent = 'connecting…';
  canvas.style.display = 'block';
  statsEl.style.display = 'grid';
  statsEl.innerHTML = ['min','avg','p95','jitter'].map(l => '<div class="ts"><div class="ts-val" style="color:#555">—</div><div class="ts-label">' + l + '</div></div>').join('');

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;

  const samples = [];
  const DURATION = 15000;
  const INTERVAL = 200;
  let pending = null;
  let startTime = null;

  function getColor(avg) {
    if (avg < 50) return '#4ade80';
    if (avg < 150) return '#facc15';
    return '#f87171';
  }


  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host);
  const clientId = 'test-' + Math.random().toString(36).slice(2, 8);

  function drawChart() {
    ctx.clearRect(0, 0, W, H);
    if (samples.length < 2) return;

    const maxMs = Math.max(...samples.map(s => s.rtt), 10);
    const yScale = (H - 20) / maxMs;
    const xScale = W / DURATION;

    // Grid lines
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 0.5;
    const gridLines = [0.25, 0.5, 0.75];
    for (const g of gridLines) {
      const gy = H - 10 - (maxMs * g * yScale);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = '#555';
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxMs) + 'ms', W - 2, 12);
    ctx.fillText('0', W - 2, H - 2);

    // Line with color changing at threshold crossings
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    const thresholds = [50, 150];
    for (let i = 1; i < samples.length; i++) {
      const x0 = samples[i-1].t * xScale, y0 = H - 10 - (samples[i-1].rtt * yScale);
      const x1 = samples[i].t * xScale, y1 = H - 10 - (samples[i].rtt * yScale);
      const rtt0 = samples[i-1].rtt, rtt1 = samples[i].rtt;
      // Find threshold crossings and sort by position
      const splits = [0];
      for (const th of thresholds) {
        if ((rtt0 < th && rtt1 >= th) || (rtt0 >= th && rtt1 < th)) {
          splits.push((th - rtt0) / (rtt1 - rtt0));
        }
      }
      splits.push(1);
      splits.sort((a, b) => a - b);
      for (let j = 1; j < splits.length; j++) {
        const t0 = splits[j-1], t1 = splits[j];
        const sx0 = x0 + (x1 - x0) * t0, sy0 = y0 + (y1 - y0) * t0;
        const sx1 = x0 + (x1 - x0) * t1, sy1 = y0 + (y1 - y0) * t1;
        const midRtt = rtt0 + (rtt1 - rtt0) * ((t0 + t1) / 2);
        ctx.strokeStyle = getColor(midRtt);
        ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();
      }
    }

    // Dots colored individually
    for (const s of samples) {
      const x = s.t * xScale;
      const y = H - 10 - (s.rtt * yScale);
      ctx.fillStyle = getColor(s.rtt);
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  function showStats() {
    const rtts = samples.map(s => s.rtt);
    const min = Math.min(...rtts);
    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
    const sorted = [...rtts].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const jitter = rtts.reduce((sum, r) => sum + Math.abs(r - avg), 0) / rtts.length;

    statsEl.style.display = 'grid';
    statsEl.innerHTML = [
      ['min', min, min.toFixed(1) + 'ms'],
      ['avg', avg, avg.toFixed(1) + 'ms'],
      ['p95', p95, p95.toFixed(1) + 'ms'],
      ['jitter', jitter, jitter.toFixed(1) + 'ms'],
    ].map(([l, n, v]) => '<div class="ts"><div class="ts-val" style="color:' + getColor(n) + '">' + v + '</div><div class="ts-label">' + l + '</div></div>').join('');
  }

  function finish() {
    ws.close();
    btn.disabled = false;
    btn.textContent = 'test again';
    testActive = false;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'create', clientId, maxClients: 1 }));
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'created') {
      startTime = performance.now();
      const iv = setInterval(() => {
        const elapsed = performance.now() - startTime;
        if (elapsed >= DURATION) { clearInterval(iv); finish(); return; }
        const remaining = Math.ceil((DURATION - elapsed) / 1000);
        btn.textContent = 'testing… ' + remaining + 's';
        if (pending === null) {
          pending = performance.now();
          ws.send(JSON.stringify({ type: 'send', to: clientId, data: 'ping' }));
        }
      }, INTERVAL);
    } else if (msg.type === 'message' && pending !== null) {
      const rtt = performance.now() - pending;
      const t = performance.now() - startTime;
      pending = null;
      samples.push({ t, rtt });
      drawChart();
      showStats();
    } else if (msg.type === 'error') {
      btn.textContent = 'error: ' + msg.message;
      btn.disabled = false;
    }
  };

  ws.onerror = () => { btn.textContent = 'connection failed'; btn.disabled = false; };
}
var testActive = false;
document.getElementById('test-btn').addEventListener('click', function() { testActive = true; runTest(); });

// Function-key shortcuts. Click handlers for the foot bar items, plus actual
// F1/F2/F3 keypress bindings (we preventDefault to override browser defaults
// like Help / Find).
function runKey(k) {
  if (k === 'github') window.open('https://github.com/tim4724/Party-Sockets', '_blank');
  else if (k === 'refresh') { refresh(); startPolling(); }
  else if (k === 'test') document.getElementById('test-btn').click();
}
document.addEventListener('click', function(e) {
  var el = e.target.closest('[data-key]');
  if (el) runKey(el.dataset.key);
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'F1') { e.preventDefault(); runKey('github'); }
  else if (e.key === 'F2') { e.preventDefault(); runKey('refresh'); }
  else if (e.key === 'F3') { e.preventDefault(); runKey('test'); }
});

var root = document.documentElement;
function showLocalChecked() { return localStorage.getItem('show-local') === '1'; }
function updateCounts() {
  var showAll = showLocalChecked();
  document.querySelectorAll('.sn[data-all]').forEach(function(el) {
    el.textContent = showAll ? el.getAttribute('data-all') : el.getAttribute('data-public');
  });
}
function syncToggle() {
  var t = document.getElementById('show-local');
  if (t) t.checked = showLocalChecked();
}
document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'show-local') {
    var on = e.target.checked;
    root.classList.toggle('hide-local', !on);
    localStorage.setItem('show-local', on ? '1' : '0');
    updateCounts();
  }
});
syncToggle();
updateCounts();

async function refresh() {
  if (testActive) return;
  try {
    var r = await fetch(location.href, { cache: 'no-store' });
    if (!r.ok) return;
    var html = await r.text();
    var doc = new DOMParser().parseFromString(html, 'text/html');
    document.querySelectorAll('section[data-refresh]').forEach(function(sec) {
      var fresh = doc.querySelector('section[data-refresh="' + sec.dataset.refresh + '"]');
      if (fresh) sec.innerHTML = fresh.innerHTML;
    });
    syncToggle();
    updateCounts();
  } catch (e) {}
}
// Auto-refresh every 30s while the tab is visible, capped at 2 minutes from
// the last activation — idle tabs shouldn't fan out peer /stats forever.
// Tab focus and F2/the refresh key both reset the 2-minute window.
var refreshTimer = null;
var refreshStop = null;
function stopPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (refreshStop) clearTimeout(refreshStop);
  refreshTimer = null; refreshStop = null;
  root.classList.add('paused');
}
function startPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (refreshStop) clearTimeout(refreshStop);
  refreshTimer = setInterval(refresh, 30000);
  refreshStop = setTimeout(stopPolling, 120000);
  root.classList.remove('paused');
}
document.addEventListener('visibilitychange', function() {
  if (document.hidden) stopPolling();
  else { refresh(); startPolling(); }
});
if (!document.hidden) startPolling();
</script>
</body>
</html>`;
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
    // Pull a candidate room code out of either /<code> (WS upgrade) or
    // /room/<code> (HTTP existence check). Either path participates in
    // routing.
    let candidateCode: string | null = null;
    const pathRoomMatch = url.pathname.match(/^\/([A-Za-z0-9]{4,8})$/);
    if (pathRoomMatch) candidateCode = pathRoomMatch[1];
    else {
      const apiRoomMatch = url.pathname.match(/^\/room\/([^/]+)$/);
      if (apiRoomMatch) candidateCode = decodeURIComponent(apiRoomMatch[1]);
    }

    if (candidateCode && !requestedInstance) {
      // New-format codes self-route: decode the region from the code itself.
      // Only act on this when we know our own region (REGION_IDX set) — local
      // dev shouldn't emit fly-replay headers.
      const decoded = tryDecodeRoomCode(candidateCode);
      if (REGION_IDX !== null && decoded?.region && decoded.region !== REGION) {
        return flyReplayToRegion(decoded.region);
      }
      // Same region or legacy/non-decodable code: fall through to peer probe.
      // For same-region new-format codes we know the room can only live on a
      // sibling in our region — skip cross-region peers. For legacy codes the
      // region is unknown, so probe everyone.
      if (!rooms.has(candidateCode)) {
        const sameRegion = decoded?.region === REGION && REGION !== "";
        const peerInstance = await findRoomOnPeers(candidateCode, sameRegion ? REGION : "");
        if (peerInstance) return flyReplayToInstance(peerInstance);
      }
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/stats") {
      const { roomCount, clientCount, origins } = getOriginStats();
      const payload: PeerStats = {
        instance: INSTANCE_ID,
        region: REGION,
        uptimeMs: Date.now() - serverStartedAt,
        rooms: roomCount,
        clients: clientCount,
        origins: buildOriginAggForSelf(origins),
      };
      return new Response(JSON.stringify(payload), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: { "Content-Type": "image/svg+xml" },
      });
    }
    const roomMatch = url.pathname.match(/^\/room\/([^/]+)$/);
    if (roomMatch) {
      const code = decodeURIComponent(roomMatch[1]);
      const room = rooms.get(code);
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
      const { origins } = getOriginStats();
      const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0].trim();
      const ipFamily = forwarded?.includes(":") && !forwarded.startsWith("::ffff:") ? "IPv6" : "IPv4";
      const peers = await fetchPeerStats();
      return new Response(statusPage(origins, peers, ipFamily), {
        headers: { "Content-Type": "text/html" },
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
