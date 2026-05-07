import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";

// Mock node:dns/promises for the peer-probe tests. No-op for the other tests
// since they leave FLY_APP_NAME unset, so the probe never reaches DNS lookup.
mock.module("node:dns/promises", () => ({
  resolveTxt: async (host: string) => {
    if (host === "vms.test-app.internal") return [["abc123 fra,def456 iad"]];
    throw new Error(`unexpected DNS query: ${host}`);
  },
}));

import { server, rooms, drain, _resetDrainForTest } from "./server";

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

  test("created response includes instance and region", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "created");

    expect(msg).toHaveProperty("instance");
    expect(msg).toHaveProperty("region");
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

describe("graceful drain", () => {
  afterEach(() => _resetDrainForTest());

  test("resolves immediately with zero rooms", async () => {
    const remaining = await drain({ exitOnComplete: false, deadlineMs: 5000 });
    expect(remaining).toBe(0);
  });

  test("rejects create during drain", async () => {
    const drainPromise = drain({ exitOnComplete: false, deadlineMs: 5000 });

    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "error");
    expect(msg.message).toContain("draining");

    await drainPromise;
  });

  test("waits for active rooms, then resolves when they empty", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    await waitForType(ws1, "created");
    expect(rooms.size).toBe(1);

    const drainPromise = drain({ exitOnComplete: false, deadlineMs: 5000 });

    // Drain should still be waiting — give it a tick to loop
    await new Promise((r) => setTimeout(r, 100));
    expect(rooms.size).toBe(1);

    // Client leaves
    ws1.close();
    const remaining = await drainPromise;
    expect(remaining).toBe(0);
  });

  test("existing rooms still accept joins during drain", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 3 });
    const { room } = await waitForType(ws1, "created");

    // Start draining in the background
    const drainPromise = drain({ exitOnComplete: false, deadlineMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));

    // A controller reconnecting mid-game should still get in
    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    const msg = await waitForType(ws2, "joined");
    expect(msg.room).toBe(room);

    ws1.close();
    ws2.close();
    await drainPromise;
  });

  test("times out and returns non-zero when rooms outlast deadline", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    await waitForType(ws1, "created");
    expect(rooms.size).toBe(1);

    const remaining = await drain({ exitOnComplete: false, deadlineMs: 200 });
    expect(remaining).toBe(1);
  });
});

describe("room info endpoint", () => {
  const HTTP_URL = `http://localhost:${server.port}`;

  test("returns 404 for unknown room", async () => {
    const res = await fetch(`${HTTP_URL}/room/NOPE`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  test("returns room info for existing room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 8, room: "INFO" });
    await waitForType(ws, "created");

    const res = await fetch(`${HTTP_URL}/room/INFO`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ clients: 1, maxClients: 8, origin: "unknown" });
  });

  test("sets permissive CORS header", async () => {
    const res = await fetch(`${HTTP_URL}/room/NOPE`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("room code generation", () => {
  test("escalates length when all attempts at base length collide", async () => {
    const origRandom = Math.random;
    Math.random = () => 0; // generator picks "A...A" deterministically
    try {
      rooms.set("AAAA", { maxClients: 1, origin: "test", clients: new Map() });

      const ws = track(await connect());
      sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
      const msg = await waitForType(ws, "created");

      expect(msg.room.length).toBeGreaterThanOrEqual(5);
    } finally {
      Math.random = origRandom;
    }
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

describe("instance routing", () => {
  test("returns fly-replay when ?instance= doesn't match local INSTANCE_ID", async () => {
    // No FLY_APP_NAME — isKnownInstance trusts the input.
    const res = await fetch(`http://localhost:${server.port}/health?instance=other`, {
      redirect: "manual",
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=other;timeout=5s;fallback=force_self");
  });

  test("serves locally when ?instance= matches local INSTANCE_ID", async () => {
    // In the test env, INSTANCE_ID falls back to "" — use that.
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("/<code> for unknown room falls through when no peers are discoverable", async () => {
    // FLY_APP_NAME is unset in tests, so findRoomOnPeers short-circuits.
    // A WS upgrade to /ZZZZ should complete; the join failure surfaces as the
    // usual "Room not found" via the join message, not a connection error.
    const res = await fetch(`http://localhost:${server.port}/ZZZZ`);
    expect(res.status).toBe(200);
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("?instance= takes precedence over /<code>", async () => {
    // Path probe would normally fire for /A3KX, but ?instance= short-circuits it.
    const res = await fetch(`http://localhost:${server.port}/A3KX?instance=other`);
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=other;timeout=5s;fallback=force_self");
  });

  test("/<lowercase> doesn't trigger probe", async () => {
    const res = await fetch(`http://localhost:${server.port}/abcd`);
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("/<too-short> doesn't trigger probe", async () => {
    const res = await fetch(`http://localhost:${server.port}/AB`);
    expect(res.headers.get("fly-replay")).toBeNull();
  });
});

describe("peer probe", () => {
  // DNS is mocked at the top of this file to return peers abc123 (fra) and
  // def456 (iad) for the test app. We override globalThis.fetch so the peer
  // probe URLs return whatever the test sets in `peerStatus`; localhost calls
  // (the test hitting the server) pass through to the real fetch.
  let origFetch: typeof globalThis.fetch;
  const peerStatus = new Map<string, number>();

  beforeAll(() => {
    process.env.FLY_APP_NAME = "test-app";
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = typeof url === "string" ? url : url.toString();
      const m = u.match(/^http:\/\/([a-z0-9]+)\.vm\.test-app\.internal:/);
      if (m) {
        const status = peerStatus.get(m[1]) ?? 404;
        return new Response(status === 200 ? "{}" : "not found", { status });
      }
      return origFetch(url, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
    delete process.env.FLY_APP_NAME;
  });

  afterEach(() => {
    peerStatus.clear();
  });

  test("fly-replays to the peer that holds the room", async () => {
    peerStatus.set("def456", 200); // iad has it
    peerStatus.set("abc123", 404); // fra doesn't

    const res = await origFetch(`http://localhost:${server.port}/A3KX`);
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=def456;timeout=5s;fallback=force_self");
  });

  test("?instance=<unknown> falls through instead of emitting fly-replay", async () => {
    // FLY_APP_NAME is set in this describe; mocked DNS returns abc123 + def456.
    // An unknown ID should not trigger a replay (which would 502 at Fly's edge).
    const res = await origFetch(`http://localhost:${server.port}/health?instance=deadbeef`);
    expect(res.status).toBe(200);
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("?instance=<known-peer> emits fly-replay", async () => {
    const res = await origFetch(`http://localhost:${server.port}/health?instance=abc123`, {
      redirect: "manual",
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=abc123;timeout=5s;fallback=force_self");
  });

  test("falls through when no peer holds the room", async () => {
    peerStatus.set("abc123", 404);
    peerStatus.set("def456", 404);

    const res = await origFetch(`http://localhost:${server.port}/A3KX`);
    expect(res.status).toBe(200); // status page renders
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("skips probe and serves locally when room is on this machine", async () => {
    rooms.set("A3KX", { maxClients: 4, origin: "test", clients: new Map() });
    // No peerStatus entries — if the probe ran, both peers would 404 and we'd
    // still fall through. The signal we're testing is that the probe is short-
    // circuited by the local rooms.has() check, so we verify behavior is
    // identical to the local-room case.
    const res = await origFetch(`http://localhost:${server.port}/A3KX`);
    expect(res.status).toBe(200);
    expect(res.headers.get("fly-replay")).toBeNull();
  });
});
