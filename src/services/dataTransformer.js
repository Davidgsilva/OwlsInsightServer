const logger = require('../utils/logger');

/**
 * Transform upstream data to Owls Insight expected format.
 * Modify this based on your upstream data structure.
 *
 * Expected output format for Owls Insight:
 * {
 *   sports: {
 *     nba: [{ id, home_team, away_team, commence_time, bookmakers: [...], averages: {...} }],
 *     nfl: [...],
 *     nhl: [...],
 *     ncaab: [...],
 *     ncaaf: [...]
 *   },
 *   openingLines: { ... }
 * }
 */

/**
 * Calculate average odds across all bookmakers for an event
 * @param {Object} event - Event with bookmakers array
 * @returns {Object|null} - Averages for spread, total, and moneyline
 */
function calculateEventAverages(event) {
  const bookmakers = event.bookmakers || [];
  if (bookmakers.length === 0) return null;

  // Collect values from all bookmakers
  const spreadHomePoints = [], spreadHomeOdds = [];
  const spreadAwayPoints = [], spreadAwayOdds = [];
  const totalOverPoints = [], totalOverOdds = [];
  const totalUnderPoints = [], totalUnderOdds = [];
  const mlHome = [], mlAway = [];

  bookmakers.forEach(book => {
    (book.markets || []).forEach(market => {
      if (market.key === 'spreads') {
        (market.outcomes || []).forEach(o => {
          if (o.name === event.home_team) {
            if (o.point != null) spreadHomePoints.push(o.point);
            if (o.price != null) spreadHomeOdds.push(o.price);
          } else {
            if (o.point != null) spreadAwayPoints.push(o.point);
            if (o.price != null) spreadAwayOdds.push(o.price);
          }
        });
      } else if (market.key === 'totals') {
        (market.outcomes || []).forEach(o => {
          if (o.name === 'Over') {
            if (o.point != null) totalOverPoints.push(o.point);
            if (o.price != null) totalOverOdds.push(o.price);
          } else {
            if (o.point != null) totalUnderPoints.push(o.point);
            if (o.price != null) totalUnderOdds.push(o.price);
          }
        });
      } else if (market.key === 'h2h') {
        (market.outcomes || []).forEach(o => {
          if (o.name === event.home_team) {
            if (o.price != null) mlHome.push(o.price);
          } else {
            if (o.price != null) mlAway.push(o.price);
          }
        });
      }
    });
  });

  // Helper functions
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const roundPoint = v => v != null ? Math.round(v * 2) / 2 : null; // Round to nearest 0.5
  const roundOdds = v => v != null ? Math.round(v) : null;

  return {
    spread: {
      home: roundPoint(avg(spreadHomePoints)),
      homeOdds: roundOdds(avg(spreadHomeOdds)),
      away: roundPoint(avg(spreadAwayPoints)),
      awayOdds: roundOdds(avg(spreadAwayOdds))
    },
    total: {
      over: roundPoint(avg(totalOverPoints)),
      overOdds: roundOdds(avg(totalOverOdds)),
      under: roundPoint(avg(totalUnderPoints)),
      underOdds: roundOdds(avg(totalUnderOdds))
    },
    moneyline: {
      home: roundOdds(avg(mlHome)),
      away: roundOdds(avg(mlAway))
    }
  };
}

/**
 * Add averages to all events in sports object
 * @param {Object} sports - Object with sport arrays
 * @returns {Object} - Sports object with averages added to each event
 */
function addAveragesToSports(sports) {
  const result = {};
  Object.keys(sports).forEach(sport => {
    if (Array.isArray(sports[sport])) {
      result[sport] = sports[sport].map(event => ({
        ...event,
        averages: calculateEventAverages(event)
      }));
    } else {
      result[sport] = sports[sport];
    }
  });
  return result;
}

/**
 * Transform upstream data to Owls Insight format
 * @param {Object} upstreamData - Raw data from upstream WebSocket
 * @returns {Object} - Transformed data for Owls Insight
 */
