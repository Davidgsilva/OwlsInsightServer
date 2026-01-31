require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const logger = require('./utils/logger');
const UpstreamConnector = require('./services/upstreamConnector');

// Configuration
const PORT = process.env.PORT || 3002;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Initialize Express
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// -----------------------------------------------------------------------------
// API Key Authentication Helpers
// -----------------------------------------------------------------------------

/**
 * Extract API key from Authorization header
 * Supports both "Bearer <key>" and just "<key>"
 */
function extractApiKey(authHeader) {
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
}

/**
 * Authentication middleware - validates client API key via upstream
 * Returns validation result with tier and limits info
 */
async function validateClientApiKey(req) {
  const clientApiKey = extractApiKey(req.headers.authorization);

  if (!clientApiKey) {
    return { valid: false, status: 401, error: 'API key required' };
  }

  // Call upstream to validate the key
  const apiBase = getApiBaseUrl();
  const proxyApiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;

  if (!apiBase || !proxyApiKey) {
    return { valid: false, status: 502, error: 'Proxy not configured' };
  }

  try {
    const resp = await fetch(`${apiBase}/api/internal/validate-key`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${proxyApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey: clientApiKey }),
    });

    if (!resp.ok) {
      return { valid: false, status: resp.status, error: 'Authentication failed' };
    }

    const validation = await resp.json();

    if (!validation.valid) {
      return { valid: false, status: 401, error: validation.error || 'Invalid API key' };
    }

    return {
      valid: true,
      userId: validation.userId,
      tier: validation.tier,
      limits: validation.limits,
      clientApiKey,
    };
  } catch (err) {
    logger.error(`API key validation error: ${err.message}`);
    return { valid: false, status: 500, error: 'Authentication service unavailable' };
  }
}

/**
 * Check if the tier is allowed to access props endpoints
 */
function canAccessProps(tier) {
  return tier === 'rookie' || tier === 'mvp';
}

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
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

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

// Single-side history endpoint - proxies to upstream API server
// This matches the nba-odds-app /api/odds/history endpoint format
app.get('/api/odds/history', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const { eventId, book, market, side, hours } = req.query;
  if (!eventId || !book || !market || !side) {
    return res.status(400).json({ success: false, error: 'eventId, book, market, side are required' });
  }

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'history proxy not configured' });
    }

    const params = new URLSearchParams({
      eventId: String(eventId),
      book: String(book),
      market: String(market),
      side: String(side),
    });
    if (hours) params.set('hours', String(hours));

    const url = `${apiBase}/api/odds/history?${params.toString()}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.error(`Odds history proxy failed: ${resp.status} - ${body.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream returned ${resp.status}` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Odds history proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch odds history' });
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
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

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
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

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

// -----------------------------------------------------------------------------
// Odds REST endpoints (return cached WebSocket data)
// -----------------------------------------------------------------------------

// Helper to filter bookmaker markets
function filterBookmakerMarkets(bookmakers, marketKey) {
  if (!Array.isArray(bookmakers)) return [];
  return bookmakers.map(b => ({
    ...b,
    markets: (b.markets || []).filter(m => m.key === marketKey)
  })).filter(b => b.markets.length > 0);
}

// All odds for a sport (from WebSocket cache)
app.get('/api/v1/:sport/odds', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const { sport } = req.params;
  const { eventId, books } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  // Return cached data from WebSocket
  if (latestOddsData) {
    let sportData = latestOddsData[sport] || [];

    // Filter by eventId if provided
    if (eventId) {
      sportData = sportData.filter(g =>
        g.eventId === eventId || g.id === eventId || g.event_id === eventId
      );
    }

    // Filter by books if provided
    if (books) {
      const bookList = books.split(',').map(b => b.trim().toLowerCase());
      sportData = sportData.map(g => ({
        ...g,
        bookmakers: (g.bookmakers || []).filter(b =>
          bookList.includes((b.key || '').toLowerCase())
        )
      }));
    }

    return res.json({
      success: true,
      data: sportData,
      meta: {
        sport,
        count: sportData.length,
        timestamp: new Date().toISOString(),
        cached: true,
      }
    });
  }

  // Fall back to upstream API
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'odds proxy not configured' });
    }

    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (books) params.append('books', books);

    const url = `${apiBase}/api/v1/${sport}/odds${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Odds proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch odds' });
  }
});

// Moneyline only (h2h market)
app.get('/api/v1/:sport/moneyline', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const { sport } = req.params;
  const { eventId, books } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  if (latestOddsData) {
    let sportData = latestOddsData[sport] || [];

    if (eventId) {
      sportData = sportData.filter(g =>
        g.eventId === eventId || g.id === eventId || g.event_id === eventId
      );
    }

    // Filter to only h2h markets
    sportData = sportData.map(g => ({
      ...g,
      bookmakers: filterBookmakerMarkets(g.bookmakers, 'h2h')
    }));

    if (books) {
      const bookList = books.split(',').map(b => b.trim().toLowerCase());
      sportData = sportData.map(g => ({
        ...g,
        bookmakers: (g.bookmakers || []).filter(b =>
          bookList.includes((b.key || '').toLowerCase())
        )
      }));
    }

    return res.json({
      success: true,
      data: sportData,
      meta: {
        sport,
        market: 'h2h',
        count: sportData.length,
        timestamp: new Date().toISOString(),
        cached: true,
      }
    });
  }

  // Fall back to upstream
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'moneyline proxy not configured' });
    }

    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (books) params.append('books', books);

    const url = `${apiBase}/api/v1/${sport}/moneyline${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Moneyline proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch moneyline' });
  }
});

// Spreads only
app.get('/api/v1/:sport/spreads', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const { sport } = req.params;
  const { eventId, books } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  if (latestOddsData) {
    let sportData = latestOddsData[sport] || [];

    if (eventId) {
      sportData = sportData.filter(g =>
        g.eventId === eventId || g.id === eventId || g.event_id === eventId
      );
    }

    // Filter to only spreads markets
    sportData = sportData.map(g => ({
      ...g,
      bookmakers: filterBookmakerMarkets(g.bookmakers, 'spreads')
    }));

    if (books) {
      const bookList = books.split(',').map(b => b.trim().toLowerCase());
      sportData = sportData.map(g => ({
        ...g,
        bookmakers: (g.bookmakers || []).filter(b =>
          bookList.includes((b.key || '').toLowerCase())
        )
      }));
    }

    return res.json({
      success: true,
      data: sportData,
      meta: {
        sport,
        market: 'spreads',
        count: sportData.length,
        timestamp: new Date().toISOString(),
        cached: true,
      }
    });
  }

  // Fall back to upstream
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'spreads proxy not configured' });
    }

    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (books) params.append('books', books);

    const url = `${apiBase}/api/v1/${sport}/spreads${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Spreads proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch spreads' });
  }
});

