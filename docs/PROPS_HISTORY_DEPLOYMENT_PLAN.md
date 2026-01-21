# Props History Fix - Deployment Plan

## Summary

This deployment fixes the props history endpoint that was returning `upstream failed (400)` for external clients. The root cause was that the proxy server was not forwarding the `game_id` parameter to the upstream API server.

## Changes Included

### Commit 1: `e732b28` - Fix game_id parameter forwarding
- **REST API Fix**: Extract `game_id` and `eventId` from query params and forward to upstream
- **WebSocket Support**: Add `request-props-history` event handler for WebSocket clients
- **Request Tracking**: Track pending requests with TTL cleanup

### Commit 2: `0838c27` - Code review fixes
- **Race Condition Fix**: Use `get()` with null check instead of `has()`+`get()` pattern
- **Memory Protection**: Add `MAX_PENDING_PROPS_HISTORY_REQUESTS` (10,000) limit
- **Rate Limiting**: Add per-socket rate limiting (10 requests/second)
- **Cleanup**: Clean up rate limit map on socket disconnect

## Pre-Deployment Checklist

- [ ] Verify current production state
- [ ] Ensure no active incidents
- [ ] Verify AWS credentials are configured

```bash
# Check current deployment
kubectl get deployment owls-insight-server -n owls-insight-dev -o jsonpath='{.spec.template.spec.containers[0].image}'
# Expected: 482566359918.dkr.ecr.us-east-1.amazonaws.com/owls-insight-server:v1.8.0

# Verify pods are healthy
kubectl get pods -n owls-insight-dev -l app=owls-insight-server
```

## Deployment Steps

### Step 1: Push Code to Remote

```bash
cd /home/davidg/Projects/WiseSportsServices/OwlsInsightServer
git push origin main
```

### Step 2: Build Docker Image

```bash
# Set version (increment from v1.9.1 to v1.10.0)
export VERSION=v1.10.0
export AWS_ACCOUNT=482566359918
export AWS_REGION=us-east-1
export ECR_REPO=$AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/owls-insight-server

# Login to ECR
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com

# Build image
docker build -t owls-insight-server:$VERSION .

# Tag for ECR
docker tag owls-insight-server:$VERSION $ECR_REPO:$VERSION

# Push to ECR
docker push $ECR_REPO:$VERSION
```

### Step 3: Deploy to Kubernetes

```bash
# Update deployment image
kubectl set image deployment/owls-insight-server \
  owls-insight-server=$ECR_REPO:$VERSION \
  -n owls-insight-dev

# Watch rollout
kubectl rollout status deployment/owls-insight-server -n owls-insight-dev

# Verify new pods are running
kubectl get pods -n owls-insight-dev -l app=owls-insight-server
```

### Step 4: Update Deployment Manifest (for GitOps)

Update `k8s/deployment.yaml` to reflect the new version:

```yaml
image: 482566359918.dkr.ecr.us-east-1.amazonaws.com/owls-insight-server:v1.10.0
```

## Post-Deployment Verification

### Test 1: Health Check
```bash
curl -s https://ws.owlsinsight.com/health | jq .
# Expected: {"status":"ok", ...}
```

### Test 2: Props History Endpoint (THE FIX)
```bash
curl -s 'https://ws.owlsinsight.com/api/v1/nhl/props/history?game_id=nhl%3APhiladelphia%20Flyers%40Utah%20Mammoth-20260122&player=Nick%20Schmaltz&category=goals' \
  -H 'Authorization: Bearer YOUR_API_KEY' | jq .

# Expected: {"success":true,"data":{"gameId":"nhl:Philadelphia Flyers@Utah Mammoth-20260122",...}}
# NOT: {"success":false,"error":"upstream failed (400)"}
```

### Test 3: Props Endpoint (Regression Check)
```bash
curl -s 'https://ws.owlsinsight.com/api/v1/nhl/props' \
  -H 'Authorization: Bearer YOUR_API_KEY' | jq '.meta'

# Expected: {"sport":"nhl","timestamp":"...","propsReturned":N,...}
```

### Test 4: Check Logs for Errors
```bash
kubectl logs -n owls-insight-dev -l app=owls-insight-server --tail=50 | grep -i error
# Expected: No new errors related to props history
```

## Rollback Plan

If issues are detected after deployment:

```bash
# Rollback to previous version
kubectl rollout undo deployment/owls-insight-server -n owls-insight-dev

# Verify rollback
kubectl get pods -n owls-insight-dev -l app=owls-insight-server -o jsonpath='{.items[*].spec.containers[0].image}'
# Should show previous version (v1.8.0 or v1.9.1)
```

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| New code introduces bugs | Low | Medium | Comprehensive code review completed |
| Memory issues under load | Low | Medium | Added rate limiting and max request limits |
| WebSocket compatibility | Low | Low | WebSocket changes are additive, not breaking |

## Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.8.0 | - | Current production (missing game_id fix) |
| v1.9.1 | - | Alternative deployment (also missing fix) |
| v1.10.0 | TBD | Props history fix + code review improvements |

## Contacts

- **On-Call**: Check PagerDuty rotation
- **Rollback Authority**: Any team member can rollback if issues detected
