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

- **src/index.js** - Main entry point. Sets up Express server, Socket.io for clients, initializes upstream connector, manages cached odds data (`latestOddsData`, `openingLines`), history proxy with caching, and handles graceful shutdown.

- **src/services/upstreamConnector.js** - Socket.io client that connects to the upstream odds provider. Handles authentication (API key via auth object, query params, and headers), reconnection logic, and event subscriptions. On connect, subscribes to sports: `['nba', 'ncaab', 'nfl', 'nhl']` and books: `['pinnacle', 'fanduel', 'draftkings', 'betmgm', 'bet365']`.

- **src/services/dataTransformer.js** - Normalizes upstream data to Owls Insight format. Handles multiple input formats including The Odds API format (array of events) and pre-formatted sports objects. Output structure: `{ sports: { nba: [], nfl: [], nhl: [], ncaab: [] }, openingLines: {} }`

- **src/utils/logger.js** - Winston logger with console output. In production, adds file transports (`logs/error.log`, `logs/combined.log`). Log level controlled by `LOG_LEVEL` env var.

### Data Flow

1. Upstream sends odds via configured event name (default: `odds-update`)
2. `UpstreamConnector` receives and passes to `transformUpstreamData()`
3. `broadcastOddsUpdate()` caches data and emits to all connected clients
4. New clients receive cached data immediately on connection

### Client Events (Socket.io)

- `odds-update` (server→client): Broadcast odds data
- `request-odds` (client→server): Request latest cached odds
- `watch-history` (client→server): Subscribe to live history updates for a specific event/book/market
- `unwatch-history` (client→server): Unsubscribe from history updates
- `history-update` (server→client): Push history data to subscribed clients (polls every 60s)

### REST Endpoints

- `GET /health` - Health check with uptime, connections count, upstream status
- `GET /api/history?eventId=&book=&market=&hours=` - Proxy to fetch odds history from upstream API

### Environment Variables

Required:
- `UPSTREAM_WS_URL` - WebSocket URL of upstream odds provider
- `OWLS_INSIGHT_SERVER_API_KEY` - API key for upstream authentication

Optional:
- `PORT` (default: 3001) - Server port
- `CORS_ORIGIN` (default: `*`) - CORS allowed origins
- `LOG_LEVEL` (default: `info`) - Winston log level
- `UPSTREAM_WS_PATH` (default: `/socket.io`) - Socket.io path on upstream
- `UPSTREAM_EVENT_NAME` (default: `odds-update`) - Event name for odds data
- `UPSTREAM_ADDITIONAL_EVENTS` - Comma-separated additional event names to listen for
- `UPSTREAM_MAX_RECONNECTS` (default: 10) - Max reconnection attempts
- `UPSTREAM_RECONNECT_DELAY` (default: 5000) - Delay between reconnects in ms
- `OWLS_INSIGHT_API_BASE_URL` - Override base URL for history API (derived from `UPSTREAM_WS_URL` if not set)
