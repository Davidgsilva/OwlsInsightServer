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
   Live Score Merger (merge scores into odds)
        │
        ▼
   Express + Socket.io Server
        │
        ▼
   N × Frontend Clients
```

### Key Components

- **src/index.js** - Main entry point. Sets up Express server, Socket.io for clients, initializes upstream connector, manages cached data (`latestOddsData`, `latestScoresData`, `latestPropsData`, `latestBet365PropsData`, `latestFanDuelPropsData`, `latestDraftKingsPropsData`, `openingLines`), REST API proxies with caching, live score merging, and handles graceful shutdown.

- **src/services/upstreamConnector.js** - Socket.io client that connects to the upstream odds provider. Handles authentication (API key via auth object, query params, and headers), reconnection logic, and event subscriptions. On connect, subscribes to sports: `['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf']` and books: `['pinnacle', 'fanduel', 'draftkings', 'betmgm', 'bet365', 'caesars']`. Also subscribes to player props from Pinnacle, Bet365, FanDuel, and DraftKings.

- **src/services/dataTransformer.js** - Normalizes upstream data to Owls Insight format. Handles multiple input formats including The Odds API format (array of events) and pre-formatted sports objects. Calculates average odds across bookmakers. Output structure: `{ sports: { nba: [], nfl: [], nhl: [], ncaab: [], ncaaf: [] }, openingLines: {} }`

- **src/utils/logger.js** - Winston logger with console output. In production, adds file transports (`logs/error.log`, `logs/combined.log`). Log level controlled by `LOG_LEVEL` env var.

### Data Flow

1. Upstream sends odds via configured event name (default: `odds-update`)
2. `UpstreamConnector` receives and passes to `transformUpstreamData()`
3. Live scores are merged into odds data via `mergeScoresIntoSports()`
4. `broadcastOddsUpdate()` caches data and emits to all connected clients
5. New clients receive cached data immediately on connection

### Live Score Merging

The server merges live scores into odds data before broadcasting. Score matching uses:
1. Exact event ID match
2. Normalized team name match (`away@home` key)
3. Fuzzy prefix matching for partial team names (e.g., "Delaware" vs "Delaware Blue Hens")

Team name aliases are defined in `TEAM_ALIASES` (e.g., `usc` → `southerncalifornia`, `stpeters` → `saintpeters`).

### Client Events (Socket.io)

**Server → Client:**
- `odds-update` - Broadcast odds data with merged scores
- `scores-update` - Broadcast live scores separately
- `player-props-update` - Broadcast Pinnacle player props data
- `bet365-props-update` - Broadcast Bet365 player props data
- `fanduel-props-update` - Broadcast FanDuel player props data
- `draftkings-props-update` - Broadcast DraftKings player props data
- `history-update` - Push history data for single-book subscription
- `history-multi-update` - Push history data for multi-book subscription

**Client → Server:**
- `request-odds` - Request latest cached odds
- `request-scores` - Request latest cached scores
- `request-props` - Request latest cached Pinnacle props
- `request-bet365-props` - Request latest cached Bet365 props
- `request-fanduel-props` - Request latest cached FanDuel props
- `request-draftkings-props` - Request latest cached DraftKings props
- `watch-history` - Subscribe to history updates for a specific event/book/market
- `watch-history-multi` - Subscribe to multi-book history updates for line movement charts
- `unwatch-history` - Unsubscribe from history updates

### REST Endpoints

**Health & Internal:**
- `GET /health` - Health check (returns 503 if upstream disconnected for K8s restart)
- `GET /internal/connections` - Connection count for rainbow deployments

**History:**
- `GET /api/history?eventId=&book=&market=&hours=` - Combined history (both sides)

**Live Scores:**
- `GET /api/v1/scores/live` - All sports live scores
- `GET /api/v1/:sport/scores/live` - Sport-specific live scores

**Odds:**
- `GET /api/v1/:sport/odds?eventId=&books=` - All odds for a sport (from cached WebSocket data)
- `GET /api/v1/:sport/moneyline?eventId=&books=` - Moneyline (h2h) only
- `GET /api/v1/:sport/spreads?eventId=&books=` - Spreads only
- `GET /api/v1/:sport/totals?eventId=&books=` - Totals only

**Player Props:**
- `GET /api/v1/:sport/props` - Pinnacle player props (cached from WebSocket)
- `GET /api/v1/:sport/props/bet365` - Bet365 player props (cached from WebSocket, falls back to upstream)
- `GET /api/v1/:sport/props/fanduel` - FanDuel player props (cached from WebSocket, falls back to upstream)
- `GET /api/v1/:sport/props/draftkings` - DraftKings player props (cached from WebSocket, falls back to upstream)
- `GET /api/v1/:sport/props/history?player=&category=&prop_type=&hours=&book=` - Props history
- `GET /api/v1/props/bet365/stats` - Bet365 props statistics
- `GET /api/v1/props/fanduel/stats` - FanDuel props statistics

**EV & Arbitrage:**
- `GET /api/v1/:sport/ev?eventId=&books=&min_ev=` - Expected value data
- `GET /api/odds/ev/history?eventId=&book=&market=&side=&hours=` - EV history
- `GET /api/v1/:sport/arbitrage?min_profit=` - Arbitrage opportunities

**Analytics:**
- `GET /api/odds/analytics?eventId=&book=&market=&hours=&granularity=` - Odds analytics

Valid sports for REST endpoints: `nba`, `ncaab`, `nfl`, `nhl`, `ncaaf`

### Environment Variables

Required:
- `UPSTREAM_WS_URL` - WebSocket URL of upstream odds provider
- `OWLS_INSIGHT_SERVER_API_KEY` - API key for upstream authentication

Optional:
- `PORT` (default: 3002) - Server port
- `CORS_ORIGIN` (default: `*`) - CORS allowed origins
- `LOG_LEVEL` (default: `info`) - Winston log level
- `UPSTREAM_WS_PATH` (default: `/socket.io`) - Socket.io path on upstream
- `UPSTREAM_EVENT_NAME` (default: `odds-update`) - Event name for odds data
- `UPSTREAM_ADDITIONAL_EVENTS` - Comma-separated additional event names to listen for
- `UPSTREAM_MAX_RECONNECTS` (default: 10) - Max reconnection attempts
- `UPSTREAM_RECONNECT_DELAY` (default: 5000) - Delay between reconnects in ms
- `OWLS_INSIGHT_API_BASE_URL` - Override base URL for history API (derived from `UPSTREAM_WS_URL` if not set)
- `DEBUG_OWLS_INSIGHT` (default: false) - Set to `true` for verbose debug logging of data flow

## Production Ingress Ownership (CRITICAL)

**This repo manages the ONLY production ingress for ws.owlsinsight.com.**

The ingress `owls-insight-server-ingress` in `k8s/ingress.yaml` routes external traffic to this proxy server, which then connects to the API server internally.

### Two Repos, Two Ingress Files

| Repo | File | Ingress Name | Purpose |
|------|------|--------------|---------|
| **OwlsInsightServer** (this repo) | `k8s/ingress.yaml` | `owls-insight-server-ingress` | PRODUCTION - ws.owlsinsight.com |
| nba-odds-app | `k8s/base/ingress.yaml` | `owls-insight-ingress` | INTERNAL ONLY - NOT for production |

### Traffic Flow

```
Frontend (no auth required)
    |
    v
ws.owlsinsight.com (DNS -> ALB)
    |
    v
owls-insight-server-ingress (this repo's ingress)
    |
    v
owls-insight-server (this repo's proxy - has API key)
    |
    v
owls-insight-api-server (nba-odds-app - requires auth)
```

### After any changes to k8s/ingress.yaml

```bash
kubectl apply -f k8s/ingress.yaml -n owls-insight-dev
kubectl get ingress -n owls-insight-dev  # Verify owls-insight-server-ingress exists
curl -s https://ws.owlsinsight.com/health  # Verify health check passes
```

### If ingress gets misconfigured

The nba-odds-app repo has a validation script:
```bash
cd ~/Projects/WiseSportsServices/nba-odds-app
./scripts/validate-ingress.sh
```

To restore correct ingress:
```bash
cd ~/Projects/WiseSportsServices/OwlsInsightServer
kubectl apply -f k8s/ingress.yaml -n owls-insight-dev
```
