# Party-Sockets

Minimal WebSocket relay server for party games. Clients share rooms and exchange messages — the server just forwards them.

## How it works

- A client **creates** a room (server assigns a 6-char code) with a max client limit
- Other clients **join** by room code
- Clients provide their own UUID — reconnecting with the same UUID replaces the old connection
- Messages can be **broadcast** to all peers or **sent** to a specific client
- `peer_left` is broadcast immediately on disconnect
- Rooms are cleaned up when empty

## Run

```sh
bun run server.ts
# or
PORT=8080 bun run server.ts
```

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

## Usage

### Connect

```js
const ws = new WebSocket("wss://your-relay.example.com");
const clientId = crypto.randomUUID(); // any unique string works
```

### Create a room

```js
ws.send(JSON.stringify({ type: "create", clientId, maxClients: 4 }));
```

The server picks the room code — 6-char base58 (Bitcoin alphabet, no `0`/`O`/`I`/`l`) — and returns it in the `created` response.

### Join a room

```js
ws.send(JSON.stringify({ type: "join", clientId, room: "Mu5h6Z" }));
```

### Send messages

```js
// Broadcast to all peers
ws.send(JSON.stringify({ type: "send", data: { move: "left" } }));

// Send to a specific client
ws.send(JSON.stringify({ type: "send", to: "uuid-of-target", data: "hello" }));
```

### Handle events

```js
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case "created":     // room created, msg.room is the room code
    case "joined":      // joined room, msg.clients is the list of client IDs
    case "peer_joined": // new peer, msg.clientId
    case "peer_left":   // peer disconnected, msg.clientId
    case "message":     // relayed message, msg.from + msg.data
    case "error":       // error, msg.message
  }
};
```

### Reconnect

Joining with the same `clientId` replaces the old connection — no special reconnect message needed. The old WebSocket is closed by the server with code `4000` and reason `"replaced"`, so if you're managing a reconnect loop, treat that close as terminal rather than retrying.

```js
ws.onclose = (event) => {
  if (event.code === 4000) return; // replaced by a newer connection, don't reconnect
  // ...your reconnect logic
};
```

### Message flow

```mermaid
sequenceDiagram
    participant A as Client A
    participant S as Server
    participant B as Client B

    Note over A,B: Create a room
    A->>S: { type: "create", clientId: "aaa", maxClients: 4 }
    S->>A: { type: "created", room: "Mu5h6Z", instance: "00bb33ff", region: "fra" }

    Note over A,B: Join a room
    B->>S: { type: "join", clientId: "bbb", room: "Mu5h6Z" }
    S->>B: { type: "joined", room: "Mu5h6Z", clients: ["aaa", "bbb"] }
    S->>A: { type: "peer_joined", clientId: "bbb" }

    Note over A,B: Broadcast message
    A->>S: { type: "send", data: { move: "left" } }
    S->>B: { type: "message", from: "aaa", data: { move: "left" } }

    Note over A,B: Targeted message
    B->>S: { type: "send", to: "aaa", data: "hello" }
    S->>A: { type: "message", from: "bbb", data: "hello" }

    Note over A,B: Disconnect
    B--xS: connection closed
    S->>A: { type: "peer_left", clientId: "bbb" }
```

## HTTP API

All HTTP endpoints include `Access-Control-Allow-Origin: *`.

### `GET /health`

Liveness probe.

- **200** — `{ status: "ok" }`

### `GET /room/:code`

Check whether a room exists on this server. The handling machine's ID is returned in the `X-Instance-Id` response header.

- **200** — room found: `{ clients: number, maxClients: number, origin: string }`
- **404** — room not found: `{ error: "Room not found" }`

### `GET /metrics`

Prometheus exposition format. Exposes:

- `party_sockets_clients` / `party_sockets_rooms` — live gauges
- `party_sockets_clients_by_origin` / `party_sockets_rooms_by_origin` — same, labeled by origin
- `party_sockets_connections_total` / `party_sockets_rooms_created_total` — since-boot counters per origin
- `party_sockets_origins_tracked` — distinct origins seen since boot (size of internal map)
- `process_resident_memory_bytes`, `process_heap_used_bytes`, `process_uptime_seconds` — runtime health

All series are labeled with `instance`, `region`, `version`.

### `GET /` and any other path

**302** to `DASHBOARD_URL` if set; otherwise a plaintext `rooms` / `clients` snapshot for this machine.

## Dashboard

Starter Grafana dashboard at [`ops/grafana-dashboard.json`](ops/grafana-dashboard.json). Import into Grafana with a Prometheus datasource.

## Protocol reference

All messages are JSON over WebSocket.

### Client → Server

| type | fields | description |
|------|--------|-------------|
| `create` | `clientId`, `maxClients` | Create a new room. Server assigns the 6-char code. |
| `join` | `clientId`, `room` | Join an existing room |
| `send` | `data`, `to?` | Send to all peers or a specific client |

### Server → Client

| type | fields | description |
|------|--------|-------------|
| `created` | `room`, `instance`, `region` | Room created. `instance` identifies the holding machine for cross-instance routing; `region` is a label. |
| `joined` | `room`, `clients[]` | Joined room, list of current client IDs |
| `peer_joined` | `clientId` | A new peer joined the room |
| `peer_left` | `clientId` | A peer disconnected |
| `message` | `from`, `data` | Relayed message from a peer |
| `error` | `message` | Error description |

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
