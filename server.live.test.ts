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

// Deterministic machine list. Cached so multiple tests in one run don't each
// re-shell out to flyctl. Returns [] when neither env override nor flyctl
// yields a result — multi-machine tests then self-skip.
const FLY_APP = process.env.FLY_APP_NAME ?? "party-sockets";

interface Machine { id: string; region: string; state: string }

let machineCache: Machine[] | null = null;

// All deployed machines (any non-destroyed state). Cross-region replay tests
// want every region — Fly auto-wakes suspended/stopped targets when
// fly-force-instance-id pins to them, so state filtering would shrink the
// matrix unnecessarily.
function getMachineList(): Machine[] {
  if (machineCache) return machineCache;
  if (process.env.LIVE_MACHINES) {
    // "id1:region1,id2:region2" — region carried alongside id; state assumed
    // started (caller owns the override).
    machineCache = process.env.LIVE_MACHINES.split(",").map((s) => {
      const [id, region = ""] = s.trim().split(":");
      return { id, region, state: "started" };
    }).filter((m) => m.id);
    return machineCache;
  }
  if (process.env.LIVE_INSTANCES) {
    // Backward-compat: ID-only list, no region info.
    machineCache = process.env.LIVE_INSTANCES.split(",")
      .map((s) => ({ id: s.trim(), region: "", state: "started" }))
      .filter((m) => m.id);
    return machineCache;
  }
  try {
    const proc = Bun.spawnSync(["fly", "machines", "list", "--json", "--app", FLY_APP]);
    if (proc.exitCode !== 0) { machineCache = []; return machineCache; }
    const data = JSON.parse(proc.stdout.toString());
    machineCache = data
      .filter((m: any) => m.state !== "destroyed")
      .map((m: any) => ({ id: m.id as string, region: m.region as string, state: m.state as string }));
    return machineCache!;
  } catch {
    machineCache = [];
    return machineCache;
  }
}

function getInstanceIds(): string[] {
  // Match getMachineList's policy: every non-destroyed machine. Fly auto-wakes
  // stopped/suspended targets when ?instance= pins to them, and a started-only
  // filter raced with deploy bounces and silently skipped multi-machine
  // assertions.
  return getMachineList().map((m) => m.id);
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
    const joined = await waitForType(ws2, "joined");
    expect((await peerJoined).index).toBe(joined.index);

    const incoming = waitForType(ws1, "message");
    sendMsg(ws2, { type: "send", data: "hi" });
    expect((await incoming).data).toBe("hi");

    const peerLeft = waitForType(ws1, "peer_left");
    ws2.close();
    expect((await peerLeft).index).toBe(joined.index);
  });

  test("stale ?instance= falls back to a healthy machine (no 502)", async () => {
    const res = await fetch(`${HTTP_URL}/?instance=deadbeef00000000`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  // Cross-region WS handshakes (fra→nrt etc.) can run well past the default
  // 5s test timeout from a local machine.
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
  }, 30000);

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
    expect(typeof joined.index).toBe("number");
  });

  // fly-force-instance-id is a fly-proxy header that pins the request to a
  // specific machine without putting `?instance=` in the URL — letting the
  // candidate-code routing block fire (it skips when ?instance= is set). We
  // mint a code in region A, then GET /room/<code> on a machine in region B.
  // Without cross-region replay, B would 404 because the room isn't there;
  // with it, B emits `fly-replay region=A`, fly-proxy delivers to A, and the
  // room is found.
  test("cross-region replay: /room/<code> bounces to the home region", async () => {
    const machines = getMachineList();
    const byRegion = new Map<string, Machine>();
    for (const m of machines) {
      if (m.region && !byRegion.has(m.region)) byRegion.set(m.region, m);
    }
    if (byRegion.size < 2) {
      console.log(`[live] only ${byRegion.size} region(s) deployed — skipping cross-region replay assertion`);
      return;
    }

    const [host, other] = [...byRegion.values()];
    const ws = track(await connect(host.id));
    sendMsg(ws, { type: "create", clientId: "host-" + rand(), maxClients: 2 });
    const created = await waitForType(ws, "created");
    expect(created.region).toBe(host.region);

    const res = await fetch(`${HTTP_URL}/room/${created.room}`, {
      headers: { "fly-force-instance-id": other.id },
    });
    expect(res.status).toBe(200);
    // X-Instance-Id is echoed by /room/<code>; equality with host.id proves
    // the request was answered in region A — i.e. fly-force-instance-id put
    // us on B and B emitted `fly-replay region=A`. Without that, the test
    // could pass for the wrong reason (fly silently dropping the header).
    expect(res.headers.get("x-instance-id")).toBe(host.id);
    const body = await res.json();
    expect(body.clients).toBe(1);
  }, 30000);

  test("/room/<code> works without ?instance=", async () => {
    const ids = getInstanceIds();
    if (ids.length < 2) {
      console.log("[live] single-machine deploy — skipping cross-machine /room assertion");
      return;
    }

    // Mint a room on a specific machine, then GET /room/<code> from the
    // anycast endpoint — the receiving machine should decode the region and
    // either serve locally or fly-replay to the home region.
    const [hostInstance] = ids;
    const ws = track(await connect(hostInstance));
    sendMsg(ws, { type: "create", clientId: "host-" + rand(), maxClients: 2 });
    const created = await waitForType(ws, "created");
    expect(created.room).toHaveLength(6);

    const res = await fetch(`${HTTP_URL}/room/${created.room}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clients).toBe(1);
  });
});