// Totals only
app.get('/api/v1/:sport/totals', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const { sport } = req.params;
  const { eventId, books } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  if (latestOddsData) {
    let sportData = latestOddsData[sport] || [];

    if (eventId) {
      sportData = sportData.filter(g =>
        g.eventId === eventId || g.id === eventId || g.event_id === eventId
      );
    }

    // Filter to only totals markets
    sportData = sportData.map(g => ({
      ...g,
      bookmakers: filterBookmakerMarkets(g.bookmakers, 'totals')
    }));

    if (books) {
      const bookList = books.split(',').map(b => b.trim().toLowerCase());
      sportData = sportData.map(g => ({
        ...g,
        bookmakers: (g.bookmakers || []).filter(b =>
          bookList.includes((b.key || '').toLowerCase())
        )
      }));
    }

    return res.json({
      success: true,
      data: sportData,
      meta: {
        sport,
        market: 'totals',
        count: sportData.length,
        timestamp: new Date().toISOString(),
        cached: true,
      }
    });
  }

  // Fall back to upstream
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'totals proxy not configured' });
    }

    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (books) params.append('books', books);

    const url = `${apiBase}/api/v1/${sport}/totals${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Totals proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch totals' });
  }
});

// -----------------------------------------------------------------------------
// Player Props proxy endpoints
// -----------------------------------------------------------------------------

// Props proxy - fetches from upstream and caches
// Helper to merge book data from multiple sources into games
// Note: Each source book cache contains games with a single book entry (books[0])
const mergeBookIntoGames = (gamesMap, bookData, sport) => {
  if (!bookData?.sports?.[sport]) return;
  const bookGames = bookData.sports[sport] || [];
  for (const bookGame of bookGames) {
    const book = bookGame.books?.[0];
    if (!book) continue;

    // Find matching game by gameId first (most reliable)
    let matchingGame = gamesMap.get(bookGame.gameId);

    // Fallback: try matching by team names (handles gameId format differences)
    if (!matchingGame && bookGame.homeTeam && bookGame.awayTeam) {
      const teamsKey = `${bookGame.homeTeam}|${bookGame.awayTeam}`;
      matchingGame = Array.from(gamesMap.values()).find(g =>
        `${g.homeTeam}|${g.awayTeam}` === teamsKey
      );
    }

    if (matchingGame) {
      // Ensure books array exists (defensive check)
      matchingGame.books = matchingGame.books || [];
      // Add book to existing game if not already present
      if (!matchingGame.books.some(b => b.key === book.key)) {
        matchingGame.books.push(book);
      }
    } else {
      // Add as new game - deep copy to prevent cache mutation
      gamesMap.set(bookGame.gameId, {
        ...bookGame,
        books: bookGame.books ? bookGame.books.map(b => ({ ...b, props: [...(b.props || [])] })) : []
      });
    }
  }
};

app.get('/api/v1/:sport/props', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { game_id, player, category } = req.query;

  console.log(`[DEBUG Props] GET /api/v1/${sport}/props - query:`, { game_id, player, category });

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  // Build merged props from all cached book data
  const hasCachedData = latestPropsData || latestFanDuelPropsData || latestDraftKingsPropsData ||
                        latestBet365PropsData || latestBetMGMPropsData || latestCaesarsPropsData;

  if (hasCachedData) {
    // Start with Pinnacle data as base
    const gamesMap = new Map();
    const pinnacleGames = latestPropsData?.sports?.[sport] || [];
    for (const game of pinnacleGames) {
      gamesMap.set(game.gameId, { ...game, books: [...(game.books || [])] });
    }

    // Merge in other book data
    mergeBookIntoGames(gamesMap, latestFanDuelPropsData, sport);
    mergeBookIntoGames(gamesMap, latestDraftKingsPropsData, sport);
    mergeBookIntoGames(gamesMap, latestBet365PropsData, sport);
    mergeBookIntoGames(gamesMap, latestBetMGMPropsData, sport);
    mergeBookIntoGames(gamesMap, latestCaesarsPropsData, sport);

    let filteredData = Array.from(gamesMap.values());

    const bookCounts = {};
    filteredData.forEach(g => {
      (g.books || []).forEach(b => {
        bookCounts[b.key] = (bookCounts[b.key] || 0) + (b.props || []).length;
      });
    });
    console.log(`[DEBUG Props] Merged book counts for ${sport}:`, bookCounts);

    // Apply filters if provided
    if (game_id) {
      filteredData = filteredData.filter(g => g.gameId === game_id || g.game_id === game_id);
    }
    if (player) {
      const playerLower = player.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        books: (g.books || []).map(b => ({
          ...b,
          props: (b.props || []).filter(p =>
            (p.playerName || p.player_name || '').toLowerCase().includes(playerLower)
          )
        })).filter(b => b.props.length > 0)
      })).filter(g => g.books.some(b => b.props.length > 0));
    }
    if (category) {
      const catLower = category.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        books: (g.books || []).map(b => ({
          ...b,
          props: (b.props || []).filter(p =>
            (p.category || '').toLowerCase() === catLower
          )
        })).filter(b => b.props.length > 0)
      })).filter(g => g.books.some(b => b.props.length > 0));
    }

    // Count props
    let propsCount = 0;
    filteredData.forEach(g => {
      (g.books || []).forEach(b => {
        propsCount += (b.props || []).length;
      });
    });

    const booksInResponse = new Set();
    filteredData.forEach(g => (g.books || []).forEach(b => booksInResponse.add(b.key)));
    console.log(`[DEBUG Props] Returning ${propsCount} props from ${Array.from(booksInResponse).join(', ')} for ${sport} from ${filteredData.length} games (cached)`);

    return res.json({
      success: true,
      data: filteredData,
      meta: {
        sport,
        timestamp: latestPropsData?.timestamp ||
                   latestDraftKingsPropsData?.timestamp ||
                   latestFanDuelPropsData?.timestamp ||
                   new Date().toISOString(),
        propsReturned: propsCount,
        gamesReturned: filteredData.length,
        cached: true,
        booksIncluded: Array.from(booksInResponse),
      }
    });
  } else {
    console.log(`[DEBUG Props] No cached props data available for ${sport}`);
  }

  // Fall back to upstream API
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'props proxy not configured' });
    }

    const params = new URLSearchParams();
    if (game_id) params.append('game_id', game_id);
    if (player) params.append('player', player);
    if (category) params.append('category', category);

    const url = `${apiBase}/api/v1/${sport}/props${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      console.log(`[DEBUG Props] Upstream failed for ${sport}: ${resp.status}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    console.log(`[DEBUG Props] Upstream response for ${sport}: ${data.data?.length || 0} games, ${data.meta?.propsReturned || 0} props`);
    return res.json(data);
  } catch (err) {
    logger.error(`Props proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch props' });
  }
});

// -----------------------------------------------------------------------------
// Bet365 Player Props proxy endpoints
// -----------------------------------------------------------------------------

// Bet365 Props proxy - uses WebSocket cache first, falls back to upstream
app.get('/api/v1/:sport/props/bet365', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { game_id, player, category } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  // First try to return cached data from WebSocket
  if (latestBet365PropsData) {
    const sportGames = latestBet365PropsData.sports?.[sport] || [];
    let filteredData = [...sportGames];

    // Apply filters if provided
    if (game_id) {
      filteredData = filteredData.filter(g => g.gameId === game_id || g.game_id === game_id);
    }
    if (player) {
      const playerLower = player.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        props: (g.props || []).filter(p =>
          (p.playerName || p.player_name || '').toLowerCase().includes(playerLower)
        )
      })).filter(g => g.props.length > 0);
    }
    if (category) {
      const catLower = category.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        props: (g.props || []).filter(p =>
          (p.category || '').toLowerCase() === catLower
        )
      })).filter(g => g.props.length > 0);
    }

    // Count props
    let propsCount = 0;
    filteredData.forEach(g => {
      propsCount += (g.props || []).length;
    });

    return res.json({
      success: true,
      data: filteredData,
      meta: {
        sport,
        book: 'bet365',
        timestamp: latestBet365PropsData.timestamp,
        propsReturned: propsCount,
        gamesReturned: filteredData.length,
        cached: true,
      }
    });
  }

  // Fall back to upstream API
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'bet365 props proxy not configured' });
    }

    const params = new URLSearchParams();
    if (game_id) params.append('game_id', game_id);
    if (player) params.append('player', player);
    if (category) params.append('category', category);

    const url = `${apiBase}/api/v1/${sport}/props/bet365${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`Bet365 props upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Bet365 props proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch bet365 props' });
  }
});

