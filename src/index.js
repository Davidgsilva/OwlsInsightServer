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
// socketId -> Map<key, { timer }>
const historyWatchers = new Map();
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
  const urlA = buildUrl(sideA);
  const urlB = buildUrl(sideB);
  const [respA, respB] = await Promise.all([
    fetch(urlA, { headers: { 'Authorization': `Bearer ${apiKey}` } }),
    fetch(urlB, { headers: { 'Authorization': `Bearer ${apiKey}` } }),
  ]);

  if (!respA.ok || !respB.ok) {
    if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
      const [bodyA, bodyB] = await Promise.all([
        respA.ok ? Promise.resolve('') : respA.text().catch(() => ''),
        respB.ok ? Promise.resolve('') : respB.text().catch(() => ''),
      ]);
      // eslint-disable-next-line no-console
      console.log('[DEBUG_OWLS_INSIGHT] history fetch failed', {
        eventId,
        market: cfg.market,
        book,
        urlA,
        urlB,
        statusA: respA.status,
        statusB: respB.status,
        bodyA: bodyA ? bodyA.slice(0, 300) : '',
        bodyB: bodyB ? bodyB.slice(0, 300) : '',
      });
    }
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

function clearSocketWatchers(socketId) {
  const watchers = historyWatchers.get(socketId);
  if (!watchers) return;
  for (const entry of watchers.values()) {
    if (entry?.timer) clearInterval(entry.timer);
  }
  historyWatchers.delete(socketId);
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

// -----------------------------------------------------------------------------
// Live Scores proxy endpoints
// -----------------------------------------------------------------------------
const SCORES_CACHE_TTL_MS = 15 * 1000; // 15 seconds
let scoresCache = { data: null, timestamp: 0 };

async function fetchLiveScoresFromUpstream(sport = null) {
  const apiBase = getApiBaseUrl();
  const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
  if (!apiBase || !apiKey) throw new Error('scores proxy not configured');

  // Check cache first
  if (scoresCache.data && Date.now() - scoresCache.timestamp < SCORES_CACHE_TTL_MS) {
    if (sport) {
      const sportData = scoresCache.data?.data?.sports?.[sport] || [];
      return {
        success: true,
        sport,
        timestamp: scoresCache.data?.data?.timestamp,
        count: sportData.length,
        events: sportData,
        cached: true,
      };
    }
    return { ...scoresCache.data, cached: true };
  }

  // Fetch from upstream
  const url = `${apiBase}/api/v1/scores/live`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    timeout: 10000,
  });

  if (!resp.ok) {
    throw new Error(`upstream scores failed (${resp.status})`);
  }

  const json = await resp.json();
  scoresCache = { data: json, timestamp: Date.now() };

  if (sport) {
    const sportData = json?.data?.sports?.[sport] || [];
    return {
      success: true,
      sport,
      timestamp: json?.data?.timestamp,
      count: sportData.length,
      events: sportData,
      cached: false,
    };
  }

  return { ...json, cached: false };
}

