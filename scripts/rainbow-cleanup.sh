#!/bin/bash
#
# Rainbow Deployment Cleanup Script for Owls Insight Server
#
# Cleans up old deployments that have no active WebSocket connections.
# Run this periodically after rainbow deployments to remove drained pods.
#
# Usage:
#   ./scripts/rainbow-cleanup.sh v1.0.1              # Specify current version to keep
#   ./scripts/rainbow-cleanup.sh v1.0.1 --dry-run    # Show what would be deleted
#   ./scripts/rainbow-cleanup.sh v1.0.1 --force      # Delete even if connections > 0
#
# The script:
#   1. Lists all owls-insight-server deployments
#   2. Checks connection count on each via /internal/connections
#   3. Deletes deployments with 0 connections (except current version)
#

set -e

CURRENT_VERSION=$1
FLAG=$2
NAMESPACE="${NAMESPACE:-owls-insight-dev}"
DEPLOYMENT_BASE="owls-insight-server"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-24}"  # Force delete after this many hours

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}=================================================${NC}"
echo -e "${CYAN}       RAINBOW CLEANUP (Owls Insight Server)     ${NC}"
echo -e "${CYAN}=================================================${NC}"

if [ -z "$CURRENT_VERSION" ]; then
  echo -e "${RED}Error: Current version required${NC}"
  echo "Usage: ./scripts/rainbow-cleanup.sh v1.0.1 [--dry-run|--force]"
  exit 1
fi

DRY_RUN=false
FORCE=false

if [ "$FLAG" == "--dry-run" ]; then
  DRY_RUN=true
  echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
fi

if [ "$FLAG" == "--force" ]; then
  FORCE=true
  echo -e "${YELLOW}FORCE MODE - Will delete even if connections > 0${NC}"
fi

echo ""
echo -e "Current version: ${GREEN}$CURRENT_VERSION${NC}"
echo -e "Namespace:       ${YELLOW}$NAMESPACE${NC}"
echo ""

# Get all owls-insight-server deployments
echo -e "${YELLOW}Checking deployments...${NC}"
echo ""

DEPLOYMENTS=$(kubectl get deployments -n "$NAMESPACE" -l app=owls-insight-server -o jsonpath='{.items[*].metadata.name}')

TOTAL_CONNECTIONS=0
DELETED_COUNT=0
KEPT_COUNT=0

