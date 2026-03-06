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
}

interface Room {
  maxClients: number;
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
  const room: Room = { maxClients: msg.maxClients, clients: new Map() };
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
    const upgraded = server.upgrade(req, { data: {} as ClientData });
    if (!upgraded) {
      return new Response("Party-Sockets relay server", { status: 200 });
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
