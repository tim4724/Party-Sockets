import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";

// Mock node:dns/promises for the peer-probe tests. No-op for the other tests
// since they leave FLY_APP_NAME unset, so the probe never reaches DNS lookup.
mock.module("node:dns/promises", () => ({
  resolveTxt: async (host: string) => {
    if (host === "vms.test-app.internal") return [["abc123 fra,def456 iad"]];
    throw new Error(`unexpected DNS query: ${host}`);
  },
}));

// Pin FLY_REGION + FLY_APP_NAME before the server module loads — REGION_IDX
// and DASHBOARD_URL are captured as module-level consts, so a beforeAll mutation
// after import would be too late for both. With FLY_APP_NAME set, DASHBOARD_URL
// resolves to the fly-metrics URL (catch-all 302) instead of the per-instance
// text snapshot.
process.env.FLY_REGION = "fra";
process.env.FLY_APP_NAME = "test-app";
process.env.FLY_MACHINE_ID = "test-machine";
const { server, rooms, drain, _resetDrainForTest, _setHostGraceForTest, tryDecodeRoomCode, findRoomOnPeers } = await import("./server");
import * as base58 from "./base58";
import { encodeRegion, decodeRegion, REGIONS } from "./regions";

// Build a code with a specific region by setting the top 5 bits of the
// 35-bit value. Used by routing tests that need a same-region code to
// trigger the peer probe.
function codeForRegion(region: string, body = 0): string {
  const idx = encodeRegion(region)!;
  return base58.encode(idx * Math.pow(2, 30) + body, 6);
}

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

  test("created response fills the controller url template", async () => {
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/{room}?instance={instance}",
    });
    const msg = await waitForType(ws, "created");

    // {room} -> the assigned code, {instance} -> this machine's id.
    expect(msg.url).toBe(`https://abc.com/${msg.room}?instance=test-machine`);
  });

  test("created response accepts a static url with no placeholders", async () => {
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/controller",
    });
    const msg = await waitForType(ws, "created");

    expect(msg.url).toBe("https://abc.com/controller");
  });

  test("created response omits url when none is provided", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    const msg = await waitForType(ws, "created");

    expect(msg).not.toHaveProperty("url");
  });

  test("rejects a non-https url", async () => {
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "http://abc.com/{room}",
    });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("https");
  });

  test("rejects a url with an unknown placeholder", async () => {
    // {region} is deliberately not a supported placeholder.
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/{region}",
    });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("placeholder");
  });

  test("rejects an oversized url", async () => {
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/" + "a".repeat(600),
    });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("too large");
  });

  test("measures the url cap in utf-8 bytes, not code units", async () => {
    // 216 UTF-16 code units but 616 UTF-8 bytes: a .length check would wrongly
    // accept this, so it guards that Buffer.byteLength is the measure.
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/" + "あ".repeat(200),
    });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("too large");
  });

  test("rejects a url with an unclosed placeholder brace", async () => {
    // Missing the closing brace: never substituted, would ship a literal
    // "{room" to clients instead of the code.
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/{room",
    });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("brace");
  });

  test("rejects a url containing control characters", async () => {
    // The URL parser silently strips an embedded NUL, so it must be rejected
    // up front or it survives verbatim into the emitted URL.
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 4,
      url: "https://abc.com/\u0000{room}",
    });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toContain("control");
  });

  test("rejects non-https schemes", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd"]) {
      const ws = track(await connect());
      sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4, url });
      const msg = await waitForType(ws, "error");
      expect(msg.message).toContain("https");
    }
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
    expect(joinMsg.index).toBe(1);
    expect(joinMsg.peers).toEqual([0]);
    expect(peerMsg.index).toBe(1);
  });

  test("joined response carries the resolved controller url", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, {
      type: "create", clientId: "host", maxClients: 4,
      url: "https://abc.com/{room}?instance={instance}",
    });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    const joinMsg = await waitForType(ws2, "joined");

    // The guest is the controller: it only has the code, so the relay hands it
    // the loadable url filled with that code and the holding machine's id.
    expect(joinMsg.url).toBe(`https://abc.com/${room}?instance=test-machine`);
  });

  test("reclaim path also carries the resolved controller url", async () => {
    // Reconnect (same clientId) is the pinned-reconnect scenario the url exists
    // for, and it goes through a different `joined` send than a fresh join.
    const ws1 = track(await connect());
    sendMsg(ws1, {
      type: "create", clientId: "host", maxClients: 2,
      url: "https://abc.com/{room}?instance={instance}",
    });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    // Rejoin with the same clientId -> reclaim branch, replacing the old socket.
    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "guest", room });
    const rejoined = await waitForType(ws3, "joined");

    expect(rejoined.url).toBe(`https://abc.com/${room}?instance=test-machine`);
  });

  test("rejects join to non-existent room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "join", clientId: "aaa", room: "ZZZZ" });
    const msg = await waitForType(ws, "error");

    expect(msg.message).toBe("Room not found");
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
    expect(msg1.from).toBe(1);
    expect(msg1.data).toEqual({ hello: "world" });
    expect(msg3.from).toBe(1);
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

    sendMsg(ws2, { type: "send", to: 0, data: "secret" });

    const msg = await p1;
    expect(msg.from).toBe(1);
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

    sendMsg(ws1, { type: "send", to: 99, data: "hello" });
    const msg = await waitForType(ws1, "error");

    expect(msg.message).toBe("Target peer not found");
  });

  test("rejects malformed target without crashing", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "a", maxClients: 2 });
    await waitForType(ws1, "created");

    sendMsg(ws1, { type: "send", to: "constructor", data: "hello" } as any);
    const msg = await waitForType(ws1, "error");

    expect(msg.message).toBe("Target peer not found");
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

    expect(msg.index).toBe(1);
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

    // Same slot as before — proves clientId match preserves identity
    expect(joinMsg.index).toBe(1);
    expect(joinMsg.peers).toEqual([0]);

    // New connection should receive messages
    const msgPromise = waitForType(ws3, "message");
    sendMsg(ws1, { type: "send", data: "ping" });
    const msg = await msgPromise;

    expect(msg.from).toBe(0);
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
    expect(rooms.get(room)?.active).toBe(2);
  });

  test("same clientId reclaims disconnected slot", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    const firstJoin = await waitForType(ws2, "joined");
    expect(firstJoin.index).toBe(1);

    const peerLeftPromise = waitForType(ws1, "peer_left");
    ws2.close();
    expect((await peerLeftPromise).index).toBe(1);

    const peerJoinedPromise = waitForType(ws1, "peer_joined");
    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "guest", room });
    const secondJoin = await waitForType(ws3, "joined");

    expect(secondJoin.index).toBe(1);
    expect(secondJoin.peers).toEqual([0]);
    expect((await peerJoinedPromise).index).toBe(1);
    expect(rooms.get(room)?.active).toBe(2);
  });

  test("disconnected slot frees the cap for a new joiner at the next index", async () => {
    // Cap reflects live clients. When guest disconnects (battery, network,
    // tab closed — not just intentional), a stranger can take the spot.
    // Indices are still never reassigned: the stranger gets index 2, not 1.
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const peerLeftPromise = waitForType(ws1, "peer_left");
    ws2.close();
    await peerLeftPromise;

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "stranger", room });
    const joinMsg = await waitForType(ws3, "joined");

    expect(joinMsg.index).toBe(2);
    expect(rooms.get(room)?.active).toBe(2);
    expect(rooms.get(room)?.members).toHaveLength(3);
  });

  test("reclaim fails when room re-filled while disconnected", async () => {
    // First-come-first-served: if a stranger took the freed spot before the
    // original owner reconnected, the owner gets "Room is full" — the slot
    // still exists in members[] but the cap is exhausted.
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const peerLeftPromise = waitForType(ws1, "peer_left");
    ws2.close();
    await peerLeftPromise;

    // Stranger fills the freed spot.
    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "stranger", room });
    await waitForType(ws3, "joined");

    // Original guest tries to come back — no room.
    const ws4 = track(await connect());
    sendMsg(ws4, { type: "join", clientId: "guest", room });
    const err = await waitForType(ws4, "error");

    expect(err.message).toBe("Room is full");
    expect(rooms.get(room)?.active).toBe(2);
  });

  test("attacker without the clientId cannot evict an existing peer", async () => {
    // Indices are public; clientIds stay server-side and act as the bearer
    // secret for a slot. Guessing a peer's index is trivial, but presenting
    // a wrong clientId mints a fresh slot instead of replacing the victim.
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 4 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest-secret", room });
    await waitForType(ws2, "joined");

    let ws2Closed = false;
    ws2.addEventListener("close", () => { ws2Closed = true; });

    // Attacker joins with a different clientId. Guest's slot must survive.
    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "attacker", room });
    const joinMsg = await waitForType(ws3, "joined");

    expect(joinMsg.index).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(ws2Closed).toBe(false);
    expect(rooms.get(room)?.active).toBe(3);
  });
});

