import type { ServerWebSocket } from "bun";

// --- Types ---

type ClientMessage =
  | { type: "create"; clientId: string; maxClients: number }
  | { type: "join"; clientId: string; room: string }
  | { type: "send"; to?: string; data: unknown };

type ServerMessage =
  | { type: "created"; room: string }
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

// --- State ---

const rooms = new Map<string, Room>();
const serverStartedAt = Date.now();

// --- Stats ---

interface DayStats {
  connections: number;
  rooms: number;
}

// origin -> date -> DayStats
const stats = new Map<string, Map<string, DayStats>>();

function incrementStat(origin: string, field: keyof DayStats) {
  const date = new Date().toISOString().slice(0, 10);
  let originMap = stats.get(origin);
  if (!originMap) { originMap = new Map(); stats.set(origin, originMap); }
  const s = originMap.get(date);
  if (s) s[field]++;
  else originMap.set(date, { connections: 0, rooms: 0, [field]: 1 });
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pruneStats() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 366);
  const cutoffStr = dateStr(cutoff);
  for (const [origin, originMap] of stats) {
    for (const date of originMap.keys()) {
      if (date < cutoffStr) originMap.delete(date);
    }
    if (originMap.size === 0) stats.delete(origin);
  }
}

function aggregateStats(sinceDate: string, origin: string): DayStats {
  const result: DayStats = { connections: 0, rooms: 0 };
  const originMap = stats.get(origin);
  if (!originMap) return result;
  for (const [date, s] of originMap) {
    if (date < sinceDate) continue;
    result.connections += s.connections;
    result.rooms += s.rooms;
  }
  return result;
}

function getStatsPeriods(origin: string) {
  const now = new Date();
  const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
  const d365 = new Date(now); d365.setDate(d365.getDate() - 365);
  return {
    today: aggregateStats(dateStr(now), origin),
    days30: aggregateStats(dateStr(d30), origin),
    days365: aggregateStats(dateStr(d365), origin),
  };
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

const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)

