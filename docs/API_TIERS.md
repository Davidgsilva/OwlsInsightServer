# Owls Insight API Tiers & Pricing

## Subscription Tiers

| Tier | Price | Best For |
|------|-------|----------|
| **Bench** | $9.99/month | Casual users, basic odds tracking |
| **Rookie** | $24.99/month | Active bettors, real-time data needs |
| **MVP** | $49.99/month | Professional users, high-volume applications |

## Rate Limits by Tier

| Limit | Bench | Rookie | MVP |
|-------|-------|--------|-----|
| **Requests/Month** | 10,000 | 75,000 | 300,000 |
| **Requests/Minute** | 20 | 120 | 400 |
| **Concurrent Requests** | 1 | 5 | 15 |
| **WebSocket Enabled** | No | Yes | Yes |
| **WebSocket Connections** | 0 | 2 | 5 |
| **Props Access** | No | Yes | Yes |
| **History Days** | 0 | 14 | 90 |
| **Data Delay** | 45 seconds | Real-time | Real-time |

## Feature Access by Tier

| Feature | Bench | Rookie | MVP |
|---------|-------|--------|-----|
| Odds (h2h, spreads, totals) | ✓ | ✓ | ✓ |
| Live Scores | ✓ | ✓ | ✓ |
| Player Props | ✗ | ✓ | ✓ |
| EV Calculations | ✗ | ✓ | ✓ |
| Arbitrage | ✗ | ✓ | ✓ |
| Historical Data | ✗ | ✓ | ✓ |
| WebSocket | ✗ | ✓ | ✓ |
| Props via WebSocket | ✗ | ✓ | ✓ |

## Rate Limit Headers

All authenticated API responses include rate limit information:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Requests allowed per minute |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when window resets |
| `X-RateLimit-Monthly-Limit` | Requests allowed per month |
| `X-RateLimit-Monthly-Remaining` | Requests remaining this month |

## Rate Limit Responses

When rate limited, the API returns HTTP 429 with:

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "reason": "minute" | "monthly" | "concurrent",
  "retryAfter": 45
}
```

The `Retry-After` header indicates seconds until the limit resets (for per-minute limits).

## Data Delay (Bench Tier)

Bench tier users receive data with a 45-second delay to differentiate from real-time tiers. This applies to:
- Odds endpoints (`/api/v1/{sport}/odds`, `/moneyline`, `/spreads`, `/totals`)
- Scores endpoints (`/api/v1/scores/live`, `/api/v1/{sport}/scores/live`)

Rookie and MVP tiers receive real-time data with no delay.

## WebSocket Access

WebSocket connections require Rookie or MVP tier. Bench tier users attempting to connect will receive:

```
Error: WebSocket requires Rookie or MVP subscription
```

### Connection Limits

- **Rookie**: 2 concurrent WebSocket connections per user
- **MVP**: 5 concurrent WebSocket connections per user

Exceeding the limit returns:
```
Error: Maximum WebSocket connections (2) reached for rookie tier
```

## Brute Force Protection

To prevent API key guessing attacks:
- Max 10 failed authentication attempts per IP per minute
- Exceeding this returns HTTP 429 with `Retry-After` header
- Resets on successful authentication
