require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const logger = require('./utils/logger');
const UpstreamConnector = require('./services/upstreamConnector');

// Configuration
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Initialize Express
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// -----------------------------------------------------------------------------
// History proxy endpoint
// -----------------------------------------------------------------------------

// In-memory short TTL cache to avoid bursty drawer refreshes
const historyCache = new Map();
const HISTORY_TTL_MS = 30 * 1000;
const historyWatchers = new Map(); // socketId -> { key, timer }
const HISTORY_POLL_MS = 60 * 1000;

const getApiBaseUrl = () => {
  const explicit = process.env.OWLS_INSIGHT_API_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');

  const upstream = process.env.UPSTREAM_WS_URL;
  if (!upstream) return null;

  try {
    const u = new URL(upstream);
    // Convert ws(s) -> http(s) and drop socket path
    const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    const basePath = u.pathname.replace(/\/socket\.io\/?$/, '').replace(/\/$/, '');
    return `${protocol}//${u.host}${basePath}`;
  } catch (e) {
    return null;
  }
};

const marketMap = {
  spread: { market: 'spreads', sides: ['away', 'home'] },
  spreads: { market: 'spreads', sides: ['away', 'home'] },
  total: { market: 'totals', sides: ['over', 'under'] },
  totals: { market: 'totals', sides: ['over', 'under'] },
  moneyline: { market: 'h2h', sides: ['away', 'home'] },
  h2h: { market: 'h2h', sides: ['away', 'home'] },
};

async function fetchCombinedHistory({ eventId, book, market, hours }) {
  const cfg = marketMap[String(market).toLowerCase()];
  if (!cfg) throw new Error('invalid market');

  const apiBase = getApiBaseUrl();
  const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
  if (!apiBase || !apiKey) throw new Error('history proxy not configured');

  const cacheKey = `${eventId}|${book}|${cfg.market}|${hours || ''}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < HISTORY_TTL_MS) {
    return cached.data;
  }

  const buildUrl = (side) => {
    const params = new URLSearchParams({
      eventId: String(eventId),
      book: String(book),
      market: cfg.market,
      side,
    });
    if (hours) params.set('hours', String(hours));
    return `${apiBase}/api/odds/history?${params.toString()}`;
  };

  const [sideA, sideB] = cfg.sides;
  const [respA, respB] = await Promise.all([
    fetch(buildUrl(sideA), { headers: { 'Authorization': `Bearer ${apiKey}` } }),
    fetch(buildUrl(sideB), { headers: { 'Authorization': `Bearer ${apiKey}` } }),
  ]);

  if (!respA.ok || !respB.ok) {
    const status = `${respA.status}/${respB.status}`;
    throw new Error(`upstream history failed (${status})`);
  }

  const jsonA = await respA.json();
  const jsonB = await respB.json();
  const histA = jsonA?.data?.history || [];
  const histB = jsonB?.data?.history || [];
  const openA = jsonA?.data?.openingLine || null;
  const openB = jsonB?.data?.openingLine || null;

  const mapA = new Map(histA.map(h => [h.timestamp, h]));
  const mapB = new Map(histB.map(h => [h.timestamp, h]));
  const allTs = Array.from(new Set([...mapA.keys(), ...mapB.keys()]))
    .filter(Boolean)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  const rows = allTs.map((ts) => {
    const a = mapA.get(ts);
    const b = mapB.get(ts);
    const timestamp = ts;

    if (cfg.market === 'spreads') {
      return {
        timestamp,
        spreadAwayPoint: a?.point ?? null,
        spreadAwayPrice: a?.price ?? null,
        spreadHomePoint: b?.point ?? null,
        spreadHomePrice: b?.price ?? null,
        value: b?.point ?? a?.point ?? null,
        opening: openB?.point ?? openA?.point ?? null,
      };
    }

    if (cfg.market === 'totals') {
      return {
        timestamp,
        totalOverPoint: a?.point ?? null,
        totalOverPrice: a?.price ?? null,
        totalUnderPoint: b?.point ?? null,
        totalUnderPrice: b?.price ?? null,
        value: a?.point ?? b?.point ?? null,
        opening: openA?.point ?? openB?.point ?? null,
      };
    }

    return {
      timestamp,
      mlAwayPrice: a?.price ?? null,
      mlHomePrice: b?.price ?? null,
      value: b?.price ?? a?.price ?? null,
      opening: openB?.price ?? openA?.price ?? null,
    };
  }).filter(r => r.value != null);

  const data = {
    success: true,
    data: {
      eventId,
      book,
      market: cfg.market,
      sides: cfg.sides,
      openingLines: { [sideA]: openA, [sideB]: openB },
      historyRows: rows,
    },
  };

  historyCache.set(cacheKey, { timestamp: Date.now(), data });
  return data;
}

app.get('/api/history', async (req, res) => {
  const { eventId, book, market, hours } = req.query;
  if (!eventId || !book || !market) {
    return res.status(400).json({ success: false, error: 'eventId, book, market are required' });
  }

  try {
    const data = await fetchCombinedHistory({ eventId, book, market, hours });
    return res.json(data);
  } catch (err) {
    logger.error(`History proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch history' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    connections: io.engine.clientsCount,
    upstreamConnected: upstreamConnector?.isConnected() || false,
  });
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io for downstream clients (Owls Insight frontend)
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
});

// Store latest odds data for new connections
let latestOddsData = null;
let openingLines = {};