// Bet365 Props stats endpoint
app.get('/api/v1/props/bet365/stats', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'bet365 stats proxy not configured' });
    }

    const url = `${apiBase}/api/v1/props/bet365/stats`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`Bet365 props stats upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Bet365 props stats proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch bet365 props stats' });
  }
});

// FanDuel Props stats endpoint
app.get('/api/v1/props/fanduel/stats', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'fanduel stats proxy not configured' });
    }

    const url = `${apiBase}/api/v1/props/fanduel/stats`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`FanDuel props stats upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`FanDuel props stats proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch fanduel props stats' });
  }
});

// FanDuel Props proxy - uses WebSocket cache first, falls back to upstream
app.get('/api/v1/:sport/props/fanduel', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { game_id, player, category } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  // First try to return cached data from WebSocket
  if (latestFanDuelPropsData) {
    const sportGames = latestFanDuelPropsData.sports?.[sport] || [];
    let filteredData = [...sportGames];

    // Apply filters if provided
    if (game_id) {
      filteredData = filteredData.filter(g => g.gameId === game_id || g.game_id === game_id);
    }
    if (player) {
      const playerLower = player.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        props: (g.props || []).filter(p =>
          (p.playerName || p.player_name || '').toLowerCase().includes(playerLower)
        )
      })).filter(g => g.props.length > 0);
    }
    if (category) {
      const catLower = category.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        props: (g.props || []).filter(p =>
          (p.category || '').toLowerCase() === catLower
        )
      })).filter(g => g.props.length > 0);
    }

    // Count props
    let propsCount = 0;
    filteredData.forEach(g => {
      propsCount += (g.props || []).length;
    });

    return res.json({
      success: true,
      data: filteredData,
      meta: {
        sport,
        book: 'fanduel',
        timestamp: latestFanDuelPropsData.timestamp,
        propsReturned: propsCount,
        gamesReturned: filteredData.length,
        cached: true,
      }
    });
  }

  // Fall back to upstream API
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'fanduel props proxy not configured' });
    }

    const params = new URLSearchParams();
    if (game_id) params.append('game_id', game_id);
    if (player) params.append('player', player);
    if (category) params.append('category', category);

    const url = `${apiBase}/api/v1/${sport}/props/fanduel${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`FanDuel props upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`FanDuel props proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch fanduel props' });
  }
});

// -----------------------------------------------------------------------------
// DraftKings Player Props proxy endpoints
// -----------------------------------------------------------------------------

// DraftKings Props proxy - uses WebSocket cache first, falls back to upstream
app.get('/api/v1/:sport/props/draftkings', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { game_id, player, category } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  // First try to return cached data from WebSocket
  if (latestDraftKingsPropsData) {
    const sportGames = latestDraftKingsPropsData.sports?.[sport] || [];
    let filteredData = [...sportGames];

    // Apply filters if provided
    if (game_id) {
      filteredData = filteredData.filter(g => g.gameId === game_id || g.game_id === game_id);
    }
    if (player) {
      const playerLower = player.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        props: (g.props || []).filter(p =>
          (p.playerName || p.player_name || '').toLowerCase().includes(playerLower)
        )
      })).filter(g => g.props.length > 0);
    }
    if (category) {
      const catLower = category.toLowerCase();
      filteredData = filteredData.map(g => ({
        ...g,
        props: (g.props || []).filter(p =>
          (p.category || '').toLowerCase() === catLower
        )
      })).filter(g => g.props.length > 0);
    }

    // Count props
    let propsCount = 0;
    filteredData.forEach(g => {
      propsCount += (g.props || []).length;
    });

    return res.json({
      success: true,
      data: filteredData,
      meta: {
        sport,
        book: 'draftkings',
        timestamp: latestDraftKingsPropsData.timestamp,
        propsReturned: propsCount,
        gamesReturned: filteredData.length,
        cached: true,
      }
    });
  }

  // Fall back to upstream API
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'draftkings props proxy not configured' });
    }

    const params = new URLSearchParams();
    if (game_id) params.append('game_id', game_id);
    if (player) params.append('player', player);
    if (category) params.append('category', category);

    const url = `${apiBase}/api/v1/${sport}/props/draftkings${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`DraftKings props upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`DraftKings props proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch draftkings props' });
  }
});

// -----------------------------------------------------------------------------
// Props History proxy endpoint
// -----------------------------------------------------------------------------

// Props history - fetches historical player props from upstream
app.get('/api/v1/:sport/props/history', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Props require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Player props require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { game_id, eventId, player, category, prop_type, hours, book } = req.query;
  const resolvedGameId = game_id || eventId;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'props history proxy not configured' });
    }

    const params = new URLSearchParams();
    if (resolvedGameId) {
      params.append('game_id', resolvedGameId);
      params.append('eventId', resolvedGameId);
    }
    if (player) params.append('player', player);
    if (category) params.append('category', category);
    if (prop_type) params.append('prop_type', prop_type);
    if (hours) params.append('hours', hours);
    if (book) params.append('book', book);

    const url = `${apiBase}/api/v1/${sport}/props/history${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`Props history upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Props history proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch props history' });
  }
});

// -----------------------------------------------------------------------------
// EV (Expected Value) proxy endpoints
// -----------------------------------------------------------------------------

// EV proxy - fetches from upstream and caches
// EV data is included in WebSocket odds broadcasts, so check latestOddsData first
app.get('/api/v1/:sport/ev', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // EV calculations require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'EV calculations require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { eventId, books, min_ev } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  // Fall back to upstream API (EV requires tier validation on backend)
  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'ev proxy not configured' });
    }

    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (books) params.append('books', books);
    if (min_ev) params.append('min_ev', min_ev);

    const url = `${apiBase}/api/v1/${sport}/ev${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`EV upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`EV proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch ev data' });
  }
});

