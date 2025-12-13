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

      // Subscribe to all sports and books
      this.socket.emit('subscribe', {
        sports: ['nba', 'ncaab', 'nfl', 'nhl'],
        books: ['pinnacle', 'fanduel', 'draftkings', 'betmgm', 'bet365'],
      });
      logger.info('Sent subscription request for all sports and books');
    });

    // Handle odds update from upstream
    this.socket.on(this.upstreamEventName, (data) => {
      logger.debug(`Received odds update from upstream`);

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
      } catch (e) {
        logger.warn(`[Upstream] sampling failed: ${e.message}`);
      }

      // DEBUG: Look for specific games (Carolina, Bakersfield)
      if (data.sports?.ncaab) {
        console.log('\n========== NCAAB GAMES - Looking for Carolina/Bakersfield ==========');
        data.sports.ncaab.forEach((game, i) => {
          const teams = `${game.away_team} @ ${game.home_team}`;
          const isTarget = teams.toLowerCase().includes('carolina') ||
                          teams.toLowerCase().includes('bakersfield');
          if (isTarget) {
            console.log(`\nGAME: ${teams}`);
            console.log('  commence_time:', game.commence_time);
            console.log('  status:', game.status);
            console.log('  bookmakers:', game.bookmakers?.map(b => b.key).join(', ') || 'none');
          }
        });
        console.log('\nTotal NCAAB games:', data.sports.ncaab.length);
        console.log('==================================================================\n');
      }

      try {
        const transformedData = transformUpstreamData(data);
        this.onOddsUpdate(transformedData);
      } catch (error) {
        logger.error(`Error transforming upstream data: ${error.message}`);
      }
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

    // Handle general errors
    this.socket.on('error', (error) => {
      logger.error(`Upstream socket error: ${error.message}`);
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
