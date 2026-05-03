# Party-Sockets

Minimal WebSocket relay server for party games. Clients share rooms and exchange messages — the server just forwards them.

## How it works

- A client **creates** a room (server assigns a variable-length code, or uses a preferred code) with a max client limit
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
# or, with a region prefix on all room codes
REGION_CODE=WS PORT=8080 bun run server.ts
```

## Docker

```sh
docker build -t party-sockets .
docker run -p 3000:3000 -e PORT=3000 -e REGION_CODE=WS party-sockets
```

## Usage

### Connect

```js
const ws = new WebSocket("wss://ws.couch-games.com");
const clientId = crypto.randomUUID(); // any unique string works
```

### Create a room

```js
ws.send(JSON.stringify({ type: "create", clientId, maxClients: 4 }));

// Or request a specific room code (e.g. to restore a room after server restart)
ws.send(JSON.stringify({ type: "create", clientId, maxClients: 4, room: "A3KX" }));
```

If the preferred `room` code is a valid A-Z0-9 string (4–8 chars), not already taken, and matches the server's `REGION_CODE` prefix (when set), it will be used. Otherwise the server returns an error.

### Join a room

```js
ws.send(JSON.stringify({ type: "join", clientId, room: "A3KX" }));
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
    S->>A: { type: "created", room: "A3KX" }

    Note over A,B: Join a room
    B->>S: { type: "join", clientId: "bbb", room: "A3KX" }
    S->>B: { type: "joined", room: "A3KX", clients: ["aaa", "bbb"] }
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

Liveness probe and region discovery.

- **200** — `{ status: "ok", regionCode: string }` where `regionCode` is the server's `REGION_CODE` (empty string if unset).

### `GET /room/:code`

Check whether a room exists.

- **200** — room found: `{ clients: number, maxClients: number, origin: string }`
- **404** — room not found: `{ error: "Room not found" }`

## Protocol reference

All messages are JSON over WebSocket.

### Client → Server

| type | fields | description |
|------|--------|-------------|
| `create` | `clientId`, `maxClients`, `room?` | Create a new room. Optional `room` must be A-Z0-9, 4–8 chars, and match the server's `REGION_CODE` prefix (if set). |
| `join` | `clientId`, `room` | Join an existing room |
| `send` | `data`, `to?` | Send to all peers or a specific client |

### Server → Client

| type | fields | description |
|------|--------|-------------|
| `created` | `room` | Room created successfully |
| `joined` | `room`, `clients[]` | Joined room, list of current client IDs |
| `peer_joined` | `clientId` | A new peer joined the room |
| `peer_left` | `clientId` | A peer disconnected |
| `message` | `from`, `data` | Relayed message from a peer |
| `error` | `message` | Error description |

## Test

```sh
bun test
```
