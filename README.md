# Owls Insight Server

WebSocket proxy server for Owls Insight - real-time odds aggregation.

## Architecture

```
Upstream Odds Provider (WebSocket)
        │
        ▼
┌─────────────────────────┐
│  Owls Insight Server    │  ← This server
│  (WebSocket Proxy)      │
└───────────┬─────────────┘
            │
            ▼
   N × Frontend Clients
   (Owls Insight UI)
```

## Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Configure .env with upstream connection details
# - UPSTREAM_WS_URL
# - OWLS_INSIGHT_SERVER_API_KEY

# Start server
npm run dev   # Development (with nodemon)
npm start     # Production
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3001) |
| `CORS_ORIGIN` | Allowed origins (default: *) |
| `UPSTREAM_WS_URL` | Upstream odds provider WebSocket URL |
| `OWLS_INSIGHT_SERVER_API_KEY` | API key for upstream authentication |
| `UPSTREAM_EVENT_NAME` | Event name for odds updates (default: odds-update) |

## Endpoints

- `GET /health` - Health check with connection status
- `WebSocket /socket.io` - Client connections

## Client Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `odds-update` | Server → Client | Odds data broadcast |
| `request-odds` | Client → Server | Request latest odds |