// All sports live scores
app.get('/api/v1/scores/live', async (req, res) => {
  try {
    // First try to return cached data from WebSocket
    if (latestScoresData) {
      return res.json({
        success: true,
        data: latestScoresData,
        cached: true,
      });
    }

    // Fall back to upstream API
    const data = await fetchLiveScoresFromUpstream();
    return res.json(data);
  } catch (err) {
    logger.error(`Scores proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch scores' });
  }
});

// Sport-specific live scores
const VALID_SPORTS = ['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf'];
app.get('/api/v1/:sport/scores/live', async (req, res) => {
  const { sport } = req.params;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  try {
    // First try to return cached data from WebSocket
    if (latestScoresData) {
      const sportData = latestScoresData.sports?.[sport] || [];
      return res.json({
        success: true,
        sport,
        timestamp: latestScoresData.timestamp,
        count: sportData.length,
        events: sportData,
        cached: true,
      });
    }

    // Fall back to upstream API
    const data = await fetchLiveScoresFromUpstream(sport);
    return res.json(data);
  } catch (err) {
    logger.error(`Scores proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch scores' });
  }
});

// Health check endpoint
// Returns 503 if upstream is disconnected so K8s will restart the pod
app.get('/health', (req, res) => {
  const liveGameCount = latestScoresData
    ? Object.values(latestScoresData.sports || {}).flat().length
    : 0;

  const isUpstreamConnected = upstreamConnector?.isConnected() || false;
  const status = isUpstreamConnected ? 'ok' : 'unhealthy';
  const httpStatus = isUpstreamConnected ? 200 : 503;

  res.status(httpStatus).json({
    status,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    connections: io.engine.clientsCount,
    upstreamConnected: isUpstreamConnected,
    liveGames: liveGameCount,
    hasOddsData: !!latestOddsData,
    hasScoresData: !!latestScoresData,
  });
});

// Internal endpoint for connection tracking (used by rainbow deployments)
app.get('/internal/connections', (req, res) => {
  res.json({
    pod: process.env.HOSTNAME || 'unknown',
    version: process.env.APP_VERSION || 'unknown',
    connections: io.engine.clientsCount,
    timestamp: new Date().toISOString(),
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

// Store latest live scores data for new connections
let latestScoresData = null;

// Initialize upstream connector
let upstreamConnector = null;

// -----------------------------------------------------------------------------
// Live score merge helpers
// -----------------------------------------------------------------------------

function normalizeTeamKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getEventKey(event) {
  return event?.eventId || event?.id || event?.event_id || event?.eventID || null;
}

function getHomeAwayNames(event) {
  return {
    home: event?.home_team || event?.homeTeam || event?.home?.name || event?.home?.team || null,
    away: event?.away_team || event?.awayTeam || event?.away?.name || event?.away?.team || null,
  };
}

function getHomeAwayScores(event) {
  const rawHome =
    event?.home_score ??
    event?.homeScore ??
    event?.home?.score ??
    event?.score?.home ??
    null;
  const rawAway =
    event?.away_score ??
    event?.awayScore ??
    event?.away?.score ??
    event?.score?.away ??
    null;

  const home = rawHome == null ? null : Number(rawHome);
  const away = rawAway == null ? null : Number(rawAway);

  return {
    home: Number.isFinite(home) ? home : null,
    away: Number.isFinite(away) ? away : null,
  };
}

function buildTeamsKey(away, home) {
  const a = normalizeTeamKey(away);
  const h = normalizeTeamKey(home);
  if (!a || !h) return null;
  return `${a}@${h}`;
}

function buildScoreIndex(scoresData) {
  const byId = new Map();
  const byTeams = new Map();

  if (!scoresData || typeof scoresData !== 'object') return { byId, byTeams };

  const sportBuckets = scoresData.sports || scoresData.data?.sports || {};
  Object.values(sportBuckets).forEach((events) => {
    if (!Array.isArray(events)) return;
    events.forEach((ev) => {
      const id = getEventKey(ev);
      const { home, away } = getHomeAwayNames(ev);
      const scores = getHomeAwayScores(ev);
      const teamsKey = buildTeamsKey(away, home);

      const normalized = {
        id,
        home,
        away,
        home_score: scores.home,
        away_score: scores.away,
        detail: ev?.detail || ev?.status_detail || ev?.statusDetail || null,
        clock: ev?.clock || ev?.displayClock || null,
        period: ev?.period ?? null,
        updatedAt: ev?.timestamp || ev?.updatedAt || ev?.updated_at || null,
      };

      if (id) byId.set(String(id), normalized);
      if (teamsKey) byTeams.set(teamsKey, normalized);
    });
  });

  return { byId, byTeams };
}

function mergeScoresIntoSports(sports, scoresData) {
  if (!sports || typeof sports !== 'object') return sports;
  if (!scoresData || typeof scoresData !== 'object') return sports;

  const { byId, byTeams } = buildScoreIndex(scoresData);
  if (byId.size === 0 && byTeams.size === 0) return sports;

  const next = { ...sports };
  Object.entries(next).forEach(([sportKey, events]) => {
    if (!Array.isArray(events)) return;

    next[sportKey] = events.map((ev) => {
      const id = getEventKey(ev);
      const { home, away } = getHomeAwayNames(ev);
      const matchKey = buildTeamsKey(away, home);

      const score =
        (id && byId.get(String(id))) ||
        (matchKey ? byTeams.get(matchKey) : null) ||
        null;

      if (!score) return ev;
      if (score.home_score == null && score.away_score == null) return ev;

      return {
        ...ev,
        home_score: score.home_score,
        away_score: score.away_score,
        score_clock: score.clock,
        score_period: score.period,
        score_detail: score.detail,
        score_updated_at: score.updatedAt,
      };
    });
  });

  return next;
}

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
    if (rawSports?.ncaaf?.length != null) logger.debug(`[Upstream] ncaaf events: ${rawSports.ncaaf.length}`);
    if (data.openingLines) {
      const openKeys = Object.keys(data.openingLines || {});
      logger.debug(`[Upstream] openingLines present. Keys: ${openKeys.slice(0, 5).join(', ')}${openKeys.length > 5 ? '…' : ''}`);
    }

    if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
      // eslint-disable-next-line no-console
      console.log('[DEBUG_OWLS_INSIGHT] broadcastOddsUpdate sports counts:', {
        nba: rawSports?.nba?.length ?? null,
        ncaab: rawSports?.ncaab?.length ?? null,
        ncaaf: rawSports?.ncaaf?.length ?? null,
        nfl: rawSports?.nfl?.length ?? null,
        nhl: rawSports?.nhl?.length ?? null,
        keys: sportKeys,
      });
    }
  } catch (e) {
    logger.warn(`[Upstream] debug log failed: ${e.message}`);
  }

  // Some upstream payloads may be partial (only a subset of sports).
  // Merge into cached state so the frontend doesn't "lose" a sport between updates.
  const incomingSports = data.sports || data;
  if (incomingSports && typeof incomingSports === 'object' && !Array.isArray(incomingSports)) {
    const prev = (latestOddsData && typeof latestOddsData === 'object' && !Array.isArray(latestOddsData))
      ? latestOddsData
      : {};
    latestOddsData = { ...prev, ...incomingSports };
  } else {
    latestOddsData = incomingSports;
  }

  if (data.openingLines && typeof data.openingLines === 'object') {
    openingLines = { ...(openingLines || {}), ...data.openingLines };
  }

  const sportsWithScores = mergeScoresIntoSports(latestOddsData, latestScoresData);
  const payload = {
    sports: sportsWithScores,
    openingLines: openingLines,
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget debug probe
  debugProbeHistory(payload.sports);

  if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
    const keys = payload.sports && typeof payload.sports === 'object' ? Object.keys(payload.sports) : [];
    // eslint-disable-next-line no-console
    console.log('[DEBUG_OWLS_INSIGHT] payload sports keys after merge:', keys);
    // eslint-disable-next-line no-console
    console.log('[DEBUG_OWLS_INSIGHT] payload counts after merge:', {
      nba: payload.sports?.nba?.length ?? null,
      ncaab: payload.sports?.ncaab?.length ?? null,
      ncaaf: payload.sports?.ncaaf?.length ?? null,
      nfl: payload.sports?.nfl?.length ?? null,
      nhl: payload.sports?.nhl?.length ?? null,
    });
  }

  io.emit('odds-update', payload);
  logger.info(`Broadcasted odds update to ${io.engine.clientsCount} clients`);
}

// Broadcast live scores update to all connected clients
function broadcastScoresUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const liveCounts = {};
    let totalLive = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        liveCounts[sportKey] = games.length;
        totalLive += games.length;
      }
    });

    logger.debug(`[Upstream] scores-update received. Total live: ${totalLive}`, liveCounts);
  } catch (e) {
    logger.warn(`[Upstream] scores debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestScoresData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  io.emit('scores-update', payload);
  logger.info(`Broadcasted scores update to ${io.engine.clientsCount} clients (${Object.values(payload.sports).flat().length} live games)`);
}

// -----------------------------------------------------------------------------
// Optional debug probe: verify history endpoint returns rows for a sample game
// -----------------------------------------------------------------------------
let didHistoryProbe = false;
async function debugProbeHistory(latestSports) {
  if (didHistoryProbe || process.env.DEBUG_OWLS_INSIGHT !== 'true') return;
  if (!latestSports || typeof latestSports !== 'object') return;

  const pick = (key) => Array.isArray(latestSports[key]) && latestSports[key].length > 0 ? latestSports[key][0] : null;
  const sample =
    pick('ncaaf') ||
    pick('nfl') ||
    pick('nba') ||
    pick('nhl') ||
    pick('ncaab');
  if (!sample) return;

  const sampleSport = sample.sport || sample.sport_key || 'unknown';
  const sampleId = sample.eventId || sample.id || sample.event_id;
  if (!sampleId) return;

  didHistoryProbe = true;
  const book = 'pinnacle';
  const market = 'spreads';

  // eslint-disable-next-line no-console
  console.log('[DEBUG_OWLS_INSIGHT] probing history for sample game', {
    sport: sampleSport,
    id: sampleId,
    teams: `${sample.away_team || sample.awayTeam} @ ${sample.home_team || sample.homeTeam}`,
    book,
    market,
  });

  try {
    const resp = await fetchCombinedHistory({ eventId: sampleId, book, market, hours: 24 });
    const rows = resp?.data?.historyRows || [];
    const opening = resp?.data?.openingLines || null;
    // eslint-disable-next-line no-console
    console.log('[DEBUG_OWLS_INSIGHT] history probe result', {
      rows: rows.length,
      firstTs: rows[0]?.timestamp || null,
      lastTs: rows[rows.length - 1]?.timestamp || null,
      openingKeys: opening ? Object.keys(opening) : null,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[DEBUG_OWLS_INSIGHT] history probe error:', e.message);
  }
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

    // Clear any existing watchers (drawer is single-subscription UX)
    clearSocketWatchers(socket.id);

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
    historyWatchers.set(socket.id, new Map([[key, { timer }]]));
  });

  // Multi-book live history for line movement chart
  socket.on('watch-history-multi', async (params = {}) => {
    const { eventId, books, market, hours } = params;
    if (!eventId || !Array.isArray(books) || books.length === 0 || !market) return;

    const uniqBooks = Array.from(new Set(books.map((b) => String(b).trim()).filter(Boolean))).sort();
    const key = `${eventId}|multi|${uniqBooks.join(',')}|${market}|${hours || ''}`;
    logger.debug(`[Downstream] ${socket.id} watch-history-multi ${key}`);

    // Clear any existing watchers (drawer is single-subscription UX)
    clearSocketWatchers(socket.id);

    const sendUpdate = async () => {
      const settled = await Promise.allSettled(
        uniqBooks.map((book) => fetchCombinedHistory({ eventId, book, market, hours }))
      );

      const byBook = {};
      const errors = {};
      settled.forEach((result, idx) => {
        const book = uniqBooks[idx];
        if (result.status === 'fulfilled' && result.value?.success) {
          byBook[book] = result.value.data;
        } else {
          errors[book] = result.status === 'rejected'
            ? result.reason?.message || 'failed'
            : result.value?.error || 'failed';
        }
      });

      socket.emit('history-multi-update', {
        success: true,
        data: {
          eventId,
          market,
          hours: hours || null,
          books: uniqBooks,
          byBook,
          errors: Object.keys(errors).length > 0 ? errors : undefined,
        },
      });
    };

    await sendUpdate();
    const timer = setInterval(sendUpdate, HISTORY_POLL_MS);
    historyWatchers.set(socket.id, new Map([[key, { timer }]]));
  });

  socket.on('unwatch-history', () => {
    clearSocketWatchers(socket.id);
    logger.debug(`[Downstream] ${socket.id} unwatch-history`);
  });

  // Send latest data immediately on connect
  if (latestOddsData) {
    logger.debug(`[Downstream] sending cached odds to ${socket.id}`);
    if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
      const keys = latestOddsData && typeof latestOddsData === 'object' ? Object.keys(latestOddsData) : [];
      // eslint-disable-next-line no-console
      console.log('[DEBUG_OWLS_INSIGHT] sending cached odds on connect. keys:', keys);
    }
    socket.emit('odds-update', {
      sports: mergeScoresIntoSports(latestOddsData, latestScoresData),
      openingLines: openingLines,
      timestamp: new Date().toISOString(),
    });
    logger.debug(`Sent cached odds to new client: ${socket.id}`);
  }

  // Send latest live scores immediately on connect
  if (latestScoresData) {
    logger.debug(`[Downstream] sending cached scores to ${socket.id}`);
    socket.emit('scores-update', {
      sports: latestScoresData.sports || {},
      timestamp: latestScoresData.timestamp || new Date().toISOString(),
    });
    logger.debug(`Sent cached scores to new client: ${socket.id}`);
  }

  // Handle manual refresh request from client
  socket.on('request-odds', () => {
    logger.debug(`Client ${socket.id} requested odds refresh`);
    if (latestOddsData) {
      logger.debug(`[Downstream] re-sending cached odds to ${socket.id}`);
      socket.emit('odds-update', {
        sports: mergeScoresIntoSports(latestOddsData, latestScoresData),
        openingLines: openingLines,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle manual scores refresh request from client
  socket.on('request-scores', () => {
    logger.debug(`Client ${socket.id} requested scores refresh`);
    if (latestScoresData) {
      logger.debug(`[Downstream] re-sending cached scores to ${socket.id}`);
      socket.emit('scores-update', {
        sports: latestScoresData.sports || {},
        timestamp: latestScoresData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle client disconnect
  socket.on('disconnect', (reason) => {
    clearSocketWatchers(socket.id);
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
    onScoresUpdate: broadcastScoresUpdate,
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
