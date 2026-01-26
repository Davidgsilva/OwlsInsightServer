# Owls Insight API Reference

**Base URL:** `https://ws.owlsinsight.com`
**Auth Header:** `Authorization: Bearer <API_KEY>`
**Sports:** `nba`, `ncaab`, `nfl`, `nhl`, `ncaaf`, `mlb`

---

## Games & Odds

Use the odds endpoint to get all available games:

```bash
# All games (returns game IDs, teams, commence_time)
curl 'https://ws.owlsinsight.com/api/v1/nba/odds' -H 'Authorization: Bearer KEY'

# Specific game
curl 'https://ws.owlsinsight.com/api/v1/nba/odds?eventId=nba:BOS@SAC-20260122' -H 'Authorization: Bearer KEY'

# Moneyline / Spreads / Totals
curl 'https://ws.owlsinsight.com/api/v1/nba/moneyline' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/nba/spreads' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/nba/totals' -H 'Authorization: Bearer KEY'

# Odds history
curl 'https://ws.owlsinsight.com/api/odds/history?eventId=nba:BOS@SAC-20260122&book=pinnacle&market=spreads&hours=24' -H 'Authorization: Bearer KEY'
```

---

## Live Scores

```bash
curl 'https://ws.owlsinsight.com/api/v1/scores/live' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/nba/scores/live' -H 'Authorization: Bearer KEY'
```

---

## Player Props by Book

```bash
# Pinnacle (default)
curl 'https://ws.owlsinsight.com/api/v1/nba/props' -H 'Authorization: Bearer KEY'

# FanDuel
curl 'https://ws.owlsinsight.com/api/v1/nba/props/fanduel' -H 'Authorization: Bearer KEY'

# DraftKings
curl 'https://ws.owlsinsight.com/api/v1/nba/props/draftkings' -H 'Authorization: Bearer KEY'

# Bet365
curl 'https://ws.owlsinsight.com/api/v1/nba/props/bet365' -H 'Authorization: Bearer KEY'

# BetMGM
curl 'https://ws.owlsinsight.com/api/v1/nba/props/betmgm' -H 'Authorization: Bearer KEY'

# Caesars
curl 'https://ws.owlsinsight.com/api/v1/nba/props/caesars' -H 'Authorization: Bearer KEY'
```

**Filters:** `?game_id=X&player=Y&category=Z`

---

## Props History (Line Movement)

**Required:** `game_id`, `player`, `category`

```bash
# Pinnacle history
curl 'https://ws.owlsinsight.com/api/v1/nba/props/history?game_id=nba:BOS@SAC-20260122&player=Jaylen%20Brown&category=points' -H 'Authorization: Bearer KEY'

# FanDuel history
curl 'https://ws.owlsinsight.com/api/v1/nba/props/fanduel/history?game_id=nba:BOS@SAC-20260122&player=Jaylen%20Brown&category=points' -H 'Authorization: Bearer KEY'

# DraftKings history
curl 'https://ws.owlsinsight.com/api/v1/nba/props/draftkings/history?game_id=nba:BOS@SAC-20260122&player=Jaylen%20Brown&category=points' -H 'Authorization: Bearer KEY'

# Bet365 history
curl 'https://ws.owlsinsight.com/api/v1/nba/props/bet365/history?game_id=nba:BOS@SAC-20260122&player=Jaylen%20Brown&category=points' -H 'Authorization: Bearer KEY'

# BetMGM history
curl 'https://ws.owlsinsight.com/api/v1/nba/props/betmgm/history?game_id=nba:BOS@SAC-20260122&player=Jaylen%20Brown&category=points' -H 'Authorization: Bearer KEY'

# Caesars history
curl 'https://ws.owlsinsight.com/api/v1/nba/props/caesars/history?game_id=nba:BOS@SAC-20260122&player=Jaylen%20Brown&category=points' -H 'Authorization: Bearer KEY'
```

**Optional:** `&hours=4` to limit history

---

## Props Stats

```bash
curl 'https://ws.owlsinsight.com/api/v1/props/stats' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/props/fanduel/stats' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/props/bet365/stats' -H 'Authorization: Bearer KEY'
```

Returns: `{ total, bySport: { nba: { games, props }, ... }, timestamp, ageMs }`

---

## EV & Arbitrage

```bash
curl 'https://ws.owlsinsight.com/api/v1/nba/ev' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/nba/ev?min_ev=2.5' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/api/v1/nba/arbitrage?min_profit=1.5' -H 'Authorization: Bearer KEY'
```

---

## Coverage & Health

```bash
curl 'https://ws.owlsinsight.com/api/v1/coverage' -H 'Authorization: Bearer KEY'
curl 'https://ws.owlsinsight.com/health'  # No auth needed
```

---

## Game ID Format

```
{sport}:{away}@{home}-{YYYYMMDD}

nba:BOS@SAC-20260122
nhl:Philadelphia Flyers@Utah Mammoth-20260122
nfl:KC@BUF-20260119
```

---

## Prop Categories

| Sport | Categories |
|-------|------------|
| NBA/NCAAB | `points`, `rebounds`, `assists`, `threes`, `steals`, `blocks`, `turnovers`, `points_rebounds_assists`, `double_double` |
| NFL | `passing_yards`, `passing_tds`, `rushing_yards`, `receiving_yards`, `receptions` |
| NHL | `goals`, `assists`, `shots`, `saves` |
| MLB | `strikeouts`, `hits`, `home_runs`, `rbis`, `total_bases` |

---

## WebSocket

```javascript
const socket = io('wss://ws.owlsinsight.com');

// Request props history via WebSocket
socket.emit('request-props-history', {
  requestId: 'abc123',
  gameId: 'nba:BOS@SAC-20260122',
  player: 'Jaylen Brown',
  category: 'points'
});

socket.on('props-history-response', (data) => console.log(data));
```