// EV History proxy - fetches historical EV data from upstream
app.get('/api/odds/ev/history', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // EV calculations require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'EV calculations require Rookie or MVP subscription' });
  }

  const { eventId, book, market, side, hours } = req.query;

  // Validate required params
  if (!eventId || !book || !market || !side) {
    return res.status(400).json({
      success: false,
      error: 'eventId, book, market, and side are required',
    });
  }

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'ev history proxy not configured' });
    }

    const params = new URLSearchParams({
      eventId: String(eventId),
      book: String(book),
      market: String(market),
      side: String(side),
    });
    if (hours) params.set('hours', String(hours));

    const url = `${apiBase}/api/odds/ev/history?${params.toString()}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`EV history upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`EV history proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch ev history' });
  }
});

// -----------------------------------------------------------------------------
// Analytics proxy endpoint
// -----------------------------------------------------------------------------

// Analytics - fetches odds analytics from upstream
app.get('/api/odds/analytics', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Analytics require Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Analytics require Rookie or MVP subscription' });
  }

  const { eventId, book, market, hours, granularity } = req.query;

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'analytics proxy not configured' });
    }

    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (book) params.append('book', book);
    if (market) params.append('market', market);
    if (hours) params.append('hours', hours);
    if (granularity) params.append('granularity', granularity);

    const url = `${apiBase}/api/odds/analytics${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`Analytics upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Analytics proxy error: ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch analytics' });
  }
});

// -----------------------------------------------------------------------------
// Coverage Report endpoint
// -----------------------------------------------------------------------------

app.get('/api/v1/coverage', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  const SPORTS = ['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf'];

  // Build odds coverage
  const oddsCoverage = {};
  let totalGames = 0;
  const allOddsBooks = new Set();

  SPORTS.forEach(sport => {
    const games = latestOddsData?.[sport] || [];
    const sportCoverage = { games: games.length, books: {} };
    totalGames += games.length;

    games.forEach(game => {
      (game.bookmakers || []).forEach(book => {
        allOddsBooks.add(book.key);
        if (!sportCoverage.books[book.key]) {
          sportCoverage.books[book.key] = { games: 0, markets: new Set() };
        }
        sportCoverage.books[book.key].games++;
        (book.markets || []).forEach(m => sportCoverage.books[book.key].markets.add(m.key));
      });
    });

    // Convert Sets to arrays
    Object.keys(sportCoverage.books).forEach(bookKey => {
      sportCoverage.books[bookKey].markets = Array.from(sportCoverage.books[bookKey].markets);
    });

    oddsCoverage[sport] = sportCoverage;
  });

  // Build props coverage
  const propsCoverage = {};
  let totalProps = 0;
  const propsBooks = ['pinnacle', 'bet365', 'fanduel', 'draftkings'];

  const propsCaches = {
    pinnacle: latestPropsData,
    bet365: latestBet365PropsData,
    fanduel: latestFanDuelPropsData,
    draftkings: latestDraftKingsPropsData
  };

  SPORTS.forEach(sport => {
    propsCoverage[sport] = {};

    // Pinnacle (nested books structure)
    const pinnacleGames = propsCaches.pinnacle?.sports?.[sport] || [];
    let pinnacleProps = 0;
    pinnacleGames.forEach(g => {
      (g.books || []).forEach(b => { pinnacleProps += (b.props || []).length; });
    });
    propsCoverage[sport].pinnacle = { games: pinnacleGames.length, props: pinnacleProps };
    totalProps += pinnacleProps;

    // Other books (props nested in books[] array)
    ['bet365', 'fanduel', 'draftkings'].forEach(book => {
      const bookGames = propsCaches[book]?.sports?.[sport] || [];
      let bookProps = 0;
      bookGames.forEach(g => {
        // Props may be under game.books[].props or game.props
        if (g.books && Array.isArray(g.books)) {
          g.books.forEach(b => { bookProps += (b.props || []).length; });
        } else if (g.props) {
          bookProps += g.props.length;
        }
      });
      propsCoverage[sport][book] = { games: bookGames.length, props: bookProps };
      totalProps += bookProps;
    });
  });

  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    summary: {
      totalGames,
      totalProps,
      oddsBooks: allOddsBooks.size,
      propsBooks: propsBooks.length
    },
    odds: oddsCoverage,
    props: propsCoverage
  });
});

// -----------------------------------------------------------------------------
// Arbitrage proxy endpoints
// -----------------------------------------------------------------------------

// Arbitrage proxy - fetches from upstream
// Arbitrage data is included in WebSocket odds broadcasts
app.get('/api/v1/:sport/arbitrage', async (req, res) => {
  // Validate client API key
  const auth = await validateClientApiKey(req);
  if (!auth.valid) {
    return res.status(auth.status).json({ success: false, error: auth.error });
  }

  // Arbitrage requires Rookie or MVP tier
  if (!canAccessProps(auth.tier)) {
    return res.status(403).json({ success: false, error: 'Arbitrage calculations require Rookie or MVP subscription' });
  }

  const { sport } = req.params;
  const { min_profit } = req.query;

  if (!VALID_SPORTS.includes(sport)) {
    return res.status(400).json({ success: false, error: `Invalid sport: ${sport}` });
  }

  try {
    const apiBase = getApiBaseUrl();
    const apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;
    if (!apiBase || !apiKey) {
      return res.status(502).json({ success: false, error: 'arbitrage proxy not configured' });
    }

    const params = new URLSearchParams();
    if (min_profit) params.append('min_profit', min_profit);

    const url = `${apiBase}/api/v1/${sport}/arbitrage${params.toString() ? '?' + params.toString() : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      logger.error(`Arbitrage upstream failed: ${resp.status} - ${errorBody.slice(0, 200)}`);
      return res.status(resp.status).json({ success: false, error: `upstream failed (${resp.status})` });
    }

    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    logger.error(`Arbitrage proxy error (${sport}): ${err.message}`);
    return res.status(502).json({ success: false, error: 'failed to fetch arbitrage data' });
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
    hasPropsData: !!latestPropsData,
    hasBet365PropsData: !!latestBet365PropsData,
    hasFanDuelPropsData: !!latestFanDuelPropsData,
    hasDraftKingsPropsData: !!latestDraftKingsPropsData,
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

// Store latest player props data for new connections
let latestPropsData = null;

// Store latest Bet365 player props data for new connections
let latestBet365PropsData = null;

// Store latest FanDuel player props data for new connections
let latestFanDuelPropsData = null;

// Store latest DraftKings player props data for new connections
let latestDraftKingsPropsData = null;

// Track downstream props history requests for targeted responses
const propsHistoryRequests = new Map();
const PROPS_HISTORY_REQUEST_TTL_MS = 30_000;
const MAX_PENDING_PROPS_HISTORY_REQUESTS = 10000;

// Rate limiting for props history requests per socket
const propsHistoryRateLimits = new Map();
const PROPS_HISTORY_RATE_LIMIT_WINDOW_MS = 1000;
const PROPS_HISTORY_MAX_REQUESTS_PER_WINDOW = 10;

setInterval(() => {
  const now = Date.now();
  propsHistoryRequests.forEach((value, key) => {
    if (now - value.createdAt > PROPS_HISTORY_REQUEST_TTL_MS) {
      propsHistoryRequests.delete(key);
    }
  });
}, PROPS_HISTORY_REQUEST_TTL_MS).unref();

// Store latest BetMGM player props data for new connections
let latestBetMGMPropsData = null;

// Store latest Caesars player props data for new connections
let latestCaesarsPropsData = null;

/**
 * Deep merge sports data, preserving bookmaker data across updates.
 * When upstream sends partial updates (missing some bookmakers), we keep
 * the cached bookmaker data rather than losing it.
 * @param {Object} prevSports - Previous cached sports data
 * @param {Object} newSports - Incoming sports data from upstream
 * @returns {Object} - Merged sports data with all bookmakers preserved
 */
function mergeSportsWithBookmakers(prevSports, newSports) {
  if (!prevSports || typeof prevSports !== 'object') return newSports;
  if (!newSports || typeof newSports !== 'object') return prevSports;

  const result = { ...prevSports };

  Object.entries(newSports).forEach(([sportKey, newGames]) => {
    if (!Array.isArray(newGames)) {
      result[sportKey] = newGames;
      return;
    }

    const prevGames = Array.isArray(prevSports[sportKey]) ? prevSports[sportKey] : [];

    // Build index of previous games by eventId for fast lookup
    const prevByEventId = new Map();
    prevGames.forEach(g => {
      const id = g.eventId || g.id;
      if (id) prevByEventId.set(id, g);
    });

    // Merge each new game with its previous version
    result[sportKey] = newGames.map(newGame => {
      const gameId = newGame.eventId || newGame.id;
      const prevGame = gameId ? prevByEventId.get(gameId) : null;

      if (!prevGame) return newGame;

      // Merge bookmakers: keep previous bookmakers not in new data
      const newBookmakers = newGame.bookmakers || [];
      const prevBookmakers = prevGame.bookmakers || [];

      if (newBookmakers.length === 0) {
        // New update has no bookmakers, keep previous
        return { ...newGame, bookmakers: prevBookmakers };
      }

      // Build set of bookmaker keys in new data
      const newBookKeys = new Set(newBookmakers.map(b => b.key));

      // Keep previous bookmakers that aren't in the new data
      const preservedBookmakers = prevBookmakers.filter(b => !newBookKeys.has(b.key));

      // Combine: new bookmakers + preserved previous bookmakers
      const mergedBookmakers = [...newBookmakers, ...preservedBookmakers];

      return { ...newGame, bookmakers: mergedBookmakers };
    });
  });

  return result;
}

// Initialize upstream connector
let upstreamConnector = null;

// -----------------------------------------------------------------------------
// Live score merge helpers
// -----------------------------------------------------------------------------

// Team name alias mapping for NCAAB/NCAAF teams with different names across sources
// Maps normalized aliases to canonical normalized key
const TEAM_ALIASES = {
  // University of Missouri-Kansas City
  umkc: 'kansascity',
  missourikansascity: 'kansascity',
  // Saint/St variations
  stpeters: 'saintpeters',
  stjohns: 'saintjohns',
  stmarys: 'saintmarys',
  stbonaventure: 'saintbonaventure',
  stfrancis: 'saintfrancis',
  stthomas: 'saintthomas',
  stjosephs: 'saintjosephs',
  stlouis: 'saintlouis',
  // USC variations
  usc: 'southerncalifornia',
  southerncal: 'southerncalifornia',
  // UConn variations
  uconn: 'connecticut',
  // SMU variations
  smu: 'southernmethodist',
  // TCU variations
  tcu: 'texaschristian',
  // UCF variations
  ucf: 'centralflorida',
  // LSU variations
  lsu: 'louisianastate',
  // Ole Miss variations
  olemiss: 'mississippi',
  // UNLV variations
  unlv: 'nevadalasvegas',
  // VCU variations
  vcu: 'virginiacommonwealth',
  // UNC variations
  unc: 'northcarolina',
  // Add more aliases as discovered
};

function normalizeTeamKey(name) {
  const normalized = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  // Apply alias mapping if exists
  return TEAM_ALIASES[normalized] || normalized;
}

function getEventKey(event) {
  return event?.eventId || event?.id || event?.event_id || event?.eventID || null;
}

function getHomeAwayNames(event) {
  return {
    home: event?.home_team || event?.homeTeam || event?.home?.name || event?.home?.team?.displayName || null,
    away: event?.away_team || event?.awayTeam || event?.away?.name || event?.away?.team?.displayName || null,
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
  const allScores = []; // For fuzzy matching fallback

  if (!scoresData || typeof scoresData !== 'object') return { byId, byTeams, allScores };

  const sportBuckets = scoresData.sports || scoresData.data?.sports || {};

  // DEBUG: Log raw scores data structure
  if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
    const sportKeys = Object.keys(sportBuckets);
    console.log('[DEBUG_OWLS_INSIGHT] buildScoreIndex - sports:', sportKeys);
    sportKeys.forEach((sport) => {
      const events = sportBuckets[sport];
      if (Array.isArray(events) && events.length > 0) {
        // Log first live event's raw status data
        const liveEvent = events.find((e) => e?.status?.state === 'in' || e?.status === 'live' || e?.status === 'in');
        if (liveEvent) {
          console.log(`[DEBUG_OWLS_INSIGHT] ${sport} LIVE event raw data:`, {
            id: liveEvent.id,
            name: liveEvent.name,
            status: liveEvent.status,
            statusType: typeof liveEvent.status,
            clock: liveEvent.clock,
            displayClock: liveEvent.displayClock,
            period: liveEvent.period,
            home: liveEvent.home,
            away: liveEvent.away,
          });
        }
      }
    });
  }

  Object.entries(sportBuckets).forEach(([sportKey, events]) => {
    if (!Array.isArray(events)) return;
    events.forEach((ev) => {
      const id = getEventKey(ev);
      const { home, away } = getHomeAwayNames(ev);
      const scores = getHomeAwayScores(ev);
      const teamsKey = buildTeamsKey(away, home);

      // Status may be nested in ev.status object from live scores API
      const statusObj = ev?.status && typeof ev.status === 'object' ? ev.status : null;

      const normalized = {
        id,
        home,
        away,
        homeKey: normalizeTeamKey(home),
        awayKey: normalizeTeamKey(away),
        home_score: scores.home,
        away_score: scores.away,
        detail: statusObj?.detail || ev?.detail || ev?.status_detail || ev?.statusDetail || null,
        clock: statusObj?.displayClock || ev?.clock || ev?.displayClock || null,
        period: statusObj?.period ?? ev?.period ?? null,
        updatedAt: ev?.timestamp || ev?.updatedAt || ev?.updated_at || null,
      };

      // DEBUG: Log normalized live events with clock/period
      if (process.env.DEBUG_OWLS_INSIGHT === 'true' && (statusObj?.state === 'in' || ev?.status === 'live')) {
        console.log(`[DEBUG_OWLS_INSIGHT] ${sportKey} normalized live score:`, {
          id: normalized.id,
          teams: `${normalized.away} @ ${normalized.home}`,
          scores: `${normalized.away_score} - ${normalized.home_score}`,
          clock: normalized.clock,
          period: normalized.period,
          detail: normalized.detail,
          rawStatusObj: statusObj,
        });
      }

      if (id) byId.set(String(id), normalized);
      if (teamsKey) byTeams.set(teamsKey, normalized);
      allScores.push(normalized);
    });
  });

  return { byId, byTeams, allScores };
}

// Fuzzy match: check if odds team names are prefixes of (or match) score team names
function fuzzyMatchScore(oddsHome, oddsAway, allScores) {
  const oh = normalizeTeamKey(oddsHome);
  const oa = normalizeTeamKey(oddsAway);
  if (!oh || !oa) return null;

  for (const score of allScores) {
    // Check if odds team names are prefixes of score team names (handles "Delaware" vs "Delaware Blue Hens")
    const homeMatches = score.homeKey.startsWith(oh) || oh.startsWith(score.homeKey);
    const awayMatches = score.awayKey.startsWith(oa) || oa.startsWith(score.awayKey);
    if (homeMatches && awayMatches) {
      return score;
    }

    // Also check if home/away are swapped (sportsbooks sometimes have venue wrong)
    const homeMatchesAway = score.awayKey.startsWith(oh) || oh.startsWith(score.awayKey);
    const awayMatchesHome = score.homeKey.startsWith(oa) || oa.startsWith(score.homeKey);
    if (homeMatchesAway && awayMatchesHome) {
      // Return with scores swapped to match odds home/away
      return {
        ...score,
        home_score: score.away_score,
        away_score: score.home_score,
      };
    }
  }

  // Single-team fallback DISABLED - too many false positives
  // The issue: "E Kentucky @ NC State" was matching "E Kentucky @ Queens" because
  // E Kentucky only appeared once in live scores, but the opponents are completely different.
  // The fuzzy prefix matching above handles legitimate cases like "Delaware" vs "Delaware Blue Hens"
  // where BOTH teams have some overlap.

  if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
    // Log for debugging - which games couldn't be matched
    const awayMatches = allScores.filter(s => s.awayKey.startsWith(oa) || oa.startsWith(s.awayKey));
    const homeMatches = allScores.filter(s => s.homeKey.startsWith(oh) || oh.startsWith(s.homeKey));
    if (awayMatches.length > 0 || homeMatches.length > 0) {
      console.log(`[DEBUG_OWLS_INSIGHT] Partial match rejected (requires both teams): ${oddsAway} @ ${oddsHome}`, {
        awayMatches: awayMatches.map(m => `${m.away} @ ${m.home}`),
        homeMatches: homeMatches.map(m => `${m.away} @ ${m.home}`),
      });
    }
  }

  return null;
}

