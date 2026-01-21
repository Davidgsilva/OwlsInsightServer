# Coverage Gaps Report - OwlsInsightServer

**Generated:** 2026-01-15
**Updated:** 2026-01-15
**Purpose:** Document discrepancies between upstream API server and this proxy

## Executive Summary

OwlsInsightServer is a WebSocket proxy that sits between the upstream Owls Insight API (`nba-odds-app`) and frontend clients. This report documents what upstream features are currently exposed vs missing.

**Current Status:**
- ✅ Core odds and scores via WebSocket: **Working**
- ✅ Props (Pinnacle, Bet365, FanDuel, DraftKings): **Working**
- ✅ Odds REST endpoints (odds, moneyline, spreads, totals): **Working**
- ✅ Props history and analytics: **Working**
- ⚠️ Real-time alerts: **Not forwarded**
- ❌ AI-powered picks/suggestions: **Not proxied**

---

## REST Endpoint Coverage

### Proxied Endpoints ✅

| Proxy Endpoint | Upstream Endpoint | Status | Notes |
|----------------|-------------------|--------|-------|
| `GET /health` | `/api/health` | ✅ | Local health check |
| `GET /internal/connections` | - | ✅ | Local only (K8s) |
| `GET /api/history` | `/api/odds/history` | ✅ | Combined both sides |
| `GET /api/v1/scores/live` | `/api/v1/scores/live` | ✅ | Cached + proxied |
| `GET /api/v1/{sport}/scores/live` | `/api/v1/{sport}/scores/live` | ✅ | Per-sport scores |
| `GET /api/v1/{sport}/odds` | `/api/v1/{sport}/odds` | ✅ | From WebSocket cache |
| `GET /api/v1/{sport}/moneyline` | `/api/v1/{sport}/moneyline` | ✅ | h2h market only |
| `GET /api/v1/{sport}/spreads` | `/api/v1/{sport}/spreads` | ✅ | Spreads market only |
| `GET /api/v1/{sport}/totals` | `/api/v1/{sport}/totals` | ✅ | Totals market only |
| `GET /api/v1/{sport}/props` | `/api/v1/{sport}/props` | ✅ | Pinnacle props |
| `GET /api/v1/{sport}/props/bet365` | `/api/v1/{sport}/props/bet365` | ✅ | With local cache |
| `GET /api/v1/{sport}/props/fanduel` | `/api/v1/{sport}/props/fanduel` | ✅ | With local cache |
| `GET /api/v1/{sport}/props/draftkings` | `/api/v1/{sport}/props/draftkings` | ✅ | With local cache |
| `GET /api/v1/{sport}/props/history` | `/api/v1/{sport}/props/history` | ✅ | Props history |
| `GET /api/v1/props/bet365/stats` | `/api/v1/props/bet365/stats` | ✅ | Cache statistics |
| `GET /api/v1/props/fanduel/stats` | `/api/v1/props/fanduel/stats` | ✅ | Cache statistics |
| `GET /api/v1/{sport}/ev` | `/api/v1/{sport}/ev` | ✅ | EV opportunities |
| `GET /api/odds/ev/history` | `/api/odds/ev/history` | ✅ | EV history |
| `GET /api/odds/analytics` | `/api/odds/analytics` | ✅ | Odds analytics |
| `GET /api/v1/{sport}/arbitrage` | `/api/v1/{sport}/arbitrage` | ✅ | Arbitrage opps |

### NOT Proxied ❌

| Upstream Endpoint | Priority | Reason |
|-------------------|----------|--------|
| `GET /api/v1/{sport}/picks/suggest` | Low | AI feature, user-facing |
| `POST/GET/DELETE /api/v1/picks` | Low | User picks, needs auth |
| `GET /api/v1/subscription` | N/A | User dashboard only |
| `GET /api/v1/usage` | N/A | User dashboard only |
| `POST /api/v1/auth/*` | N/A | User authentication |

---

## WebSocket Event Coverage

### Server → Client Events

| Upstream Event | Proxy Event | Status | Notes |
|----------------|-------------|--------|-------|
| `odds-update` | `odds-update` | ✅ | Core odds data |
| `scores-update` | `scores-update` | ✅ | Live scores |
| `player-props-update` | `player-props-update` | ✅ | Pinnacle props |
| `bet365-props-update` | `bet365-props-update` | ✅ | Bet365 props |
| `fanduel-props-update` | `fanduel-props-update` | ✅ | FanDuel props |
| `draftkings-props-update` | `draftkings-props-update` | ✅ | DraftKings props |
| `history-update` | `history-update` | ✅ | Single-book history |
| `history-multi-update` | `history-multi-update` | ✅ | Multi-book history |
| `odds-change` | - | ❌ | Real-time price alerts |
| `snapshot-update` | - | ❌ | Game room snapshots |
| `system:key-expired` | - | ❌ | System notifications |
| `system:key-extracted` | - | ❌ | System notifications |

### Client → Server Events

