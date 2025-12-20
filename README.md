# Owls Insight Server

WebSocket proxy for real-time odds data.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your API key
npm run dev
```

## Configuration

Edit `.env`:

```
UPSTREAM_WS_URL=https://ws.owlsinsight.com
OWLS_INSIGHT_SERVER_API_KEY=your_api_key_here
PORT=3001
```

## Verify

Server running:
```
[info] OWLS INSIGHT SERVER
[info] Server running on port 3001
[info] Connected to upstream WebSocket server
```

Health check: `http://localhost:3001/health`