function mergeScoresIntoSports(sports, scoresData) {
  if (!sports || typeof sports !== 'object') return sports;
  if (!scoresData || typeof scoresData !== 'object') {
    if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
      console.log('[DEBUG_OWLS_INSIGHT] mergeScoresIntoSports: No scoresData available');
    }
    return sports;
  }

  const { byId, byTeams, allScores } = buildScoreIndex(scoresData);

  if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
    console.log('[DEBUG_OWLS_INSIGHT] Score index built:', {
      byIdSize: byId.size,
      byTeamsSize: byTeams.size,
      allScoresCount: allScores.length,
      sampleByIdKeys: Array.from(byId.keys()).slice(0, 3),
      sampleByTeamsKeys: Array.from(byTeams.keys()).slice(0, 3),
    });
  }

  if (byId.size === 0 && byTeams.size === 0) return sports;

  const next = { ...sports };
  let matchedCount = 0;
  let fuzzyMatchedCount = 0;
  let unmatchedLiveCount = 0;

  Object.entries(next).forEach(([sportKey, events]) => {
    if (!Array.isArray(events)) return;

    next[sportKey] = events.map((ev) => {
      const id = getEventKey(ev);
      const { home, away } = getHomeAwayNames(ev);
      const matchKey = buildTeamsKey(away, home);

      // Try exact ID match, then exact team key match, then fuzzy team name match
      let score =
        (id && byId.get(String(id))) ||
        (matchKey ? byTeams.get(matchKey) : null) ||
        null;

      // Fuzzy matching fallback for partial team names (e.g., "Delaware" vs "Delaware Blue Hens")
      let wasFuzzyMatch = false;
      if (!score && home && away) {
        score = fuzzyMatchScore(home, away, allScores);
        if (score) wasFuzzyMatch = true;
      }

      if (!score) {
        // Log unmatched live events for debugging
        if (process.env.DEBUG_OWLS_INSIGHT === 'true' && ev.status === 'live' && unmatchedLiveCount < 3) {
          unmatchedLiveCount++;
          console.log('[DEBUG_OWLS_INSIGHT] Unmatched live event:', {
            sport: sportKey,
            id,
            matchKey,
            home,
            away,
            status: ev.status,
          });
        }
        return ev;
      }
      if (score.home_score == null && score.away_score == null) return ev;

      matchedCount++;
      if (wasFuzzyMatch) fuzzyMatchedCount++;

      // DEBUG: Log when merging live scores with clock/period data
      if (process.env.DEBUG_OWLS_INSIGHT === 'true' && (score.clock || score.period)) {
        console.log('[DEBUG_OWLS_INSIGHT] Merging clock/period into odds event:', {
          sport: sportKey,
          teams: `${away} @ ${home}`,
          scores: `${score.away_score} - ${score.home_score}`,
          clock: score.clock,
          period: score.period,
          detail: score.detail,
        });
      }

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

  if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
    console.log('[DEBUG_OWLS_INSIGHT] Score merge result:', { matchedCount, fuzzyMatchedCount, unmatchedLiveCount });
  }

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

  // Some upstream payloads may be partial (only a subset of sports or bookmakers).
  // Use deep merge to preserve bookmaker data across updates.
  const incomingSports = data.sports || data;
  if (incomingSports && typeof incomingSports === 'object' && !Array.isArray(incomingSports)) {
    const prev = (latestOddsData && typeof latestOddsData === 'object' && !Array.isArray(latestOddsData))
      ? latestOddsData
      : {};
    latestOddsData = mergeSportsWithBookmakers(prev, incomingSports);
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

    // Debug: Log sample score data to verify format
    if (process.env.DEBUG_OWLS_INSIGHT === 'true' && totalLive > 0) {
      const sampleSport = Object.keys(sportsObj).find(k => sportsObj[k]?.length > 0);
      if (sampleSport) {
        const sample = sportsObj[sampleSport][0];
        console.log('[DEBUG_OWLS_INSIGHT] Sample score event:', {
          sport: sampleSport,
          eventId: sample?.eventId || sample?.id || sample?.event_id,
          homeTeam: sample?.home_team || sample?.homeTeam || sample?.home?.name || sample?.home?.team?.displayName,
          awayTeam: sample?.away_team || sample?.awayTeam || sample?.away?.name || sample?.away?.team?.displayName,
          homeScore: sample?.home_score ?? sample?.homeScore ?? sample?.home?.score ?? sample?.score?.home,
          awayScore: sample?.away_score ?? sample?.awayScore ?? sample?.away?.score ?? sample?.score?.away,
          allKeys: Object.keys(sample || {}),
          // Log raw home/away objects to see actual structure
          rawHome: sample?.home,
          rawAway: sample?.away,
        });

        // Log clock/period/status info
        console.log('[DEBUG_OWLS_INSIGHT] Sample score STATUS/CLOCK:', {
          sport: sampleSport,
          eventId: sample?.eventId || sample?.id,
          status: sample?.status,
          statusType: typeof sample?.status,
          // Direct fields
          clock: sample?.clock,
          displayClock: sample?.displayClock,
          period: sample?.period,
          // Nested in status object
          'status.state': sample?.status?.state,
          'status.detail': sample?.status?.detail,
          'status.displayClock': sample?.status?.displayClock,
          'status.period': sample?.status?.period,
        });
      }
    }
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

// Broadcast player props update to all connected clients
function broadcastPropsUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const propsCounts = {};
    let totalGames = 0;
    let totalProps = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        propsCounts[sportKey] = games.length;
        totalGames += games.length;
        // Count total props across all books for each game
        games.forEach(game => {
          if (Array.isArray(game.books)) {
            game.books.forEach(book => {
              if (Array.isArray(book.props)) {
                totalProps += book.props.length;
              }
            });
          }
        });
      }
    });

    logger.debug(`[Upstream] player-props-update received. ${totalProps} props from ${totalGames} games`, propsCounts);
  } catch (e) {
    logger.warn(`[Upstream] props debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestPropsData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  // Only broadcast to clients with props access (Rookie/MVP tier)
  let sentCount = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.limits?.propsAllowed) {
      socket.emit('player-props-update', payload);
      sentCount++;
    }
  }
  logger.info(`Broadcasted props update to ${sentCount}/${io.engine.clientsCount} clients (filtered by tier)`);
}

// Broadcast Bet365 player props update to all connected clients
function broadcastBet365PropsUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const propsCounts = {};
    let totalGames = 0;
    let totalProps = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        propsCounts[sportKey] = games.length;
        totalGames += games.length;
        games.forEach(game => {
          if (Array.isArray(game.props)) {
            totalProps += game.props.length;
          }
        });
      }
    });

    logger.debug(`[Upstream] bet365-props-update received. ${totalProps} props from ${totalGames} games`, propsCounts);
  } catch (e) {
    logger.warn(`[Upstream] bet365 props debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestBet365PropsData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  // Only broadcast to clients with props access (Rookie/MVP tier)
  let sentCount = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.limits?.propsAllowed) {
      socket.emit('bet365-props-update', payload);
      sentCount++;
    }
  }
  logger.info(`Broadcasted Bet365 props update to ${sentCount}/${io.engine.clientsCount} clients (filtered by tier)`);
}

