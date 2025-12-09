const logger = require('../utils/logger');

/**
 * Transform upstream data to Owls Insight expected format.
 * Modify this based on your upstream data structure.
 *
 * Expected output format for Owls Insight:
 * {
 *   sports: {
 *     nba: [{ id, home_team, away_team, commence_time, bookmakers: [...] }],
 *     nfl: [...],
 *     nhl: [...],
 *     ncaab: [...]
 *   },
 *   openingLines: { ... }
 * }
 */

/**
 * Transform upstream data to Owls Insight format
 * @param {Object} upstreamData - Raw data from upstream WebSocket
 * @returns {Object} - Transformed data for Owls Insight
 */
function transformUpstreamData(upstreamData) {
  // If data is already in correct format, return as-is
  if (upstreamData.sports && typeof upstreamData.sports === 'object') {
    return upstreamData;
  }

  // If upstream sends data in The Odds API format
  if (Array.isArray(upstreamData)) {
    return transformOddsApiFormat(upstreamData);
  }

  // If upstream sends data with different structure
  // Add more transformers as needed based on your upstream format

  // Default: wrap in sports object
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
  };

  const sportKeyMapping = {
    'basketball_nba': 'nba',
    'football_nfl': 'nfl',
    'icehockey_nhl': 'nhl',
    'basketball_ncaab': 'ncaab',
    'basketball_ncaaf': 'ncaab',
  };

  events.forEach((event) => {
    const sportKey = sportKeyMapping[event.sport_key] || event.sport_key;

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
    sports,
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

  const validSports = ['nba', 'nfl', 'nhl', 'ncaab'];
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