function transformUpstreamData(upstreamData) {
  const debugEnabled = process.env.DEBUG_OWLS_INSIGHT === 'true';

  // DEBUG: Log what we're transforming
  if (debugEnabled) {
    console.log('\n========== DATA TRANSFORMER DEBUG ==========');
    console.log('Input data keys:', Object.keys(upstreamData || {}));
    console.log('Has sports?', !!upstreamData?.sports);
    console.log('Has openingLines?', !!upstreamData?.openingLines);
    console.log('Is array?', Array.isArray(upstreamData));
  }

  // If data is already in correct format, add averages and return
  if (upstreamData.sports && typeof upstreamData.sports === 'object') {
    if (debugEnabled) {
      console.log('Path: sports object format - preserving openingLines');
      console.log('openingLines keys:', Object.keys(upstreamData.openingLines || {}).length);
      console.log('=============================================\n');
    }
    return {
      ...upstreamData,
      sports: addAveragesToSports(upstreamData.sports)
    };
  }

  // If upstream sends data in The Odds API format
  if (Array.isArray(upstreamData)) {
    if (debugEnabled) {
      console.log('Path: OddsAPI array format - openingLines will be empty');
      console.log('=============================================\n');
    }
    return transformOddsApiFormat(upstreamData);
  }

  // If upstream sends data with different structure
  // Add more transformers as needed based on your upstream format

  // Default: wrap in sports object
  if (debugEnabled) {
    console.log('Path: default wrap - openingLines will be empty');
    console.log('=============================================\n');
  }
  return {
    sports: upstreamData,
    openingLines: {},
  };
}

/**
 * Transform The Odds API format to Owls Insight format
 * The Odds API returns an array of events
 */
function transformOddsApiFormat(events) {
  const sports = {
    nba: [],
    nfl: [],
    nhl: [],
    ncaab: [],
    ncaaf: [],
  };

  const sportKeyMapping = {
    'basketball_nba': 'nba',
    'football_nfl': 'nfl',
    'americanfootball_nfl': 'nfl',
    'icehockey_nhl': 'nhl',
    'basketball_ncaab': 'ncaab',
    'americanfootball_ncaaf': 'ncaaf',
    'football_ncaaf': 'ncaaf',
  };

  const debugEnabled = process.env.DEBUG_OWLS_INSIGHT === 'true';
  if (debugEnabled) {
    const counts = {};
    events.forEach((e) => {
      const key = e?.sport_key || 'missing_sport_key';
      counts[key] = (counts[key] || 0) + 1;
    });
    // eslint-disable-next-line no-console
    console.log('[DEBUG_OWLS_INSIGHT] OddsAPI sport_key counts:', counts);
  }

  events.forEach((event) => {
    const sportKey = sportKeyMapping[event.sport_key] || event.sport_key;

    if (debugEnabled && !sports[sportKey] && event?.sport_key) {
      // eslint-disable-next-line no-console
      console.log('[DEBUG_OWLS_INSIGHT] Unmapped sport_key:', event.sport_key, '->', sportKey);
    }

    if (sports[sportKey]) {
      sports[sportKey].push({
        id: event.id,
        sport_key: event.sport_key,
        sport: sportKey,
        home_team: event.home_team,
        away_team: event.away_team,
        commence_time: event.commence_time,
        bookmakers: event.bookmakers || [],
      });
    }
  });

  return {
    sports: addAveragesToSports(sports),
    openingLines: {},
  };
}

/**
 * Transform a single event to Owls Insight format
 * Useful if upstream sends events one at a time
 */
function transformSingleEvent(event, sport) {
  return {
    id: event.id || event.event_id || `${event.home_team}-${event.away_team}`,
    sport: sport,
    home_team: event.home_team || event.homeTeam,
    away_team: event.away_team || event.awayTeam,
    commence_time: event.commence_time || event.startTime || event.game_time,
    bookmakers: transformBookmakers(event.bookmakers || event.odds || []),
  };
}

/**
 * Transform bookmakers array to standard format
 */
function transformBookmakers(bookmakers) {
  if (!Array.isArray(bookmakers)) {
    return [];
  }

  return bookmakers.map((book) => ({
    key: book.key || book.id || book.name?.toLowerCase().replace(/\s+/g, ''),
    title: book.title || book.name,
    markets: transformMarkets(book.markets || book.odds || []),
  }));
}

/**
 * Transform markets array to standard format
 */
function transformMarkets(markets) {
  if (!Array.isArray(markets)) {
    return [];
  }

  return markets.map((market) => ({
    key: market.key || market.type,
    outcomes: market.outcomes || market.prices || [],
  }));
}

/**
 * Validate that data matches expected Owls Insight format
 */
function validateOwlsInsightFormat(data) {
  if (!data || typeof data !== 'object') {
    return false;
  }

  if (!data.sports || typeof data.sports !== 'object') {
    return false;
  }

  const validSports = ['nba', 'nfl', 'nhl', 'ncaab', 'ncaaf'];
  for (const sport of validSports) {
    if (data.sports[sport] && !Array.isArray(data.sports[sport])) {
      return false;
    }
  }

  return true;
}

module.exports = {
  transformUpstreamData,
  transformOddsApiFormat,
  transformSingleEvent,
  transformBookmakers,
  transformMarkets,
  validateOwlsInsightFormat,
};
