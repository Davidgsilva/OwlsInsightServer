const { io: ioClient } = require('socket.io-client');
const logger = require('../utils/logger');
const { transformUpstreamData } = require('./dataTransformer');

/**
 * UpstreamConnector - Connects to the upstream WebSocket odds provider
 * and relays data to the proxy server for broadcasting to clients.
 *
 * TODO: Create the connection to the upstream odds provider server
 * TODO: Configure the following environment variables:
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
    // TODO: Set UPSTREAM_WS_URL to the odds provider WebSocket URL
    this.upstreamUrl = process.env.UPSTREAM_WS_URL;
    this.upstreamPath = process.env.UPSTREAM_WS_PATH || '/socket.io';

    // TODO: Set OWLS_INSIGHT_SERVER_API_KEY for authentication with upstream
    this.apiKey = process.env.OWLS_INSIGHT_SERVER_API_KEY;

    // Event name mapping (configure based on upstream server)
    this.upstreamEventName = process.env.UPSTREAM_EVENT_NAME || 'odds-update';
  }

  /**
   * Connect to the upstream WebSocket server
   * TODO: Implement connection logic based on your upstream provider's requirements
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
    // TODO: Adjust connection options based on upstream server requirements
    const connectionOptions = {
      path: this.upstreamPath,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
    };

    // Add authentication with API key
    // TODO: Adjust auth format based on upstream server requirements
    if (this.apiKey) {
      connectionOptions.auth = {
        apiKey: this.apiKey,
      };
      connectionOptions.query = {
        apiKey: this.apiKey,
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

      // TODO: Subscribe to odds updates if upstream requires subscription
      // Some servers require sending a subscription message after connecting
      if (process.env.UPSTREAM_SUBSCRIBE_EVENT) {
        this.socket.emit(process.env.UPSTREAM_SUBSCRIBE_EVENT, {
          sports: ['nba', 'nfl', 'nhl', 'ncaab'],
          markets: ['spreads', 'totals', 'h2h'],
        });
        logger.info(`Sent subscription request: ${process.env.UPSTREAM_SUBSCRIBE_EVENT}`);
      }
    });

    // Handle odds update from upstream
    // TODO: Adjust event name based on upstream server's event naming
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