function generateRoomCode(): string {
  let code: string;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
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
  send(ws, { type: "created", room: code });
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
    // Reconnect: replace the old connection
    existingWs.data.room = undefined;
    existingWs.data.clientId = undefined;
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

function statusPage(roomCount: number, clientCount: number, origins: Map<string, OriginStats>): string {
  pruneStats();

  const uptimeMs = Date.now() - serverStartedAt;
  const uptime = formatUptime(uptimeMs);
  const uptimeDays = uptimeMs / 86_400_000;
  const show30 = uptimeDays > 1;
  const show365 = uptimeDays > 30;
  const label30 = `${Math.min(Math.floor(uptimeDays), 30)}d`;
  const label365 = `${Math.min(Math.floor(uptimeDays), 365)}d`;

  // Collect all known origins (live + historical)
  const allOrigins = new Set([...origins.keys(), ...stats.keys()]);

  let originsHtml = "";
  if (allOrigins.size > 0) {
    const rows = Array.from(allOrigins)
      .map((origin) => ({ origin, live: origins.get(origin), periods: getStatsPeriods(origin) }))
      .sort((a, b) => (b.live?.clients ?? 0) - (a.live?.clients ?? 0))
      .map(({ origin, live, periods: p }) => {
        const name = origin.replace(/^https?:\/\//, "");
        const liveLabel = live
          ? `<span class="badge">${live.rooms} room${live.rooms !== 1 ? "s" : ""}, ${live.clients} client${live.clients !== 1 ? "s" : ""}</span>`
          : '';
        const h30 = show30 ? `<th>${label30}</th>` : "";
        const h365 = show365 ? `<th>${label365}</th>` : "";
        const c30 = (s: DayStats) => show30 ? `<td>${fmt(s.connections)}</td>` : "";
        const c365 = (s: DayStats) => show365 ? `<td>${fmt(s.connections)}</td>` : "";
        const r30 = (s: DayStats) => show30 ? `<td>${fmt(s.rooms)}</td>` : "";
        const r365 = (s: DayStats) => show365 ? `<td>${fmt(s.rooms)}</td>` : "";
        return `<div class="origin">
  <div class="oh"><span class="on">${name}</span>${liveLabel}</div>
  <table>
    <thead><tr><th></th><th>Today</th>${h30}${h365}</tr></thead>
    <tbody>
      <tr><td>Connections</td><td>${fmt(p.today.connections)}</td>${c30(p.days30)}${c365(p.days365)}</tr>
      <tr><td>Rooms</td><td>${fmt(p.today.rooms)}</td>${r30(p.days30)}${r365(p.days365)}</tr>
    </tbody>
  </table>
</div>`;
      })
      .join("");
    originsHtml = rows;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<title>Party-Sockets</title>
<style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; max-width: 400px; width: 100%; }
  h1 { font-size: 1.4rem; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem; }
  .status { display: flex; align-items: center; gap: 0.4rem; color: #4ade80; font-size: 0.8rem; }
  .dot { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; box-shadow: 0 0 6px #4ade80; }
  .uptime { color: #555; font-size: 0.75rem; margin-bottom: 1.25rem; }
  .live { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1rem; }
  .stat { background: #222; border-radius: 8px; padding: 0.75rem; text-align: center; }
  .sv { font-size: 1.5rem; font-weight: 700; color: #fff; }
  .sl { font-size: 0.7rem; color: #888; margin-top: 0.15rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .origin { background: #161616; border: 1px solid #222; border-radius: 8px; padding: 0.75rem; margin-bottom: 0.5rem; }
  .oh { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
  .on { color: #fff; font-weight: 600; font-size: 0.85rem; }
  .badge { font-size: 0.7rem; color: #4ade80; }
  .badge.off { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; font-variant-numeric: tabular-nums; }
  th { color: #555; font-weight: 500; text-align: right; padding: 0 0 0.2rem; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; }
  th:first-child { text-align: left; }
  td { padding: 0.15rem 0; color: #ccc; }
  td:first-child { color: #666; }
  td:nth-child(n+2) { text-align: right; }
  .footer { display: flex; justify-content: space-between; margin-top: 1rem; }
  a { color: #888; font-size: 0.75rem; text-decoration: none; }
  a:hover { color: #bbb; }
  .ver { color: #555; font-size: 0.75rem; }
  #test-section { margin-top: 1rem; }
  #test-btn { background: #222; border: 1px solid #333; color: #ccc; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; width: 100%; }
  #test-btn:hover { background: #2a2a2a; border-color: #444; }
  #test-btn:disabled { opacity: 0.5; cursor: default; }
  #test-chart { width: 100%; height: 100px; margin-top: 0.75rem; display: none; }
  #test-stats { display: none; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem; font-size: 0.75rem; text-align: center; }
  .ts { background: #222; border-radius: 6px; padding: 0.4rem; }
  .ts-val { color: #fff; font-weight: 600; }
  .ts-label { color: #666; font-size: 0.6rem; text-transform: uppercase; margin-top: 0.1rem; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>Party-Sockets</h1>
    <div class="status"><span class="dot"></span> Online</div>
  </div>
  <div class="uptime">Uptime ${uptime}</div>
  <div class="live">
    <div class="stat"><div class="sv">${roomCount}</div><div class="sl">Rooms</div></div>
    <div class="stat"><div class="sv">${clientCount}</div><div class="sl">Clients</div></div>
  </div>${originsHtml}
  <div id="test-section">
    <button id="test-btn" onclick="runTest()">Test Latency</button>
    <canvas id="test-chart"></canvas>
    <div id="test-stats"></div>
  </div>
  <div class="footer"><a href="https://github.com/tim4724/Party-Sockets">GitHub</a> <span class="ver">v${VERSION}</span></div>
</div>
<script>
function runTest() {
  const btn = document.getElementById('test-btn');
  const canvas = document.getElementById('test-chart');
  const statsEl = document.getElementById('test-stats');
  const ctx = canvas.getContext('2d');

  btn.disabled = true;
  btn.textContent = 'Connecting...';
  canvas.style.display = 'block';
  statsEl.style.display = 'grid';
  statsEl.innerHTML = ['Min','Avg','Max','Jitter'].map(l => '<div class="ts"><div class="ts-val" style="color:#555">-</div><div class="ts-label">' + l + '</div></div>').join('');

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
      ['Min', min, min.toFixed(1) + 'ms'],
      ['Avg', avg, avg.toFixed(1) + 'ms'],
      ['P95', p95, p95.toFixed(1) + 'ms'],
      ['Jitter', jitter, jitter.toFixed(1) + 'ms'],
    ].map(([l, n, v]) => '<div class="ts"><div class="ts-val" style="color:' + getColor(n) + '">' + v + '</div><div class="ts-label">' + l + '</div></div>').join('');
  }

  function finish() {
    ws.close();
    btn.disabled = false;
    btn.textContent = 'Test Again';
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
        btn.textContent = 'Testing... ' + remaining + 's';
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
      btn.textContent = 'Error: ' + msg.message;
      btn.disabled = false;
    }
  };

  ws.onerror = () => { btn.textContent = 'Connection failed'; btn.disabled = false; };
}
let hasTestedOnce = false;
const origRunTest = runTest;
runTest = function() { hasTestedOnce = true; origRunTest(); };
setInterval(() => { if (!hasTestedOnce) location.reload(); }, 5000);
</script>
</body>
</html>`;
}

// --- Server ---

const PORT = parseInt(process.env.PORT || "3000", 10);

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const origin = req.headers.get("origin") || undefined;
    const upgraded = server.upgrade(req, { data: { origin } as ClientData });
    if (!upgraded) {
      const { roomCount, clientCount, origins } = getOriginStats();
      return new Response(statusPage(roomCount, clientCount, origins), {
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

export { server, rooms };