// Initialize upstream connector
let upstreamConnector = null;

// Broadcast odds update to all connected clients
function broadcastOddsUpdate(data) {
  try {
    const rawSports = data.sports || data;
    const sportKeys = rawSports && typeof rawSports === 'object' ? Object.keys(rawSports) : [];
    logger.debug(`[Upstream] odds-update received. Sports keys: ${sportKeys.join(', ') || 'none'}`);
    if (rawSports?.nba?.length != null) logger.debug(`[Upstream] nba events: ${rawSports.nba.length}`);
    if (rawSports?.nfl?.length != null) logger.debug(`[Upstream] nfl events: ${rawSports.nfl.length}`);
    if (rawSports?.nhl?.length != null) logger.debug(`[Upstream] nhl events: ${rawSports.nhl.length}`);
    if (rawSports?.ncaab?.length != null) logger.debug(`[Upstream] ncaab events: ${rawSports.ncaab.length}`);
    if (data.openingLines) {
      const openKeys = Object.keys(data.openingLines || {});
      logger.debug(`[Upstream] openingLines present. Keys: ${openKeys.slice(0, 5).join(', ')}${openKeys.length > 5 ? '…' : ''}`);
    }
  } catch (e) {
    logger.warn(`[Upstream] debug log failed: ${e.message}`);
  }

  latestOddsData = data.sports || data;
  if (data.openingLines) {
    openingLines = data.openingLines;
  }

  const payload = {
    sports: latestOddsData,
    openingLines: openingLines,
    timestamp: new Date().toISOString(),
  };

  io.emit('odds-update', payload);
  logger.info(`Broadcasted odds update to ${io.engine.clientsCount} clients`);
}

// Handle downstream client connections (Owls Insight frontend)
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id} (Total: ${io.engine.clientsCount})`);
  logger.debug(`[Downstream] socket connected. query=${JSON.stringify(socket.handshake.query || {})}`);

  // Client wants live history updates for a drawer
  socket.on('watch-history', async (params = {}) => {
    const { eventId, book, market, hours } = params;
    if (!eventId || !book || !market) return;

    const key = `${eventId}|${book}|${market}|${hours || ''}`;
    logger.debug(`[Downstream] ${socket.id} watch-history ${key}`);

    // Clear any existing watcher
    const existing = historyWatchers.get(socket.id);
    if (existing?.timer) clearInterval(existing.timer);

    const sendUpdate = async () => {
      try {
        const data = await fetchCombinedHistory({ eventId, book, market, hours });
        socket.emit('history-update', data);
      } catch (e) {
        socket.emit('history-update', { success: false, error: e.message, data: { eventId, book, market } });
      }
    };

    await sendUpdate();
    const timer = setInterval(sendUpdate, HISTORY_POLL_MS);
    historyWatchers.set(socket.id, { key, timer });
  });

  socket.on('unwatch-history', () => {
    const existing = historyWatchers.get(socket.id);
    if (existing?.timer) clearInterval(existing.timer);
    historyWatchers.delete(socket.id);
    logger.debug(`[Downstream] ${socket.id} unwatch-history`);
  });

  // Send latest data immediately on connect
  if (latestOddsData) {
    logger.debug(`[Downstream] sending cached odds to ${socket.id}`);
    socket.emit('odds-update', {
      sports: latestOddsData,
      openingLines: openingLines,
      timestamp: new Date().toISOString(),
    });
    logger.debug(`Sent cached odds to new client: ${socket.id}`);
  }

  // Handle manual refresh request from client
  socket.on('request-odds', () => {
    logger.debug(`Client ${socket.id} requested odds refresh`);
    if (latestOddsData) {
      logger.debug(`[Downstream] re-sending cached odds to ${socket.id}`);
      socket.emit('odds-update', {
        sports: latestOddsData,
        openingLines: openingLines,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle client disconnect
  socket.on('disconnect', (reason) => {
    const existing = historyWatchers.get(socket.id);
    if (existing?.timer) clearInterval(existing.timer);
    historyWatchers.delete(socket.id);
    logger.info(`Client disconnected: ${socket.id} (Reason: ${reason}, Remaining: ${io.engine.clientsCount})`);
  });
});

// Start the server
server.listen(PORT, () => {
  logger.info('='.repeat(50));
  logger.info('OWLS INSIGHT SERVER');
  logger.info('='.repeat(50));
  logger.info(`Server running on port ${PORT}`);
  logger.info(`CORS Origin: ${CORS_ORIGIN}`);
  logger.info('='.repeat(50));

  // Initialize upstream WebSocket connection
  // TODO: Configure UPSTREAM_WS_URL and OWLS_INSIGHT_SERVER_API_KEY in .env
  // TODO: Create the connection to the upstream odds provider server
  upstreamConnector = new UpstreamConnector({
    onOddsUpdate: broadcastOddsUpdate,
    onConnect: () => logger.info('Upstream connected'),
    onDisconnect: (reason) => logger.warn(`Upstream disconnected: ${reason}`),
    onError: (error) => logger.error(`Upstream error: ${error.message}`),
  });

  upstreamConnector.connect();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  if (upstreamConnector) {
    upstreamConnector.disconnect();
  }
  io.close(() => {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  if (upstreamConnector) {
    upstreamConnector.disconnect();
  }
  io.close(() => {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });
});

module.exports = { app, io };
