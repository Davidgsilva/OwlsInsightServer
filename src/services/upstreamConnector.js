const { io: ioClient } = require('socket.io-client');
const logger = require('../utils/logger');
const { transformUpstreamData } = require('./dataTransformer');

/**
 * UpstreamConnector - Connects to the upstream WebSocket odds provider
 * and relays data to the proxy server for broadcasting to clients.
 *
 * Configure the following environment variables:
 *   - UPSTREAM_WS_URL: WebSocket URL of the odds provider
 *   - OWLS_INSIGHT_SERVER_API_KEY: API key for authentication
 */
class UpstreamConnector {
  constructor(options = {}) {
    this.socket = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = parseInt(process.env.UPSTREAM_MAX_RECONNECTS) || 10;
    this.reconnectDelay = parseInt(process.env.UPSTREAM_RECONNECT_DELAY) || 5000;

    // Callbacks
    this.onOddsUpdate = options.onOddsUpdate || (() => {});
    this.onScoresUpdate = options.onScoresUpdate || (() => {});
    this.onPropsUpdate = options.onPropsUpdate || (() => {});
    this.onBet365PropsUpdate = options.onBet365PropsUpdate || (() => {});
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});
    this.onError = options.onError || (() => {});

    // Upstream configuration
    this.upstreamUrl = process.env.UPSTREAM_WS_URL;
    this.upstreamPath = process.env.UPSTREAM_WS_PATH || '/socket.io';
    this.apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;

    // Event name mapping (configure based on upstream server)
    this.upstreamEventName = process.env.UPSTREAM_EVENT_NAME || 'odds-update';
  }

  /**
   * Connect to the upstream WebSocket server
   */
  connect() {
    if (!this.upstreamUrl) {
      logger.error('UPSTREAM_WS_URL not configured. Set it in .env file.');
      return;
    }

    if (!this.apiKey) {
      logger.warn('OWLS_INSIGHT_SERVER_API_KEY not configured. Authentication may fail.');
    }

    logger.info(`Connecting to upstream: ${this.upstreamUrl}`);

    // Build connection options
    const connectionOptions = {
      path: this.upstreamPath,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
    };

    // Add authentication with API key (multiple formats for compatibility)
    if (this.apiKey) {
      connectionOptions.auth = {
        apiKey: this.apiKey,
      };
      connectionOptions.query = {
        apiKey: this.apiKey,
      };
      connectionOptions.extraHeaders = {
        'X-API-Key': this.apiKey,
      };
    }

    // Create socket connection
    this.socket = ioClient(this.upstreamUrl, connectionOptions);

    // Handle connection events
    this.socket.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('Connected to upstream WebSocket server');
      this.onConnect();

      // Subscribe to all sports and books for odds
      this.socket.emit('subscribe', {
        sports: ['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf'],
        books: ['pinnacle', 'fanduel', 'draftkings', 'betmgm', 'bet365', 'caesars'],
      });
      logger.info('Sent subscription request for all sports and books');

      // Subscribe to Pinnacle player props (requires Pro/Enterprise tier on upstream)
      this.socket.emit('subscribe-props', {
        sports: ['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf'],
      });
      logger.info('Sent Pinnacle props subscription request for all sports');

      // Subscribe to Bet365 player props (requires Pro/Enterprise tier on upstream)
      this.socket.emit('subscribe-bet365-props', {
        sports: ['nba', 'ncaab', 'nfl', 'nhl', 'ncaaf'],
      });
      logger.info('Sent Bet365 props subscription request for all sports');
    });

    // Handle odds update from upstream
    this.socket.on(this.upstreamEventName, (data) => {
      logger.debug(`Received odds update from upstream`);

      // DEBUG: Check for openingLines in raw upstream data
      if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
        console.log('\n========== OPENING LINES DEBUG ==========');
        console.log('Raw data keys:', Object.keys(data || {}));
        console.log('Has openingLines?', !!data?.openingLines);
        if (data?.openingLines) {
          const keys = Object.keys(data.openingLines);
          console.log('openingLines key count:', keys.length);
          console.log('Sample openingLines keys (first 5):', keys.slice(0, 5));
          if (keys.length > 0) {
            const sampleKey = keys[0];
            console.log(`Sample openingLines[${sampleKey}]:`, JSON.stringify(data.openingLines[sampleKey], null, 2));
          }
        } else {
          console.log('openingLines is:', data?.openingLines);
        }
        console.log('==========================================\n');
      }

      // Generic debug sampling for payload shape (safe, small)
      try {
        const sportsObj = data.sports || {};
        Object.entries(sportsObj).forEach(([sportKey, games]) => {
          if (!Array.isArray(games) || games.length === 0) return;
          const g = games[0];
          const bookKeys = (g.bookmakers || []).map(b => b.key).filter(Boolean);
          logger.debug(
            `[Upstream] sample ${sportKey}: id=${g.id || 'n/a'} eventId=${g.eventId || 'NOT_SET'} ` +
            `teams=${g.away_team || g.awayTeam} @ ${g.home_team || g.homeTeam} ` +
            `commence=${g.commence_time || g.startTime || 'n/a'} ` +
            `books=${bookKeys.join(',') || 'none'}`
          );
        });

        // DEBUG: Check for duplicate games (same teams, different IDs)
        if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
          Object.entries(sportsObj).forEach(([sportKey, games]) => {
            if (!Array.isArray(games)) return;
            const seen = new Map();
            games.forEach(g => {
              const home = (g.home_team || g.homeTeam || '').toLowerCase().replace(/[^a-z]/g, '');
              const away = (g.away_team || g.awayTeam || '').toLowerCase().replace(/[^a-z]/g, '');
              const key = `${away}@${home}`;
              if (seen.has(key)) {
                const prev = seen.get(key);
                console.log(`\n⚠️  DUPLICATE GAME DETECTED (${sportKey}):`);
                console.log(`   Game 1: id=${prev.id || prev.eventId} "${prev.away_team || prev.awayTeam}" @ "${prev.home_team || prev.homeTeam}"`);
                console.log(`   Game 2: id=${g.id || g.eventId} "${g.away_team || g.awayTeam}" @ "${g.home_team || g.homeTeam}"`);
              } else {
                seen.set(key, g);
              }
            });
          });
        }
      } catch (e) {
        logger.warn(`[Upstream] sampling failed: ${e.message}`);
      }

      try {
        const transformedData = transformUpstreamData(data);
        this.onOddsUpdate(transformedData);
      } catch (error) {
        logger.error(`Error transforming upstream data: ${error.message}`);
      }
    });

    // Handle scores update from upstream (live game scores)
    this.socket.on('scores-update', (data) => {
      logger.debug(`Received scores-update from upstream`);

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

        logger.debug(`[Upstream] scores-update: ${totalLive} live games`, liveCounts);
      } catch (e) {
        logger.warn(`[Upstream] scores debug failed: ${e.message}`);
      }

      // Pass through directly (no transformation needed for scores)
      this.onScoresUpdate(data);
    });

    // Handle player props update from upstream
    this.socket.on('player-props-update', (data) => {
      logger.debug(`Received player-props-update from upstream`);

      // DEBUG: Log full payload structure for player props
      if (process.env.DEBUG_OWLS_INSIGHT === 'true') {
        console.log('\n========== PLAYER PROPS PAYLOAD DEBUG ==========');
        console.log('Top-level keys:', Object.keys(data || {}));
        console.log('Has sports?', !!data?.sports);
        console.log('Has timestamp?', !!data?.timestamp);

        const sportsObj = data?.sports || {};
        console.log('Sports keys:', Object.keys(sportsObj));

        // Log sample from each sport
        Object.entries(sportsObj).forEach(([sportKey, games]) => {
          if (Array.isArray(games) && games.length > 0) {
            console.log(`\n--- ${sportKey.toUpperCase()} (${games.length} games) ---`);
            const sampleGame = games[0];
            console.log('Sample game keys:', Object.keys(sampleGame || {}));
            console.log('Sample game:', JSON.stringify(sampleGame, null, 2).slice(0, 2000));

            // If there are books, show the structure
            if (Array.isArray(sampleGame?.books) && sampleGame.books.length > 0) {
              console.log('\nBooks array length:', sampleGame.books.length);
              const sampleBook = sampleGame.books[0];
              console.log('Sample book keys:', Object.keys(sampleBook || {}));
              console.log('Sample book:', JSON.stringify(sampleBook, null, 2).slice(0, 1500));

              // If there are props, show the structure
              if (Array.isArray(sampleBook?.props) && sampleBook.props.length > 0) {
                console.log('\nProps array length:', sampleBook.props.length);
                const sampleProp = sampleBook.props[0];
                console.log('Sample prop keys:', Object.keys(sampleProp || {}));
                console.log('Sample prop:', JSON.stringify(sampleProp, null, 2));
              }
            }
          }
        });
        console.log('=================================================\n');
      }

      try {
        const sportsObj = data.sports || {};
        const propsCounts = {};
        let totalGames = 0;

        Object.entries(sportsObj).forEach(([sportKey, games]) => {
          if (Array.isArray(games)) {
            propsCounts[sportKey] = games.length;
            totalGames += games.length;
          }
        });

        logger.debug(`[Upstream] player-props-update: ${totalGames} games with props`, propsCounts);
      } catch (e) {
        logger.warn(`[Upstream] props debug failed: ${e.message}`);
      }

      // Pass through directly (no transformation needed for props)
      this.onPropsUpdate(data);
    });

    // Handle props subscription confirmation
    this.socket.on('props-subscribed', (subscription) => {
      logger.info(`Pinnacle props subscription confirmed: ${JSON.stringify(subscription)}`);
    });

    // Handle Bet365 player props update from upstream
    this.socket.on('bet365-props-update', (data) => {
      logger.debug(`Received bet365-props-update from upstream`);

      // DEBUG: Always log Bet365 props receipt
      console.log('\n========== BET365 PROPS RECEIVED FROM UPSTREAM ==========');
      console.log('Timestamp:', new Date().toISOString());
      console.log('Data type:', typeof data);
      console.log('Has sports?', !!data?.sports);
      console.log('Top-level keys:', Object.keys(data || {}));

      try {
        const sportsObj = data.sports || {};
        const propsCounts = {};
        let totalGames = 0;
        let totalProps = 0;

        Object.entries(sportsObj).forEach(([sportKey, games]) => {
          if (Array.isArray(games)) {
            propsCounts[sportKey] = games.length;
            totalGames += games.length;
            // Count total props for each game
            games.forEach(game => {
              if (Array.isArray(game.props)) {
                totalProps += game.props.length;
              }
            });
          }
        });

        console.log('Sports breakdown:', propsCounts);
        console.log(`Total: ${totalProps} props from ${totalGames} games`);

        // Log sample game structure
        const firstSportWithGames = Object.entries(sportsObj).find(([_, games]) => Array.isArray(games) && games.length > 0);
        if (firstSportWithGames) {
          const [sport, games] = firstSportWithGames;
          const sampleGame = games[0];
          console.log(`\nSample game from ${sport}:`);
          console.log('  gameId:', sampleGame?.gameId);
          console.log('  homeTeam:', sampleGame?.homeTeam);
          console.log('  awayTeam:', sampleGame?.awayTeam);
          console.log('  props count:', sampleGame?.props?.length || 0);
          if (sampleGame?.props?.length > 0) {
            console.log('  Sample prop:', JSON.stringify(sampleGame.props[0], null, 2).slice(0, 500));
          }
        }
        console.log('=========================================================\n');

        logger.debug(`[Upstream] bet365-props-update: ${totalProps} props from ${totalGames} games`, propsCounts);
      } catch (e) {
        console.log('ERROR processing bet365 props:', e.message);
        logger.warn(`[Upstream] bet365 props debug failed: ${e.message}`);
      }

      // Pass through directly (no transformation needed for Bet365 props)
      this.onBet365PropsUpdate(data);
    });

    // Handle Bet365 props subscription confirmation
    this.socket.on('bet365-props-subscribed', (subscription) => {
      logger.info(`Bet365 props subscription confirmed: ${JSON.stringify(subscription)}`);
    });

    // Handle additional event names if configured
    const additionalEvents = process.env.UPSTREAM_ADDITIONAL_EVENTS?.split(',') || [];
    additionalEvents.forEach((eventName) => {
      if (eventName.trim()) {
        this.socket.on(eventName.trim(), (data) => {
          logger.debug(`Received ${eventName} from upstream`);
          try {
            const transformedData = transformUpstreamData(data);
            this.onOddsUpdate(transformedData);
          } catch (error) {
            logger.error(`Error transforming ${eventName} data: ${error.message}`);
          }
        });
      }
    });

    // Handle disconnect
    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      logger.warn(`Disconnected from upstream: ${reason}`);
      this.onDisconnect(reason);
    });

    // Handle connection errors
    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      logger.error(`Upstream connection error (attempt ${this.reconnectAttempts}): ${error.message}`);
      this.onError(error);

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max reconnection attempts reached. Stopping reconnection.');
        this.socket.disconnect();
      }
    });

    // Handle general errors (can be Error object or custom { message, code } from server)
    this.socket.on('error', (error) => {
      const errorMsg = error?.message || JSON.stringify(error);
      const errorCode = error?.code || 'UNKNOWN';
      logger.error(`Upstream socket error [${errorCode}]: ${errorMsg}`);
      this.onError(error);
    });
  }

  /**
   * Disconnect from upstream server
   */
  disconnect() {
    if (this.socket) {
      logger.info('Disconnecting from upstream...');
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected to upstream
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Send a message to upstream (if needed)
   */
  emit(event, data) {
    if (this.socket && this.connected) {
      this.socket.emit(event, data);
    } else {
      logger.warn(`Cannot emit ${event}: not connected to upstream`);
    }
  }
}

module.exports = UpstreamConnector;