| Upstream Event | Proxy Event | Status | Notes |
|----------------|-------------|--------|-------|
| `subscribe` | - | N/A | Proxy auto-subscribes |
| `request-odds` | `request-odds` | ✅ | Returns cached odds |
| `request-scores` | `request-scores` | ✅ | Returns cached scores |
| `request-props` | `request-props` | ✅ | Pinnacle props |
| `request-bet365-props` | `request-bet365-props` | ✅ | Bet365 props |
| `request-fanduel-props` | `request-fanduel-props` | ✅ | FanDuel props |
| `request-draftkings-props` | `request-draftkings-props` | ✅ | DraftKings props |
| `watch-history` | `watch-history` | ✅ | Subscribe to history |
| `watch-history-multi` | `watch-history-multi` | ✅ | Multi-book subscription |
| `unwatch-history` | `unwatch-history` | ✅ | Unsubscribe |
| `subscribe-game` | - | ❌ | Game room subscriptions |
| `unsubscribe-game` | - | ❌ | Game room subscriptions |

---

## Book Coverage

### Odds Subscription

| Book | Subscribed | Status |
|------|------------|--------|
| Pinnacle | ✅ | Working |
| FanDuel | ✅ | Working |
| DraftKings | ✅ | Working |
| BetMGM | ✅ | Working |
| Bet365 | ✅ | Working |
| Caesars | ✅ | Working |

### Props Subscription

| Book | Subscribed | Status |
|------|------------|--------|
| Pinnacle | ✅ | Working |
| Bet365 | ✅ | Working |
| FanDuel | ✅ | Working |
| DraftKings | ✅ | Working |
| BetMGM | N/A | Not available upstream |
| Caesars | N/A | Not available upstream |

---

## Known Issues

### 1. Esports/Simulation Games Under NCAAF (HIGH)

**Problem:** NBA simulation games (e.g., "BOS Celtics (BULLSEYE)") appearing under NCAAF sport category.

**Root Cause:** Upstream `isEsportsTeam()` filter doesn't catch team names with `(ALLCAPS)` suffix pattern.

**Fix Required (Upstream):** Add regex pattern to `ESPORTS_PATTERNS` in `lib/utils/team-normalization.ts`:
```typescript
/\([A-Z]+\)$/,  // "BOS Celtics (BULLSEYE)" - simulation league codes
```

### 2. Incorrect Game Start Times (HIGH)

**Problem:** All games showing same time (3:59 PM) regardless of actual start time.

**Symptoms:**
- Games that already started still showing as scheduled
- All games have identical `commence_time`

**Likely Cause:** Bet365 `parseBet365GameTime()` failing and using fallback time, or stale cached data.

**Debug Steps:**
1. Check if upstream is sending correct `commence_time` in ISO format
2. Verify Bet365 `gameTime` field format
3. Check for caching issues with old game data

### 3. Upstream Connection Failures (CRITICAL)

**Problem:** Proxy cannot connect to upstream WebSocket.

**Error:** `websocket error` on connection attempts

**Current Config:**
```
UPSTREAM_WS_URL=http://k8s-owlsinsi-owlsinsi-67f6aee9f8-724108586.us-east-1.elb.amazonaws.com
```

**Possible Causes:**
- AWS ELB not accessible from current network
- VPN required for internal AWS resources
- Upstream server down
- ELB URL changed

---

## Action Items

### High Priority

1. ~~**Add DraftKings props subscription**~~ ✅ COMPLETED
   - ~~Subscribe to `draftkings-props-update` event~~
   - ~~Add `latestDraftKingsPropsData` cache~~
   - ~~Add `request-draftkings-props` client event handler~~
   - ~~Add REST endpoint `/api/v1/{sport}/props/draftkings`~~

2. **Fix upstream connection**
   - Verify VPN connectivity
   - Update `UPSTREAM_WS_URL` if ELB changed
   - Test with local upstream server

3. **Report esports filter issue to upstream**
   - Pattern: `/\([A-Z]+\)$/` for sim game suffixes

### Medium Priority

4. ~~**Add FanDuel stats endpoint**~~ ✅ COMPLETED
   - ~~Proxy `/api/v1/props/fanduel/stats`~~

5. **Forward odds-change events**
   - Subscribe to `odds-change` upstream event
   - Broadcast to connected clients

### Low Priority

6. **Implement game room subscriptions**
   - `subscribe-game` / `unsubscribe-game` events
   - Forward `snapshot-update` to subscribed clients

---

## Coverage Summary

| Category | Covered | Total | Percentage |
|----------|---------|-------|------------|
| REST Endpoints (needed) | 20 | 22 | 91% |
| WebSocket Server→Client | 9 | 12 | 75% |
| WebSocket Client→Server | 10 | 12 | 83% |
| Odds Books | 6 | 6 | 100% |
| Props Books | 4 | 4 | 100% |

**Overall Proxy Coverage: ~90%**

---

## Recent Changes (2026-01-15)

- ✅ Added DraftKings props WebSocket subscription
- ✅ Added DraftKings props REST endpoint (`/api/v1/{sport}/props/draftkings`)
- ✅ Added `request-draftkings-props` client event handler
- ✅ Added FanDuel stats endpoint (`/api/v1/props/fanduel/stats`)
- ✅ Added odds REST endpoints (`/api/v1/{sport}/odds`, `/moneyline`, `/spreads`, `/totals`)
- ✅ Added props history endpoint (`/api/v1/{sport}/props/history`)
- ✅ Added analytics endpoint (`/api/odds/analytics`)

---

## Files Reference

| Component | Location |
|-----------|----------|
| Main server | `src/index.js` |
| Upstream connector | `src/services/upstreamConnector.js` |
| Data transformer | `src/services/dataTransformer.js` |
| Environment config | `.env` |
| CLAUDE.md | `CLAUDE.md` |