// Broadcast FanDuel player props update to all connected clients
function broadcastFanDuelPropsUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const propsCounts = {};
    let totalGames = 0;
    let totalProps = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        propsCounts[sportKey] = games.length;
        totalGames += games.length;
        games.forEach(game => {
          if (Array.isArray(game.props)) {
            totalProps += game.props.length;
          }
          // Also count props inside books array
          if (Array.isArray(game.books)) {
            game.books.forEach(book => {
              if (Array.isArray(book.props)) {
                totalProps += book.props.length;
              }
            });
          }
        });
      }
    });

    logger.debug(`[Upstream] fanduel-props-update received. ${totalProps} props from ${totalGames} games`, propsCounts);
  } catch (e) {
    logger.warn(`[Upstream] fanduel props debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestFanDuelPropsData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  // Only broadcast to clients with props access (Rookie/MVP tier)
  let sentCount = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.limits?.propsAllowed) {
      socket.emit('fanduel-props-update', payload);
      sentCount++;
    }
  }
  logger.info(`Broadcasted FanDuel props update to ${sentCount}/${io.engine.clientsCount} clients (filtered by tier)`);
}

// Broadcast DraftKings player props update to all connected clients
function broadcastDraftKingsPropsUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const propsCounts = {};
    let totalGames = 0;
    let totalProps = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        propsCounts[sportKey] = games.length;
        totalGames += games.length;
        games.forEach(game => {
          if (Array.isArray(game.props)) {
            totalProps += game.props.length;
          }
        });
      }
    });

    logger.debug(`[Upstream] draftkings-props-update received. ${totalProps} props from ${totalGames} games`, propsCounts);
  } catch (e) {
    logger.warn(`[Upstream] draftkings props debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestDraftKingsPropsData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  // Only broadcast to clients with props access (Rookie/MVP tier)
  let sentCount = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.limits?.propsAllowed) {
      socket.emit('draftkings-props-update', payload);
      sentCount++;
    }
  }
  logger.info(`Broadcasted DraftKings props update to ${sentCount}/${io.engine.clientsCount} clients (filtered by tier)`);
}

