import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";

// Mock node:dns/promises for the peer-probe tests. No-op for the other tests
// since they leave FLY_APP_NAME unset, so the probe never reaches DNS lookup.
mock.module("node:dns/promises", () => ({
  resolveTxt: async (host: string) => {
    if (host === "vms.test-app.internal") return [["abc123 fra,def456 iad"]];
    throw new Error(`unexpected DNS query: ${host}`);
  },
}));

import { server, rooms, drain, _resetDrainForTest, tryDecodeRoomCode, packRoomCodeValue, findRoomOnPeers } from "./server";
import * as base58 from "./base58";
import { encodeRegion, decodeRegion, REGION_TO_IDX } from "./regions";

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
  test("creates a room and returns 6-char code", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "created");

    expect(msg.type).toBe("created");
    expect(msg.room).toHaveLength(6);
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

  test("ignores client-supplied room field", async () => {
    // Custom codes were removed: any room field on create is silently ignored
    // and the server always picks its own.
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4, room: "Mu5h6Z" } as any);
    const msg = await waitForType(ws, "created");

    expect(msg.room).toHaveLength(6);
    expect(msg.room).not.toBe("Mu5h6Z");
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
    const res = await fetch(`${HTTP_URL}/room/Foo123`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  test("returns room info for existing room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 8 });
    const created = await waitForType(ws, "created");

    const res = await fetch(`${HTTP_URL}/room/${created.room}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ clients: 1, maxClients: 8, origin: "unknown" });
  });

  test("sets permissive CORS header", async () => {
    const res = await fetch(`${HTTP_URL}/room/Baz789`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("stats endpoint", () => {
  const HTTP_URL = `http://localhost:${server.port}`;

  test("returns instance metadata and live counts", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    await waitForType(ws, "created");

    const res = await fetch(`${HTTP_URL}/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body).toMatchObject({
      instance: expect.any(String),
      region: expect.any(String),
      rooms: 1,
      clients: 1,
    });
    expect(typeof body.uptimeMs).toBe("number");
    expect(Number.isFinite(body.uptimeMs)).toBe(true);
    expect(body.uptimeMs >= 0).toBe(true);
  });
});

describe("room code generation", () => {
  test("generated codes are 6-char base58", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "created");

    expect(msg.room).toHaveLength(6);
    // Base58 alphabet excludes 0, O, I, l.
    expect(msg.room).toMatch(/^[1-9A-HJ-NP-Za-km-z]{6}$/);
  });

  test("retry catches local collisions", async () => {
    // crypto.getRandomValues is hard to mock; instead, pre-fill a code we
    // expect the generator to never produce naturally and verify create still
    // succeeds without returning that code.
    rooms.set("AAAAAA", { maxClients: 1, origin: "test", clients: new Map() });

    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "created");

    expect(msg.room).not.toBe("AAAAAA");
    expect(msg.room).toHaveLength(6);
    rooms.delete("AAAAAA");
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
    // No DNS validation — fallback=force_self handles unreachable IDs.
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
      const m = u.match(/^http:\/\/([a-z0-9]+)\.vm\.test-app\.internal:\d+(\/[^?]*)/);
      if (m) {
        const id = m[1];
        const path = m[2];
        const status = peerStatus.get(id) ?? 404;
        if (status !== 200) return new Response("not found", { status });
        if (path === "/stats") {
          return Response.json({
            instance: id,
            region: id === "abc123" ? "fra" : "iad",
            uptimeMs: 60_000,
            rooms: 2,
            clients: 5,
          });
        }
        return new Response("{}", { status });
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

  test("?instance=<any> emits fly-replay (Fly handles wake / fallback)", async () => {
    // We no longer pre-validate against DNS — DNS only lists running
    // machines, so validation would block wakes for stopped targets.
    // Trust fallback=force_self to handle truly-unknown IDs.
    const res = await origFetch(`http://localhost:${server.port}/health?instance=deadbeef`, {
      redirect: "manual",
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=deadbeef;timeout=5s;fallback=force_self");
  });

  test("HTTP fallback (fly-replay-src + ?instance=) redirects to a clean URL", async () => {
    // When force_self fires, Fly delivers the request back with
    // fly-replay-src. For plain HTTP we 302 to the same URL with the stale
    // ?instance= stripped, so bookmarks/QRs heal naturally.
    const res = await origFetch(`http://localhost:${server.port}/health?instance=other`, {
      redirect: "manual",
      headers: { "fly-replay-src": "instance=other;t=1" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/health");
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("WS upgrade with fly-replay-src falls through (no redirect)", async () => {
    // WS clients can't follow 302. The room-not-found path on join handles
    // the stale-pin case for them; here we just verify we don't emit a
    // redirect that would break the upgrade.
    const res = await origFetch(`http://localhost:${server.port}/?instance=other`, {
      redirect: "manual",
      headers: {
        "fly-replay-src": "instance=other;t=1",
        "Upgrade": "websocket",
      },
    });
    expect(res.status).not.toBe(302);
    expect(res.headers.get("location")).toBeNull();
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

  test("status page renders a row for each responsive peer", async () => {
    peerStatus.set("abc123", 200);
    peerStatus.set("def456", 200);

    const res = await origFetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="?instance=abc123"');
    expect(html).toContain('href="?instance=def456"');
    expect(html).toContain("fra");
    expect(html).toContain("iad");
    // Hero shows machine count via the kv block; expect the value `3`.
    expect(html).toMatch(/machines<\/span>[\s\S]*?<span class="num">3<\/span>/);
  });

  test("status page shows only self when no peers respond", async () => {
    // peerStatus is empty — both abc123 and def456 return 404 to /stats.
    const res = await origFetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/machines<\/span>[\s\S]*?<span class="num">1<\/span>/);
    expect(html).not.toContain('href="?instance=');
    expect(html).toContain('class="row machine current"');
  });

  test("findRoomOnPeers filters to the requested region", async () => {
    // abc123=fra has the room, def456=iad has it too. With region="fra" we
    // should only probe abc123. To prove def456 isn't probed, we make def456
    // respond with the room being there too — if filtering is broken and we
    // probe both, Promise order would still typically pick abc123 by index,
    // so flip the asymmetry: only def456 returns 200, abc123 returns 404.
    // With a working same-region filter, we never see def456 -> result is null.
    peerStatus.set("abc123", 404);
    peerStatus.set("def456", 200);

    const result = await findRoomOnPeers("anycode", "fra");
    expect(result).toBeNull();
  });

  test("findRoomOnPeers probes everywhere when region is empty", async () => {
    peerStatus.set("abc123", 404);
    peerStatus.set("def456", 200);

    const result = await findRoomOnPeers("anycode", "");
    expect(result).toBe("def456");
  });
});

describe("base58 codec", () => {
  test("encode/decode roundtrip", () => {
    for (const v of [0, 1, 57, 58, 1000, 0x3FFFFFFF, 0x7FFFFFFFF]) {
      expect(base58.decode(base58.encode(v, 6))).toBe(v);
    }
  });

  test("encode pads to requested length", () => {
    expect(base58.encode(0, 6)).toHaveLength(6);
    expect(base58.encode(1, 6)).toHaveLength(6);
    expect(base58.encode(58, 6)).toHaveLength(6);
  });

  test("decode rejects chars outside the alphabet", () => {
    // 0, O, I, l are excluded.
    expect(base58.decode("0AAAAA")).toBeNull();
    expect(base58.decode("OAAAAA")).toBeNull();
    expect(base58.decode("IAAAAA")).toBeNull();
    expect(base58.decode("lAAAAA")).toBeNull();
  });

  test("decode accepts every valid alphabet char", () => {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    for (const ch of alphabet) {
      expect(base58.decode(ch + "AAAAA")).not.toBeNull();
    }
  });
});

describe("regions table", () => {
  test("encode/decode roundtrip for all known regions", () => {
    for (const [region, idx] of Object.entries(REGION_TO_IDX)) {
      expect(encodeRegion(region)).toBe(idx);
      expect(decodeRegion(idx)).toBe(region);
    }
  });

  test("unknown region returns null", () => {
    expect(encodeRegion("xxx")).toBeNull();
    expect(decodeRegion(99)).toBeNull();
  });
});

describe("room code decoder", () => {
  // Build a code with a specific region by setting the top 5 bits of the
  // 35-bit value, leaving body bits zero.
  function codeForRegion(region: string): string {
    const idx = encodeRegion(region)!;
    return base58.encode(idx * Math.pow(2, 30), 6);
  }

  test("decodes region from a code minted with a known region", () => {
    expect(tryDecodeRoomCode(codeForRegion("fra"))).toEqual({ region: "fra" });
    expect(tryDecodeRoomCode(codeForRegion("nrt"))).toEqual({ region: "nrt" });
    expect(tryDecodeRoomCode(codeForRegion("sin"))).toEqual({ region: "sin" });
  });

  test("returns region: null when top bits map to unassigned slot", () => {
    // Index 31 (top of 5-bit space) is unassigned in our table.
    const code = base58.encode(31 * Math.pow(2, 30), 6);
    expect(tryDecodeRoomCode(code)).toEqual({ region: null });
  });

  test("rejects non-6-char input", () => {
    expect(tryDecodeRoomCode("ABCDE")).toBeNull();
    expect(tryDecodeRoomCode("ABCDEFG")).toBeNull();
  });

  test("rejects codes with chars outside the alphabet", () => {
    expect(tryDecodeRoomCode("0AAAAA")).toBeNull();
    expect(tryDecodeRoomCode("OAAAAA")).toBeNull();
  });

  test("rejects codes whose decoded value exceeds 35 bits", () => {
    // 58^6 - 1 fits 6 chars but exceeds 2^35.
    expect(tryDecodeRoomCode("zzzzzz")).toBeNull();
  });

  test("packed region values round-trip correctly for every known region", () => {
    // JS bitwise operators coerce to int32; any region index >= 2 with
    // BODY_BITS = 30 would shift into the sign bit if << were used. Verify
    // packRoomCodeValue produces a positive value that decodes back to the
    // intended region for every entry in the table.
    for (const [region, idx] of Object.entries(REGION_TO_IDX)) {
      for (const body of [0, 1, 0x3FFFFFFF, 0x12345678]) {
        const value = packRoomCodeValue(idx, body);
        expect(value).toBeGreaterThanOrEqual(0);
        const code = base58.encode(value, 6);
        expect(tryDecodeRoomCode(code)).toEqual({ region });
      }
    }
  });
});
