import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { server, rooms } from "./server";

const URL = `ws://localhost:${server.port}`;

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function sendMsg(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

function waitFor(ws: WebSocket, predicate?: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const prev = ws.onmessage;
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (!predicate || predicate(data)) {
        ws.onmessage = prev;
        resolve(data);
      }
    };
  });
}

function waitForType(ws: WebSocket, type: string): Promise<any> {
  return waitFor(ws, (msg) => msg.type === type);
}

// Collect all sockets for cleanup
let sockets: WebSocket[] = [];

function track(ws: WebSocket): WebSocket {
  sockets.push(ws);
  return ws;
}

afterEach(() => {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  sockets = [];
  rooms.clear();
});

afterAll(() => {
  server.stop();
});

describe("room creation", () => {
  test("creates a room and returns 4-char code", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "created");

    expect(msg.type).toBe("created");
    expect(msg.room).toHaveLength(4);
  });

  test("rejects create without clientId", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", maxClients: 4 });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("clientId");
  });

  test("rejects create with invalid maxClients", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 0 });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("maxClients");
  });

  test("rejects second create from same connection", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    await waitForType(ws, "created");

    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("Already in a room");
  });

  test("creates a room with preferred room code", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4, room: "ABCD" });
    const msg = await waitForType(ws, "created");

    expect(msg.room).toBe("ABCD");
  });

  test("ignores invalid preferred room code", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4, room: "ab" });
    const msg = await waitForType(ws, "created");

    expect(msg.room).toHaveLength(4);
    expect(msg.room).not.toBe("ab");
  });

  test("generates new code when preferred room is taken", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "aaa", maxClients: 4, room: "XYZW" });
    const msg1 = await waitForType(ws1, "created");
    expect(msg1.room).toBe("XYZW");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "create", clientId: "bbb", maxClients: 4, room: "XYZW" });
    const msg2 = await waitForType(ws2, "created");
    expect(msg2.room).not.toBe("XYZW");
  });
});

describe("joining", () => {
  test("joins an existing room", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 4 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    const peerJoinedPromise = waitForType(ws1, "peer_joined");

    sendMsg(ws2, { type: "join", clientId: "guest", room });
    const joinMsg = await waitForType(ws2, "joined");
    const peerMsg = await peerJoinedPromise;

    expect(joinMsg.room).toBe(room);
    expect(joinMsg.clients).toContain("host");
    expect(joinMsg.clients).toContain("guest");
    expect(peerMsg.clientId).toBe("guest");
  });

  test("rejects join to non-existent room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "join", clientId: "aaa", room: "ZZZZ" });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("not found");
  });

  test("rejects join when room is full", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 1 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    const msg = await waitForType(ws2, "error");

    expect(msg.message).toContain("full");
  });
});

describe("messaging", () => {
  test("broadcasts message to all other clients", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "a", maxClients: 3 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "b", room });
    await waitForType(ws2, "joined");

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "c", room });
    await waitForType(ws3, "joined");

    const p1 = waitForType(ws1, "message");
    const p3 = waitForType(ws3, "message");

    sendMsg(ws2, { type: "send", data: { hello: "world" } });

    const [msg1, msg3] = await Promise.all([p1, p3]);
    expect(msg1.from).toBe("b");
    expect(msg1.data).toEqual({ hello: "world" });
    expect(msg3.from).toBe("b");
  });

  test("sends targeted message to specific client", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "a", maxClients: 3 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "b", room });
    await waitForType(ws2, "joined");

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "c", room });
    await waitForType(ws3, "joined");

    const p1 = waitForType(ws1, "message");

    sendMsg(ws2, { type: "send", to: "a", data: "secret" });

    const msg = await p1;
    expect(msg.from).toBe("b");
    expect(msg.data).toBe("secret");
  });

  test("rejects send when not in a room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "send", data: "hello" });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("Not in a room");
  });

  test("rejects send to unknown target", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "a", maxClients: 2 });
    await waitForType(ws1, "created");

    sendMsg(ws1, { type: "send", to: "nobody", data: "hello" });
    const msg = await waitForType(ws1, "error");

    expect(msg.message).toContain("not found");
  });
});

describe("disconnect", () => {
  test("broadcasts peer_left on disconnect", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const peerLeftPromise = waitForType(ws1, "peer_left");
    ws2.close();
    const msg = await peerLeftPromise;

    expect(msg.clientId).toBe("guest");
  });

  test("room is cleaned up when last client leaves", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    expect(rooms.has(room)).toBe(true);
    ws1.close();

    // Give server a moment to process the close
    await new Promise((r) => setTimeout(r, 50));
    expect(rooms.has(room)).toBe(false);
  });
});

describe("reconnect", () => {
  test("reconnecting with same UUID replaces connection", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    // Guest reconnects with new websocket
    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "guest", room });
    const joinMsg = await waitForType(ws3, "joined");

    expect(joinMsg.clients).toContain("host");
    expect(joinMsg.clients).toContain("guest");

    // New connection should receive messages
    const msgPromise = waitForType(ws3, "message");
    sendMsg(ws1, { type: "send", data: "ping" });
    const msg = await msgPromise;

    expect(msg.from).toBe("host");
    expect(msg.data).toBe("ping");
  });

  test("replaced connection is closed with code 4000", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const closePromise = new Promise<CloseEvent>((resolve) => {
      ws2.onclose = resolve;
    });

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "guest", room });
    await waitForType(ws3, "joined");

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(4000);
    expect(closeEvent.reason).toBe("replaced");
  });

  test("replaced connection does not trigger peer_left for host", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    let peerLeft = false;
    ws1.addEventListener("message", (e) => {
      if (JSON.parse(e.data).type === "peer_left") peerLeft = true;
    });

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "guest", room });
    await waitForType(ws3, "joined");

    // Let the server finish closing ws2 and processing its close handler
    await new Promise((r) => setTimeout(r, 50));
    expect(peerLeft).toBe(false);
    expect(rooms.get(room)?.clients.size).toBe(2);
  });
});

describe("protocol errors", () => {
  test("rejects invalid JSON", async () => {
    const ws = track(await connect());
    ws.send("not json");
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("Invalid JSON");
  });

  test("rejects unknown message type", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "unknown" });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("Unknown");
  });
});