describe("retained state", () => {
  test("host set_state replays to a reconnecting client", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    sendMsg(ws1, { type: "set_state", data: { round: 3, turn: "guest" } });

    // Guest drops and the host keeps the room alive.
    const peerLeftPromise = waitForType(ws1, "peer_left");
    ws2.close();
    await peerLeftPromise;

    // Reconnect: the retained snapshot arrives right after `joined`.
    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "guest", room });
    await waitForType(ws3, "joined");
    const state = await waitForType(ws3, "state");

    expect(state.data).toEqual({ round: 3, turn: "guest" });
  });

  test("host set_state replays to a fresh late joiner", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 3 });
    const { room } = await waitForType(ws1, "created");

    sendMsg(ws1, { type: "set_state", data: "lobby" });

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");
    const state = await waitForType(ws2, "state");

    expect(state.data).toBe("lobby");
  });

  test("host set_state pushes a live state update to current peers, not the sender", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    // The host must not receive an echo of its own snapshot.
    let hostGotState = false;
    ws1.addEventListener("message", (e) => {
      if (JSON.parse(e.data).type === "state") hostGotState = true;
    });

    const statePromise = waitForType(ws2, "state");
    sendMsg(ws1, { type: "set_state", data: { score: 10 } });
    const state = await statePromise;

    expect(state.data).toEqual({ score: 10 });
    await new Promise((r) => setTimeout(r, 50));
    expect(hostGotState).toBe(false);
  });

  test("host reconnect replays its own retained snapshot", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    sendMsg(ws1, { type: "set_state", data: { round: 1 } });

    // A guest keeps the room (and its snapshot) alive across the host's drop.
    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const peerLeftPromise = waitForType(ws2, "peer_left");
    ws1.close();
    await peerLeftPromise;

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "host", room });
    const joinMsg = await waitForType(ws3, "joined");
    const state = await waitForType(ws3, "state");

    expect(joinMsg.index).toBe(0);
    expect(state.data).toEqual({ round: 1 });
  });

  test("latest snapshot wins on reconnect", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    sendMsg(ws1, { type: "set_state", data: { v: 1 } });
    sendMsg(ws1, { type: "set_state", data: { v: 2 } });

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");
    const state = await waitForType(ws2, "state");

    expect(state.data).toEqual({ v: 2 });
  });

  test("non-host peer cannot set state", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    sendMsg(ws2, { type: "set_state", data: "nope" });
    const err = await waitForType(ws2, "error");

    expect(err.message).toBe("Only the host can set state");
    expect(rooms.get(room)?.state).toBeUndefined();
  });

  test("rejects set_state when not in a room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "set_state", data: "x" });
    const err = await waitForType(ws, "error");

    expect(err.message).toContain("Not in a room");
  });

  test("rejects set_state with no data", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    await waitForType(ws1, "created");

    sendMsg(ws1, { type: "set_state" });
    const err = await waitForType(ws1, "error");

    expect(err.message).toContain("required");
  });

  test("rejects a snapshot over the size cap", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    await waitForType(ws1, "created");

    sendMsg(ws1, { type: "set_state", data: "x".repeat(17 * 1024) });
    const err = await waitForType(ws1, "error");

    expect(err.message).toBe("State too large");
  });

  test("size cap counts UTF-8 bytes, not UTF-16 code units", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    await waitForType(ws1, "created");

    // 6000 × "中" is ~6002 code units (under the 16 KiB code-unit count) but
    // ~18 KB in UTF-8 — must be rejected by the byte-measured cap.
    sendMsg(ws1, { type: "set_state", data: "中".repeat(6000) });
    const err = await waitForType(ws1, "error");

    expect(err.message).toBe("State too large");
  });

  test("null is retained and replayed as null (cleared-state signal)", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    sendMsg(ws1, { type: "set_state", data: { live: true } });
    sendMsg(ws1, { type: "set_state", data: null });

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");
    const state = await waitForType(ws2, "state");

    expect(state.data).toBeNull();
  });

  test("no state message on join before the host sets anything", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    let gotState = false;
    ws2.addEventListener("message", (e) => {
      if (JSON.parse(e.data).type === "state") gotState = true;
    });
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    await new Promise((r) => setTimeout(r, 50));
    expect(gotState).toBe(false);
  });
});

