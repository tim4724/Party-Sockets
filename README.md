# Party-Sockets

Minimal WebSocket relay server for party games. Clients share rooms and exchange messages — the server just forwards them.

## How it works

- A client **creates** a room (server assigns a 6-char code) with a max client limit
- Other clients **join** by room code
- Each member is assigned a numeric `index` (slot id). Indices are stable for the room's lifetime — never reassigned
- Clients pick their own `clientId`; it stays server-side and acts as the bearer secret for their slot. Reconnecting with the same `clientId` replaces the old connection in the same slot
- Messages can be **broadcast** to all peers or **sent** to a specific peer index
- `peer_left` is broadcast immediately on disconnect
- Rooms are cleaned up when empty

## Run

```sh
bun run server.ts
# or
PORT=8080 bun run server.ts
```

## Usage

A host creates a room; one or more guests join it.

### Host

```js
const ws = new WebSocket("wss://your-relay.example.com");
// Treat clientId as a per-slot bearer secret. Generate it locally, never share
// it with peers, and persist it (e.g. localStorage) if you want reconnects to
// survive a page reload.
const clientId = crypto.randomUUID();

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "create", clientId, maxClients: 4 }));
};

ws.onerror = (event) => console.error("websocket error", event);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "created":     console.log("room code:", msg.room, "my index:", msg.index); break;
    case "peer_joined": console.log("peer joined:", msg.index); break;
    case "peer_left":   console.log("peer left:", msg.index); break;
    case "message":     console.log("from", msg.from, msg.data); break;
    case "error":       console.error("server error:", msg.message); break;
  }
};
```

### Guest

```js
const ws = new WebSocket("wss://your-relay.example.com");
const clientId = crypto.randomUUID(); // keep private; presenting the same one re-identifies your slot

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "join", clientId, room: "Mu5h6Z" }));
};

ws.onerror = (event) => console.error("websocket error", event);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  // Guests also receive `peer_joined`, `peer_left`, `message`, and `error` —
  // see the host snippet above for the full event surface.
  if (msg.type === "joined") {
    // msg.index is your slot; msg.peers is everyone else's slots.
    // Broadcast to all peers. Add `to: <peerIndex>` to target a single peer.
    ws.send(JSON.stringify({ type: "send", data: { move: "left" } }));
  }
};
```

### Reconnect

Joining with the same `clientId` replaces the old connection in the same slot — no special reconnect message needed. The server closes the previous WebSocket with code `4000` and reason `"replaced"`; treat that as terminal in your reconnect loop, otherwise the new connection will be torn down by the next replacement.

Because the `clientId` never leaves the original client, another connection can't impersonate you and steal your slot — they'd just be allocated a fresh index. This is also why you should generate the `clientId` with a strong RNG (`crypto.randomUUID()`) and persist it locally if you want reconnect to survive a refresh.

Hosts reconnect the same way as guests: send `join` with the original `clientId` and room code, not another `create`. If the old socket is still active, other peers are not notified — their existing peer state is unchanged. If the peer had already disconnected and peers saw `peer_left`, reclaiming the slot emits `peer_joined` with the same index.

```js
ws.onclose = (event) => {
  if (event.code === 4000) return; // replaced by a newer connection — don't reconnect
  // ...your reconnect logic
};
```

### Message flow

```mermaid
sequenceDiagram
    participant H as Host
    participant S as Server
    participant G as Guest

    Note over H,G: Create a room
    H->>S: { type: "create", clientId: "host-secret", maxClients: 4 }
    S->>H: { type: "created", room: "Mu5h6Z", instance: "00bb33ff", region: "fra", index: 0 }

    Note over H,G: Join a room
    G->>S: { type: "join", clientId: "guest-secret", room: "Mu5h6Z" }
    S->>G: { type: "joined", room: "Mu5h6Z", index: 1, peers: [0] }
    S->>H: { type: "peer_joined", index: 1 }

    Note over H,G: Broadcast message (sender excluded)
    H->>S: { type: "send", data: { move: "left" } }
    S->>G: { type: "message", from: 0, data: { move: "left" } }

    Note over H,G: Targeted message
    G->>S: { type: "send", to: 0, data: "hello" }
    S->>H: { type: "message", from: 1, data: "hello" }

    Note over H,G: Disconnect
    G--xS: connection closed
    S->>H: { type: "peer_left", index: 1 }
```

## Protocol reference

All messages are JSON over WebSocket.

### Client → Server

| type | fields | description |
|------|--------|-------------|
| `create` | `clientId`, `maxClients` | Create a new room. Server assigns the 6-char code. `clientId` is the per-slot bearer secret — keep it private. |
| `join` | `clientId`, `room` | Join an existing room. Reusing your prior `clientId` reclaims your slot. |
| `send` | `data`, `to?` | Send to all peers or a specific peer (`to` is a numeric index). |

### Server → Client

