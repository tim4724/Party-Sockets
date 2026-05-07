import { describe, test, expect, afterEach } from "bun:test";

// Black-box tests against a deployed server. Run with:
//   LIVE_URL=https://ws.hexstacker.com bun test server.live.test.ts
// All describes skip when LIVE_URL is unset.

const LIVE = (process.env.LIVE_URL ?? "").replace(/\/$/, "");
const HTTP_URL = LIVE;
const WS_URL = LIVE.replace(/^http(s?):\/\//, "ws$1://");

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

function connect(instance?: string, path = "/"): Promise<WebSocket> {
  const qs = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}${path}${qs}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}

function sendMsg(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

function waitForType(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === type) {
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

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
});

// Deterministic machine list. Prefer LIVE_INSTANCES (comma-separated IDs);
// otherwise shell out to flyctl. Returns [] if neither yields a result —
// multi-machine tests then self-skip.
const FLY_APP = process.env.FLY_APP_NAME ?? "party-sockets";

function getInstanceIds(): string[] {
  if (process.env.LIVE_INSTANCES) {
    return process.env.LIVE_INSTANCES.split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    const proc = Bun.spawnSync(["fly", "machines", "list", "--json", "--app", FLY_APP]);
    if (proc.exitCode !== 0) return [];
    const data = JSON.parse(proc.stdout.toString());
    return data
      .filter((m: any) => m.state === "started")
      .map((m: any) => m.id as string);
  } catch {
    return [];
  }
}

describe.skipIf(!LIVE)("live", () => {
  test("/health returns ok", async () => {
    const res = await fetch(`${HTTP_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("happy path: create, join pinned, message, peer_left", async () => {
    const ws1 = track(await connect());
    sendMsg(ws1, { type: "create", clientId: "host-" + rand(), maxClients: 2 });
    const created = await waitForType(ws1, "created");

    const ws2 = track(await connect(created.instance));
    const peerJoined = waitForType(ws1, "peer_joined");
    const guestId = "guest-" + rand();
    sendMsg(ws2, { type: "join", clientId: guestId, room: created.room });
    await waitForType(ws2, "joined");
    expect((await peerJoined).clientId).toBe(guestId);

    const incoming = waitForType(ws1, "message");
    sendMsg(ws2, { type: "send", data: "hi" });
    expect((await incoming).data).toBe("hi");

    const peerLeft = waitForType(ws1, "peer_left");
    ws2.close();
    expect((await peerLeft).clientId).toBe(guestId);
  });

  test("stale ?instance= falls back to a healthy machine (no 502)", async () => {
    const res = await fetch(`${HTTP_URL}/?instance=deadbeef00000000`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("?instance= pins WS to each machine", async () => {
    const ids = getInstanceIds();
    if (ids.length < 2) {
      console.log(`[live] only ${ids.length} machine(s) — skipping pinning assertion`);
      return;
    }
    for (const id of ids) {
      const ws = track(await connect(id));
      sendMsg(ws, { type: "create", clientId: rand(), maxClients: 1 });
      const msg = await waitForType(ws, "created");
      expect(msg.instance).toBe(id);
      ws.close();
    }
  });

  test("?instance= routes away from the LB default", async () => {
    const ids = getInstanceIds();
    if (ids.length < 2) {
      console.log(`[live] only ${ids.length} machine(s) — skipping non-default pin assertion`);
      return;
    }

    // Probe with an unpinned WS to see where the LB sends us.
    const probe = track(await connect());
    sendMsg(probe, { type: "create", clientId: rand(), maxClients: 1 });
    const lbDefault = (await waitForType(probe, "created")).instance;
    probe.close();

    const other = ids.find((id) => id !== lbDefault);
    if (!other) {
      throw new Error(`LB default ${lbDefault} not in flyctl machine list ${JSON.stringify(ids)}`);
    }

    const ws = track(await connect(other));
    sendMsg(ws, { type: "create", clientId: rand(), maxClients: 1 });
    const msg = await waitForType(ws, "created");
    expect(msg.instance).toBe(other);
    expect(msg.instance).not.toBe(lbDefault);
  });

  test("path-based routing finds a room across machines", async () => {
    const ids = getInstanceIds();
    if (ids.length < 2) {
      console.log("[live] single-machine deploy — skipping peer-probe assertion");
      return;
    }

    const [hostInstance] = ids;
    const ws1 = track(await connect(hostInstance));
    sendMsg(ws1, { type: "create", clientId: "host-" + rand(), maxClients: 2 });
    const created = await waitForType(ws1, "created");
    expect(created.instance).toBe(hostInstance);

    // No ?instance=. Either the LB lands us on host directly, or path probe +
    // fly-replay routes us there. Either way the join should succeed.
    const ws2 = track(await connect(undefined, `/${created.room}`));
    const guestId = "guest-" + rand();
    sendMsg(ws2, { type: "join", clientId: guestId, room: created.room });
    const joined = await waitForType(ws2, "joined");
    expect(joined.room).toBe(created.room);
    expect(joined.clients).toContain(guestId);
  });
});