for DEPLOY in $DEPLOYMENTS; do
  # Skip current version
  if [[ "$DEPLOY" == *"$CURRENT_VERSION"* ]]; then
    echo -e "${GREEN}[KEEP]${NC} $DEPLOY (current version)"
    KEPT_COUNT=$((KEPT_COUNT + 1))
    continue
  fi

  # Skip base deployment (no version suffix)
  if [ "$DEPLOY" == "$DEPLOYMENT_BASE" ]; then
    echo -e "${GREEN}[KEEP]${NC} $DEPLOY (base deployment)"
    KEPT_COUNT=$((KEPT_COUNT + 1))
    continue
  fi

  # Get pods for this deployment
  PODS=$(kubectl get pods -n "$NAMESPACE" -l app=owls-insight-server -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.podIP}{"\n"}{end}' | grep -E "^${DEPLOY}" || true)

  if [ -z "$PODS" ]; then
    echo -e "${YELLOW}[SKIP]${NC} $DEPLOY (no pods)"
    continue
  fi

  # Check connection count for each pod
  DEPLOY_CONNECTIONS=0

  while IFS=' ' read -r POD_NAME POD_IP; do
    if [ -z "$POD_IP" ] || [ "$POD_IP" == "<none>" ]; then
      continue
    fi

    # Try to get connection count via kubectl exec (using node since wget/curl not available)
    CONN=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- node -e "require('http').get('http://localhost:3001/internal/connections',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(JSON.parse(d).connections))})" 2>/dev/null || echo "0")

    if [ -n "$CONN" ] && [ "$CONN" != "0" ]; then
      DEPLOY_CONNECTIONS=$((DEPLOY_CONNECTIONS + CONN))
    fi
  done <<< "$PODS"

  TOTAL_CONNECTIONS=$((TOTAL_CONNECTIONS + DEPLOY_CONNECTIONS))

  # Check deployment age
  CREATED=$(kubectl get deployment "$DEPLOY" -n "$NAMESPACE" -o jsonpath='{.metadata.creationTimestamp}')
  AGE_SECONDS=$(($(date +%s) - $(date -d "$CREATED" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$CREATED" +%s 2>/dev/null)))
  AGE_HOURS=$((AGE_SECONDS / 3600))

  # Decide whether to delete
  if [ "$DEPLOY_CONNECTIONS" -eq 0 ]; then
    if [ "$DRY_RUN" == true ]; then
      echo -e "${YELLOW}[WOULD DELETE]${NC} $DEPLOY (0 connections, ${AGE_HOURS}h old)"
    else
      echo -e "${RED}[DELETING]${NC} $DEPLOY (0 connections, ${AGE_HOURS}h old)"
      kubectl delete deployment "$DEPLOY" -n "$NAMESPACE"
      DELETED_COUNT=$((DELETED_COUNT + 1))
    fi
  elif [ "$FORCE" == true ]; then
    if [ "$DRY_RUN" == true ]; then
      echo -e "${YELLOW}[WOULD FORCE DELETE]${NC} $DEPLOY ($DEPLOY_CONNECTIONS connections, ${AGE_HOURS}h old)"
    else
      echo -e "${RED}[FORCE DELETING]${NC} $DEPLOY ($DEPLOY_CONNECTIONS connections, ${AGE_HOURS}h old)"
      kubectl delete deployment "$DEPLOY" -n "$NAMESPACE"
      DELETED_COUNT=$((DELETED_COUNT + 1))
    fi
  elif [ "$AGE_HOURS" -ge "$MAX_AGE_HOURS" ]; then
    if [ "$DRY_RUN" == true ]; then
      echo -e "${YELLOW}[WOULD DELETE - TOO OLD]${NC} $DEPLOY ($DEPLOY_CONNECTIONS connections, ${AGE_HOURS}h old > ${MAX_AGE_HOURS}h max)"
    else
      echo -e "${RED}[DELETING - TOO OLD]${NC} $DEPLOY ($DEPLOY_CONNECTIONS connections, ${AGE_HOURS}h old > ${MAX_AGE_HOURS}h max)"
      kubectl delete deployment "$DEPLOY" -n "$NAMESPACE"
      DELETED_COUNT=$((DELETED_COUNT + 1))
    fi
  else
    echo -e "${CYAN}[DRAINING]${NC} $DEPLOY ($DEPLOY_CONNECTIONS connections, ${AGE_HOURS}h old)"
    KEPT_COUNT=$((KEPT_COUNT + 1))
  fi
done

echo ""
echo -e "${CYAN}=================================================${NC}"
echo -e "${CYAN}       SUMMARY                                   ${NC}"
echo -e "${CYAN}=================================================${NC}"
echo ""
echo -e "Deployments kept:    ${GREEN}$KEPT_COUNT${NC}"
echo -e "Deployments deleted: ${RED}$DELETED_COUNT${NC}"
echo -e "Total connections:   ${YELLOW}$TOTAL_CONNECTIONS${NC}"

if [ "$DRY_RUN" == true ]; then
  echo ""
  echo -e "${YELLOW}This was a dry run. No changes were made.${NC}"
  echo "Run without --dry-run to actually delete deployments."
fi

echo ""
echo "Current deployments:"
kubectl get deployments -n "$NAMESPACE" -l app=owls-insight-server -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,AGE:.metadata.creationTimestamp 2>/dev/null || echo "(none)"
