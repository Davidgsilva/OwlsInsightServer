# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Development server with hot reload (nodemon)
npm start            # Production server
```

No test framework is currently configured.

## Architecture

Owls Insight Server is a WebSocket proxy that sits between an upstream odds provider and multiple frontend clients. It receives real-time odds data from a single upstream source and broadcasts it to all connected Owls Insight UI clients.

```
Upstream Odds Provider (WebSocket)
        │
        ▼
   UpstreamConnector (socket.io-client)
        │
        ▼
   Data Transformer (normalize formats)
        │
        ▼
   Express + Socket.io Server
        │
        ▼
   N × Frontend Clients
```

### Key Components

- **src/index.js** - Main entry point. Sets up Express server, Socket.io for clients, initializes upstream connector, manages cached odds data (`latestOddsData`, `openingLines`), and handles graceful shutdown.

- **src/services/upstreamConnector.js** - Socket.io client that connects to the upstream odds provider. Handles authentication (API key via auth object and query params), reconnection logic, and event subscriptions. Requires `UPSTREAM_WS_URL` and `OWLS_INSIGHT_SERVER_API_KEY` env vars.

- **src/services/dataTransformer.js** - Normalizes upstream data to Owls Insight format. Handles multiple input formats including The Odds API format (array of events) and pre-formatted sports objects. Output structure: `{ sports: { nba: [], nfl: [], nhl: [], ncaab: [] }, openingLines: {} }`

- **src/utils/logger.js** - Winston logger with console output. In production, adds file transports (`logs/error.log`, `logs/combined.log`). Log level controlled by `LOG_LEVEL` env var.

### Data Flow

1. Upstream sends odds via configured event name (default: `odds-update`)
2. `UpstreamConnector` receives and passes to `transformUpstreamData()`
3. `broadcastOddsUpdate()` caches data and emits to all connected clients
4. New clients receive cached data immediately on connection

### Client Events

- `odds-update` (server→client): Broadcast odds data
- `request-odds` (client→server): Request latest cached odds
