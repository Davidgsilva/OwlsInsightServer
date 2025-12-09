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
        books: ['pinnacle', 'fanduel', 'draftkings', 'betmgm'],
      });
      logger.info('Sent subscription request for all sports and books');
    });

    // Handle odds update from upstream
    this.socket.on(this.upstreamEventName, (data) => {
      logger.debug(`Received odds update from upstream`);
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