// Forward props history responses to the requesting client (by requestId)
function broadcastPropsHistoryResponse(data) {
  if (!data || typeof data !== 'object') return;
  const requestId = data.requestId;
  if (requestId) {
    const requestMeta = propsHistoryRequests.get(requestId);
    if (!requestMeta) {
      logger.debug(`Props history response for requestId ${requestId} - request expired or not found`);
      return;
    }
    propsHistoryRequests.delete(requestId);
    const targetSocket = io.sockets.sockets.get(requestMeta.socketId);
    if (targetSocket) {
      targetSocket.emit('props-history-response', data);
    } else {
      logger.warn(`Props history response target socket not found for requestId ${requestId}`);
    }
    return;
  }

  io.emit('props-history-response', data);
}

// Broadcast BetMGM player props update to all connected clients
function broadcastBetMGMPropsUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const propsCounts = {};
    let totalGames = 0;
    let totalProps = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        propsCounts[sportKey] = games.length;
        totalGames += games.length;
        games.forEach(game => {
          if (Array.isArray(game.props)) {
            totalProps += game.props.length;
          }
        });
      }
    });

    logger.debug(`[Upstream] betmgm-props-update received. ${totalProps} props from ${totalGames} games`, propsCounts);
  } catch (e) {
    logger.warn(`[Upstream] betmgm props debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestBetMGMPropsData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  // Only broadcast to clients with props access (Rookie/MVP tier)
  let sentCount = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.limits?.propsAllowed) {
      socket.emit('betmgm-props-update', payload);
      sentCount++;
    }
  }
  logger.info(`Broadcasted BetMGM props update to ${sentCount}/${io.engine.clientsCount} clients (filtered by tier)`);
}

// Broadcast Caesars player props update to all connected clients
function broadcastCaesarsPropsUpdate(data) {
  try {
    const sportsObj = data.sports || {};
    const propsCounts = {};
    let totalGames = 0;
    let totalProps = 0;

    Object.entries(sportsObj).forEach(([sportKey, games]) => {
      if (Array.isArray(games)) {
        propsCounts[sportKey] = games.length;
        totalGames += games.length;
        games.forEach(game => {
          if (Array.isArray(game.props)) {
            totalProps += game.props.length;
          }
        });
      }
    });

    logger.debug(`[Upstream] caesars-props-update received. ${totalProps} props from ${totalGames} games`, propsCounts);
  } catch (e) {
    logger.warn(`[Upstream] caesars props debug log failed: ${e.message}`);
  }

  // Cache for new connections
  latestCaesarsPropsData = data;

  const payload = {
    sports: data.sports || {},
    timestamp: data.timestamp || new Date().toISOString(),
  };

  // Only broadcast to clients with props access (Rookie/MVP tier)
  let sentCount = 0;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.limits?.propsAllowed) {
      socket.emit('caesars-props-update', payload);
      sentCount++;
    }
  }
  logger.info(`Broadcasted Caesars props update to ${sentCount}/${io.engine.clientsCount} clients (filtered by tier)`);
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

// -----------------------------------------------------------------------------
// Socket.io Authentication Middleware
// -----------------------------------------------------------------------------
io.use(async (socket, next) => {
  // Extract API key from query params, auth object, or headers
  const apiKey = socket.handshake.query?.apiKey
    || socket.handshake.auth?.apiKey
    || extractApiKey(socket.handshake.headers?.authorization);

  if (!apiKey) {
    logger.warn(`WebSocket connection rejected: no API key provided`);
    return next(new Error('API key required'));
  }

  // Call upstream to validate the key
  const apiBase = getApiBaseUrl();
  const proxyApiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;

  if (!apiBase || !proxyApiKey) {
    logger.error('WebSocket auth failed: proxy not configured');
    return next(new Error('Authentication service unavailable'));
  }

  try {
    const resp = await fetch(`${apiBase}/api/internal/validate-key`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${proxyApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey }),
    });

    if (!resp.ok) {
      logger.warn(`WebSocket auth failed: upstream returned ${resp.status}`);
      return next(new Error('Authentication failed'));
    }

    const validation = await resp.json();

    if (!validation.valid) {
      logger.warn(`WebSocket connection rejected: ${validation.error}`);
      return next(new Error(validation.error || 'Invalid API key'));
    }

    // Check if WebSocket is enabled for this tier
    if (!validation.limits?.websocketEnabled) {
      logger.warn(`WebSocket connection rejected: tier ${validation.tier} does not have WebSocket access`);
      return next(new Error('WebSocket requires Rookie or MVP subscription'));
    }

    // Attach auth info to socket for tier-based filtering
    socket.data.userId = validation.userId;
    socket.data.tier = validation.tier;
    socket.data.limits = validation.limits;

    logger.info(`WebSocket authenticated: userId=${validation.userId}, tier=${validation.tier}`);
    next();
  } catch (err) {
    logger.error(`WebSocket auth error: ${err.message}`);
    return next(new Error('Authentication failed'));
  }
});

// Handle downstream client connections (Owls Insight frontend)
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id} (userId=${socket.data.userId}, tier=${socket.data.tier}, Total: ${io.engine.clientsCount})`);
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

  // Handle manual props refresh request from client
  socket.on('request-props', () => {
    logger.debug(`Client ${socket.id} requested props refresh`);
    // Only send props to clients with props access
    if (!socket.data.limits?.propsAllowed) {
      logger.debug(`Client ${socket.id} denied props refresh (tier: ${socket.data.tier})`);
      return;
    }
    if (latestPropsData) {
      logger.debug(`[Downstream] re-sending cached props to ${socket.id}`);
      socket.emit('player-props-update', {
        sports: latestPropsData.sports || {},
        timestamp: latestPropsData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle manual Bet365 props refresh request from client
  socket.on('request-bet365-props', () => {
    logger.debug(`Client ${socket.id} requested Bet365 props refresh`);
    // Only send props to clients with props access
    if (!socket.data.limits?.propsAllowed) {
      logger.debug(`Client ${socket.id} denied Bet365 props refresh (tier: ${socket.data.tier})`);
      return;
    }
    if (latestBet365PropsData) {
      logger.debug(`[Downstream] re-sending cached Bet365 props to ${socket.id}`);
      socket.emit('bet365-props-update', {
        sports: latestBet365PropsData.sports || {},
        timestamp: latestBet365PropsData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle manual FanDuel props refresh request from client
  socket.on('request-fanduel-props', () => {
    logger.debug(`Client ${socket.id} requested FanDuel props refresh`);
    // Only send props to clients with props access
    if (!socket.data.limits?.propsAllowed) {
      logger.debug(`Client ${socket.id} denied FanDuel props refresh (tier: ${socket.data.tier})`);
      return;
    }
    if (latestFanDuelPropsData) {
      logger.debug(`[Downstream] re-sending cached FanDuel props to ${socket.id}`);
      socket.emit('fanduel-props-update', {
        sports: latestFanDuelPropsData.sports || {},
        timestamp: latestFanDuelPropsData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle manual DraftKings props refresh request from client
  socket.on('request-draftkings-props', () => {
    logger.debug(`Client ${socket.id} requested DraftKings props refresh`);
    // Only send props to clients with props access
    if (!socket.data.limits?.propsAllowed) {
      logger.debug(`Client ${socket.id} denied DraftKings props refresh (tier: ${socket.data.tier})`);
      return;
    }
    if (latestDraftKingsPropsData) {
      logger.debug(`[Downstream] re-sending cached DraftKings props to ${socket.id}`);
      socket.emit('draftkings-props-update', {
        sports: latestDraftKingsPropsData.sports || {},
        timestamp: latestDraftKingsPropsData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle props history request from client (forward upstream)
  socket.on('request-props-history', (payload) => {
    const requestId = payload?.requestId || `props-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Only allow props history for clients with props access
    if (!socket.data.limits?.propsAllowed) {
      socket.emit('props-history-response', {
        success: false,
        requestId,
        error: 'Props history requires Rookie or MVP subscription',
      });
      return;
    }

    const gameId = payload?.gameId || payload?.game_id || payload?.eventId;
    const player = payload?.player;
    const category = payload?.category;
    const book = payload?.book;
    const hours = payload?.hours;

    // Rate limiting per socket
    const now = Date.now();
    const rateInfo = propsHistoryRateLimits.get(socket.id) || { count: 0, windowStart: now };
    if (now - rateInfo.windowStart > PROPS_HISTORY_RATE_LIMIT_WINDOW_MS) {
      rateInfo.count = 0;
      rateInfo.windowStart = now;
    }
    if (rateInfo.count >= PROPS_HISTORY_MAX_REQUESTS_PER_WINDOW) {
      socket.emit('props-history-response', {
        success: false,
        requestId,
        error: 'Rate limit exceeded, try again later',
      });
      return;
    }
    rateInfo.count++;
    propsHistoryRateLimits.set(socket.id, rateInfo);

    // Check max pending requests to prevent memory exhaustion
    if (propsHistoryRequests.size >= MAX_PENDING_PROPS_HISTORY_REQUESTS) {
      socket.emit('props-history-response', {
        success: false,
        requestId,
        error: 'Server overloaded, try again later',
      });
      return;
    }

    if (!gameId || !player || !category) {
      socket.emit('props-history-response', {
        success: false,
        requestId,
        error: 'Missing required parameters: gameId, player, category',
      });
      return;
    }

    propsHistoryRequests.set(requestId, { socketId: socket.id, createdAt: Date.now() });

    const forwarded = upstreamConnector?.emit('request-props-history', {
      requestId,
      gameId,
      player,
      category,
      book,
      hours,
    });

    if (!forwarded) {
      propsHistoryRequests.delete(requestId);
      socket.emit('props-history-response', {
        success: false,
        requestId,
        error: 'Upstream not connected',
      });
    }
  });

  // Handle manual BetMGM props refresh request from client
  socket.on('request-betmgm-props', () => {
    logger.debug(`Client ${socket.id} requested BetMGM props refresh`);
    // Only send props to clients with props access
    if (!socket.data.limits?.propsAllowed) {
      logger.debug(`Client ${socket.id} denied BetMGM props refresh (tier: ${socket.data.tier})`);
      return;
    }
    if (latestBetMGMPropsData) {
      logger.debug(`[Downstream] re-sending cached BetMGM props to ${socket.id}`);
      socket.emit('betmgm-props-update', {
        sports: latestBetMGMPropsData.sports || {},
        timestamp: latestBetMGMPropsData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle manual Caesars props refresh request from client
  socket.on('request-caesars-props', () => {
    logger.debug(`Client ${socket.id} requested Caesars props refresh`);
    // Only send props to clients with props access
    if (!socket.data.limits?.propsAllowed) {
      logger.debug(`Client ${socket.id} denied Caesars props refresh (tier: ${socket.data.tier})`);
      return;
    }
    if (latestCaesarsPropsData) {
      logger.debug(`[Downstream] re-sending cached Caesars props to ${socket.id}`);
      socket.emit('caesars-props-update', {
        sports: latestCaesarsPropsData.sports || {},
        timestamp: latestCaesarsPropsData.timestamp || new Date().toISOString(),
      });
    }
  });

  // Handle client disconnect
  socket.on('disconnect', (reason) => {
    clearSocketWatchers(socket.id);
    propsHistoryRequests.forEach((value, key) => {
      if (value.socketId === socket.id) propsHistoryRequests.delete(key);
    });
    propsHistoryRateLimits.delete(socket.id);
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
    onPropsUpdate: broadcastPropsUpdate,
    onBet365PropsUpdate: broadcastBet365PropsUpdate,
    onFanDuelPropsUpdate: broadcastFanDuelPropsUpdate,
    onDraftKingsPropsUpdate: broadcastDraftKingsPropsUpdate,
    onBetMGMPropsUpdate: broadcastBetMGMPropsUpdate,
    onCaesarsPropsUpdate: broadcastCaesarsPropsUpdate,
    onPropsHistoryResponse: broadcastPropsHistoryResponse,
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