| type | fields | description |
|------|--------|-------------|
| `created` | `room`, `instance`, `region`, `index` | Room created. `index` is your slot id (always `0` for the creator). `instance` identifies the holding machine for cross-instance routing; `region` is a label. |
| `joined` | `room`, `index`, `peers[]` | Joined room. `index` is your slot id; `peers` lists the other present slot ids. |
| `peer_joined` | `index` | A new peer joined the room |
| `peer_left` | `index` | A peer disconnected |
| `message` | `from`, `data` | Relayed message from a peer (`from` is the sender's index) |
| `error` | `message` | Error description |

## Docker

```sh
docker build -t party-sockets .
docker run -p 3000:3000 -e PORT=3000 party-sockets
```

## Configuration

| variable | default | description |
|----------|---------|-------------|
| `PORT` | `3000` | TCP port to listen on |
| `INSTANCE_ID` | empty | Machine identifier echoed in the `created` message and `X-Instance-Id` response header |
| `REGION` | empty | Region label echoed in `created` and `/metrics` |
| `DASHBOARD_URL` | none | Where `GET /` redirects. Unset → plaintext `rooms` / `clients` snapshot |

## HTTP API

All HTTP endpoints include `Access-Control-Allow-Origin: *`.

### `GET /health`

Liveness probe.

- **200** — `{ status: "ok" }`

### `GET /room/:code`

Check whether a room exists on this server. The handling machine's ID is returned in the `X-Instance-Id` response header.

- **200** — room found: `{ clients: number, maxClients: number, origin: string }`
- **404** — room not found: `{ error: "Room not found" }`

### `POST /room/:code/leave`

Beacon teardown. Closes the slot owned by `clientId` and broadcasts `peer_left` to the rest of the room. Designed to be called via `navigator.sendBeacon` from a `pagehide` handler — Android Chrome routinely drops the WebSocket close frame on tab close ([crbug 40378664](https://issues.chromium.org/issues/40378664)), so the renderer-independent network-service delivery of `sendBeacon` is what gets the leave to the server.

- Body (form-urlencoded): `clientId=<the slot's bearer secret>`
- **204** — leave processed, slot dropped, or idempotent no-op (room/slot not found, slot already inactive). Does not distinguish, to avoid leaking room/slot existence to scanners.
- **400** — missing or empty `clientId`
- **405** — non-POST method

The replaced WebSocket (if any) is closed with code `4001` reason `"leave"`.

### `GET /metrics`

Prometheus exposition format. Exposes:

- `party_sockets_clients` / `party_sockets_rooms` — live gauges
- `party_sockets_clients_by_origin` / `party_sockets_rooms_by_origin` — same, labeled by origin
- `party_sockets_connections_total` / `party_sockets_rooms_created_total` — since-boot counters per origin
- `party_sockets_origins_tracked` — origins currently tracked (size of internal map; capped at 500 with LRU eviction)
- `process_resident_memory_bytes`, `process_heap_used_bytes`, `process_uptime_seconds` — runtime health

All series are labeled with `instance`, `region`, `version`.

### `GET /` and any other path

**302** to `DASHBOARD_URL` if set; otherwise a plaintext `rooms` / `clients` snapshot for this machine.

## Dashboard

Starter Grafana dashboard at [`ops/grafana-dashboard.json`](ops/grafana-dashboard.json). Import into Grafana with a Prometheus datasource.

## Test

```sh
# Unit tests (in-process, no network)
bun test

# Live tests against a deployed instance
LIVE_URL=https://your-relay.example.com bun run test:live
```

## Fly deployment

On [Fly.io](https://fly.io) the platform-injected env vars unlock cross-instance and cross-region routing. None are required outside Fly.

| variable | role |
|----------|------|
| `FLY_APP_NAME` | Enables DNS-based peer probe and default `DASHBOARD_URL` |
| `FLY_MACHINE_ID` | Fallback for `INSTANCE_ID` |
| `FLY_REGION` | Fallback for `REGION`; enables region-encoded room codes |

### Multi-instance routing

When deployed across multiple machines behind one anycast hostname, the upgrade URL can carry routing hints so connections land on the machine that holds the room:

```js
// Pin to a known instance + room (from a previous `created` response)
new WebSocket("wss://your-relay.fly.dev/Mu5h6Z?instance=00bb33ff");

// Manual code entry: server reads /<code> from the path. Room codes encode
// their home region in the top 5 bits, so the receiving machine fly-replays
// directly to that region. Within the home region, peers probe each other
// over internal DNS to find the machine actually holding the room.
new WebSocket("wss://your-relay.fly.dev/Mu5h6Z");
```

Single-instance deployments can omit both — they're no-ops when no peers exist. Redirects use `fly-replay` headers; swap the helpers in `server.ts` for other platforms.

Stale `?instance=` values (machine replaced or destroyed) fall through to local handling rather than erroring — clients get a clean "Room not found" on join instead of a connection failure.

### Room code region encoding

When `FLY_REGION` is set, the top 5 bits of the room code encode the region index from `regions.ts`, so any peer can route a `/<code>` or `/room/<code>` request directly to the home region. Locally, the full 35-bit space is random and region routing is skipped.

### Dashboard default

When `FLY_APP_NAME` is set, `DASHBOARD_URL` defaults to Fly's hosted Grafana for the app.

### Live tests

`bun run test:live` pulls machine IDs from `flyctl` automatically (requires `fly` CLI and auth). Pass `LIVE_INSTANCES=id1,id2` to override. Multi-machine tests self-skip on single-machine deployments.
