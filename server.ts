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

// --- State ---

const rooms = new Map<string, Room>();

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

function statusPage(roomCount: number, clientCount: number, origins: Map<string, OriginStats>): string {
  let originsHtml = "";
  if (origins.size > 0) {
    const rows = Array.from(origins.entries())
      .sort((a, b) => b[1].clients - a[1].clients)
      .map(([origin, s]) => `<tr><td>${origin}</td><td>${s.rooms}</td><td>${s.clients}</td></tr>`)
      .join("");
    originsHtml = `
  <table>
    <thead><tr><th>Origin</th><th>Rooms</th><th>Clients</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Party-Sockets</title>
<style>
  * { margin: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2.5rem; max-width: 360px; width: 100%; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  .status { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.5rem; color: #4ade80; }
  .dot { width: 8px; height: 8px; background: #4ade80; border-radius: 50%; box-shadow: 0 0 6px #4ade80; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
  .stat { background: #222; border-radius: 8px; padding: 1rem; text-align: center; }
  .stat-value { font-size: 1.75rem; font-weight: 700; color: #fff; }
  .stat-label { font-size: 0.75rem; color: #888; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.85rem; }
  th { color: #888; font-weight: 500; text-align: left; padding: 0.4rem 0; border-bottom: 1px solid #2a2a2a; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 0.4rem 0; border-bottom: 1px solid #1f1f1f; }
  td:nth-child(2), td:nth-child(3), th:nth-child(2), th:nth-child(3) { text-align: right; }
  a { color: #888; font-size: 0.8rem; text-decoration: none; }
  a:hover { color: #bbb; }
</style>
</head>
<body>
<div class="card">
  <h1>Party-Sockets</h1>
  <div class="status"><span class="dot"></span> Online</div>
  <div class="stats">
    <div class="stat"><div class="stat-value">${roomCount}</div><div class="stat-label">Rooms</div></div>
    <div class="stat"><div class="stat-value">${clientCount}</div><div class="stat-label">Clients</div></div>
  </div>${originsHtml}
  <a href="https://github.com/tim4724/Party-Sockets">GitHub</a>
</div>
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
    open(ws) {
      // Nothing to do on open
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