describe("close_room", () => {
  const HTTP_URL = `http://localhost:${server.port}`;

  test("host closes the room: everyone gets 4001 and the room is deleted", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const hostClose = new Promise<CloseEvent>((r) => { ws1.onclose = r; });
    const guestClose = new Promise<CloseEvent>((r) => { ws2.onclose = r; });

    sendMsg(ws1, { type: "close_room" });

    const [hostEvt, guestEvt] = await Promise.all([hostClose, guestClose]);
    // The sender gets the same close frame as everyone else — that's the ack.
    expect(hostEvt.code).toBe(4001);
    expect(guestEvt.code).toBe(4001);
    expect(guestEvt.reason).toBe("room closed");
    expect(rooms.has(room)).toBe(false);
  });

  test("GET /room/:code returns 404 after close (rejoin links die)", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    expect((await fetch(`${HTTP_URL}/room/${room}`)).status).toBe(200);

    const closed = new Promise<CloseEvent>((r) => { ws1.onclose = r; });
    sendMsg(ws1, { type: "close_room" });
    await closed;

    expect((await fetch(`${HTTP_URL}/room/${room}`)).status).toBe(404);
  });

  test("non-host cannot close the room", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    sendMsg(ws2, { type: "close_room" });
    const err = await waitForType(ws2, "error");

    expect(err.message).toBe("Only the host can close the room");
    expect(rooms.has(room)).toBe(true);
    expect(rooms.get(room)?.active).toBe(2);
  });

  test("rejects close_room when not in a room", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "close_room" });
    const err = await waitForType(ws, "error");

    expect(err.message).toContain("Not in a room");
  });
});

