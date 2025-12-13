# Dockerfile for Owls Insight Server
# WebSocket proxy - Node.js + Express + Socket.io (lightweight)

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-slim AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production

# =============================================================================
# Stage 2: Runner (Production)
# =============================================================================
FROM node:20-slim AS runner

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production

# Create non-root user for security
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --create-home appuser

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY package.json ./package.json
COPY src ./src

# Set ownership
RUN chown -R appuser:nodejs /app

USER appuser

EXPOSE 3001

ENV PORT=3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the server
CMD ["node", "src/index.js"]
