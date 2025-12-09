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

  // Send latest data immediately on connect
  if (latestOddsData) {
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
      socket.emit('odds-update', {
        sports: latestOddsData,
        openingLines: openingLines,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle client disconnect
  socket.on('disconnect', (reason) => {
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