describe("host disconnect grace", () => {
  afterEach(() => _setHostGraceForTest());

  test("hostless room is torn down after the grace window", async () => {
    _setHostGraceForTest(100);

    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const guestClose = new Promise<CloseEvent>((r) => { ws2.onclose = r; });
    const peerLeft = waitForType(ws2, "peer_left");
    ws1.close();
    await peerLeft;

    // Inside the window the room is still live and joinable.
    expect(rooms.has(room)).toBe(true);

    const evt = await guestClose;
    expect(evt.code).toBe(4001);
    expect(evt.reason).toBe("room closed");
    expect(rooms.has(room)).toBe(false);
  });

  test("host reclaim within the window cancels the teardown", async () => {
    _setHostGraceForTest(100);

    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const peerLeft = waitForType(ws2, "peer_left");
    ws1.close();
    await peerLeft;

    const ws3 = track(await connect());
    sendMsg(ws3, { type: "join", clientId: "host", room });
    const rejoined = await waitForType(ws3, "joined");
    expect(rejoined.index).toBe(0);

    // Outlive the (cancelled) window; the room must survive.
    await new Promise((r) => setTimeout(r, 250));
    expect(rooms.has(room)).toBe(true);
    expect(rooms.get(room)?.active).toBe(2);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
  });

  test("guest disconnect does not arm the teardown", async () => {
    _setHostGraceForTest(100);

    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host", maxClients: 2 });
    const { room } = await waitForType(ws1, "created");

    const ws2 = track(await connect());
    sendMsg(ws2, { type: "join", clientId: "guest", room });
    await waitForType(ws2, "joined");

    const peerLeft = waitForType(ws1, "peer_left");
    ws2.close();
    await peerLeft;

    await new Promise((r) => setTimeout(r, 250));
    expect(rooms.has(room)).toBe(true);
    expect(ws1.readyState).toBe(WebSocket.OPEN);
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
    // Use a same-region (fra) code so candidate-code routing doesn't replay
    // before we reach the local 404 handler.
    const res = await fetch(`${HTTP_URL}/room/${codeForRegion("fra", 100)}`);
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
    // X-Instance-Id is consumed by the live cross-region replay test to
    // confirm which machine actually served the response.
    expect(res.headers.get("x-instance-id")).toBe("test-machine");
    const body = await res.json();
    expect(body).toEqual({ clients: 1, maxClients: 8, origin: "unknown" });
  });

  test("includes the filled controller url when the host set one", async () => {
    const ws = track(await connect());
    sendMsg(ws, {
      type: "create", clientId: "aaa", maxClients: 8,
      url: "https://abc.com/{room}?instance={instance}",
    });
    const created = await waitForType(ws, "created");

    const res = await fetch(`${HTTP_URL}/room/${created.room}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The instance is filled with whichever machine served the lookup.
    expect(body.url).toBe(`https://abc.com/${created.room}?instance=test-machine`);
  });

  test("sets permissive CORS header", async () => {
    const res = await fetch(`${HTTP_URL}/room/${codeForRegion("fra", 200)}`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("metrics endpoint", () => {
  const HTTP_URL = `http://localhost:${server.port}`;

  test("returns Prometheus text with live counts and per-origin counters", async () => {
    const ws = track(await connect());
    sendMsg(ws, { type: "create", clientId: "aaa", maxClients: 4 });
    await waitForType(ws, "created");

    const res = await fetch(`${HTTP_URL}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("# TYPE party_sockets_clients gauge");
    expect(text).toMatch(/party_sockets_clients\{[^}]+\}\s+1$/m);
    expect(text).toMatch(/party_sockets_rooms\{[^}]+\}\s+1$/m);
    expect(text).toContain("party_sockets_connections_total");
    expect(text).toContain("process_resident_memory_bytes");
    expect(text).toContain("process_uptime_seconds");
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
    rooms.set("AAAAAA", { maxClients: 1, origin: "test", members: [], active: 0 });

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

  test("/<code> for unknown room falls through when probes don't find it", async () => {
    // Same-region 6-char code: enters the routing block, hits the same-region
    // peer probe. globalThis.fetch isn't mocked here so the probes hit real
    // DNS for *.vm.test-app.internal — which doesn't resolve, so probes fail
    // fast and findRoomOnPeers returns null. The request falls through to the
    // catch-all (302) with no fly-replay header — that's what we're guarding.
    const code = codeForRegion("fra", 42);
    const res = await fetch(`http://localhost:${server.port}/${code}`, { redirect: "manual" });
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("?instance= takes precedence over /<code>", async () => {
    // Path probe would normally fire for /A3KX, but ?instance= short-circuits it.
    const res = await fetch(`http://localhost:${server.port}/A3KX?instance=other`);
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=other;timeout=5s;fallback=force_self");
  });

  test("/<too-short> doesn't trigger probe", async () => {
    const res = await fetch(`http://localhost:${server.port}/AB`, { redirect: "manual" });
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("/<too-long> doesn't trigger probe", async () => {
    const res = await fetch(`http://localhost:${server.port}/ABCDEFG`, { redirect: "manual" });
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
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = typeof url === "string" ? url : url.toString();
      const m = u.match(/^http:\/\/([a-z0-9]+)\.vm\.test-app\.internal:\d+\//);
      if (m) {
        const id = m[1];
        const status = peerStatus.get(id) ?? 404;
        return new Response(status === 200 ? "{}" : "not found", { status });
      }
      return origFetch(url, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = origFetch;
  });

  afterEach(() => {
    peerStatus.clear();
  });

  test("fly-replays to the same-region peer that holds the room", async () => {
    // We're in fra (FLY_REGION pinned at top). A code minted for fra should
    // route to a sibling fra machine — we never probe iad for a fra code.
    peerStatus.set("abc123", 200); // fra has it
    peerStatus.set("def456", 200); // iad would also "have" it, but isn't probed

    const code = codeForRegion("fra", 1);
    const res = await origFetch(`http://localhost:${server.port}/${code}`);
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("instance=abc123;timeout=5s;fallback=force_self");
  });

  test("fly-replays to the home region for a cross-region code", async () => {
    // Code minted for iad arriving here in fra: short-circuit to region replay
    // without any peer probe.
    const code = codeForRegion("iad", 1);
    const res = await origFetch(`http://localhost:${server.port}/${code}`);
    expect(res.status).toBe(409);
    expect(res.headers.get("fly-replay")).toBe("region=iad;timeout=5s;fallback=force_self");
  });

  test("region-replay fallback (fly-replay-src) is served locally, not re-replayed", async () => {
    // If a region replay fails and force_self hands the request back, the
    // code still decodes to a foreign region. Re-emitting the replay would
    // loop until fly-proxy gives up (~45s, then 502). Serve locally instead.
    const res = await origFetch(`http://localhost:${server.port}/room/${codeForRegion("iad", 1)}`, {
      headers: { "fly-replay-src": "region=iad;t=1" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("fly-replay")).toBeNull();
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
        "Connection": "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect([101, 200, 426]).toContain(res.status);
    expect(res.headers.get("location")).toBeNull();
  });

  test("non-WS / and unknown paths redirect to the dashboard", async () => {
    const res = await origFetch(`http://localhost:${server.port}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("fly-metrics.net");
  });

  test("falls through to redirect when no peer holds the room", async () => {
    peerStatus.set("abc123", 404);
    peerStatus.set("def456", 404);

    const code = codeForRegion("fra", 2);
    const res = await origFetch(`http://localhost:${server.port}/${code}`, { redirect: "manual" });
    // Browser GET on /<code> (non-WS) hits the catch-all redirect.
    expect(res.status).toBe(302);
    expect(res.headers.get("fly-replay")).toBeNull();
  });

  test("/health is not treated as a room code (no peer probe)", async () => {
    // Reproducer for the prod incident where /health matched the
    // 4-8 char path regex and triggered a cross-region peer probe.
    // peerStatus is empty — if the probe ran, both peers would respond
    // with 404. We assert /health responds quickly with the health JSON.
    const start = Date.now();
    const res = await origFetch(`http://localhost:${server.port}/health`);
    const ms = Date.now() - start;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    // Sanity: should be much faster than even a single probe timeout (3s).
    expect(ms).toBeLessThan(500);
  });

  test("/metrics is not treated as a room code", async () => {
    const res = await origFetch(`http://localhost:${server.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("party_sockets_clients");
  });

  test("skips probe and redirects when local room exists", async () => {
    const code = codeForRegion("fra", 3);
    rooms.set(code, { maxClients: 4, origin: "test", members: [], active: 0 });
    // Make a peer claim to also have the room — if the probe ran, we'd
    // emit fly-replay to that peer. Local hit must short-circuit before
    // we ever ask the network.
    peerStatus.set("abc123", 200);
    const res = await origFetch(`http://localhost:${server.port}/${code}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("fly-replay")).toBeNull();
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

  test("findRoomOnPeers short-circuits to null when region is empty", async () => {
    // No region = no probe. All codes carry their home region in the top 5
    // bits, so callers always pass one — empty input here would mean a bug.
    peerStatus.set("abc123", 200);
    peerStatus.set("def456", 200);

    const result = await findRoomOnPeers("anycode", "");
    expect(result).toBeNull();
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
    REGIONS.forEach((region, idx) => {
      expect(encodeRegion(region)).toBe(idx);
      expect(decodeRegion(idx)).toBe(region);
    });
  });

  test("unknown region returns null", () => {
    expect(encodeRegion("xxx")).toBeNull();
    expect(decodeRegion(99)).toBeNull();
  });
});

describe("room code decoder", () => {
  test("decodes region from a code minted with a known region", () => {
    expect(tryDecodeRoomCode(codeForRegion("fra"))).toBe("fra");
    expect(tryDecodeRoomCode(codeForRegion("nrt"))).toBe("nrt");
    expect(tryDecodeRoomCode(codeForRegion("sin"))).toBe("sin");
  });

  test("returns null when top bits map to unassigned slot", () => {
    // Index 31 (top of 5-bit space) is unassigned in our table.
    const code = base58.encode(31 * Math.pow(2, 30), 6);
    expect(tryDecodeRoomCode(code)).toBeNull();
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
    // Multiplication, not <<. JS bitwise operators coerce to int32; any
    // region index >= 2 with BODY_BITS = 30 would shift into the sign bit
    // if << were used. Verify the packing produces a positive value that
    // decodes back to the intended region for every entry in the table.
    REGIONS.forEach((region, idx) => {
      for (const body of [0, 1, 0x3FFFFFFF, 0x12345678]) {
        const value = idx * Math.pow(2, 30) + body;
        expect(value).toBeGreaterThanOrEqual(0);
        const code = base58.encode(value, 6);
        expect(tryDecodeRoomCode(code)).toBe(region);
      }
    });
  });
});
