#!/bin/bash
#
# Rainbow Deployment Script for Owls Insight Server
#
# Deploys a new version alongside existing versions for zero-downtime
# WebSocket updates. Existing connections stay on old pods until they
# naturally disconnect.
#
# Usage:
#   ./scripts/rainbow-deploy.sh v1.0.1
#   ./scripts/rainbow-deploy.sh v1.0.1 --build  # Also build and push image
#
# How it works:
#   1. Creates a new Deployment with the version suffix
#   2. The Service selector matches all versions (via app label)
#   3. ALB sticky sessions keep existing connections on old pods
#   4. New connections load-balance to any pod (including new ones)
#   5. Old deployments are cleaned up when their connection count reaches 0
#

set -e

VERSION=$1
BUILD_FLAG=$2
NAMESPACE="${NAMESPACE:-owls-insight-dev}"
DEPLOYMENT_BASE="owls-insight-server"
ECR_REPO="482566359918.dkr.ecr.us-east-1.amazonaws.com/owls-insight-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}       RAINBOW DEPLOYMENT (Owls Insight Server)  ${NC}"
echo -e "${GREEN}=================================================${NC}"

if [ -z "$VERSION" ]; then
  echo -e "${RED}Error: Version required${NC}"
  echo "Usage: ./scripts/rainbow-deploy.sh v1.0.1 [--build]"
  echo ""
  echo "Options:"
  echo "  --build    Build and push Docker image before deploying"
  exit 1
fi

# Validate version format
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}Error: Version must be in format vX.Y.Z (e.g., v1.0.1)${NC}"
  exit 1
fi

echo -e "Version:    ${YELLOW}$VERSION${NC}"
echo -e "Namespace:  ${YELLOW}$NAMESPACE${NC}"
echo -e "Deployment: ${YELLOW}$DEPLOYMENT_BASE${NC}"
echo ""

# Step 1: Optionally build and push image
if [ "$BUILD_FLAG" == "--build" ]; then
  echo -e "${YELLOW}[Step 1/4] Building and pushing Docker image...${NC}"

  cd "$PROJECT_DIR"

  # Login to ECR
  aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 482566359918.dkr.ecr.us-east-1.amazonaws.com

  # Build image
  docker build -t "owls-insight-server:$VERSION" .

  # Tag and push
  docker tag "owls-insight-server:$VERSION" "$ECR_REPO:$VERSION"
  docker push "$ECR_REPO:$VERSION"

  echo -e "${GREEN}Image pushed: $ECR_REPO:$VERSION${NC}"
else
  echo -e "${YELLOW}[Step 1/4] Skipping build (use --build flag to build image)${NC}"
fi

# Step 2: Check if deployment already exists
NEW_DEPLOYMENT="${DEPLOYMENT_BASE}-${VERSION}"
echo ""
echo -e "${YELLOW}[Step 2/4] Checking existing deployments...${NC}"

EXISTING=$(kubectl get deployment "$NEW_DEPLOYMENT" -n "$NAMESPACE" 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
  echo -e "${RED}Deployment $NEW_DEPLOYMENT already exists!${NC}"
  echo "To redeploy, first delete it:"
  echo "  kubectl delete deployment $NEW_DEPLOYMENT -n $NAMESPACE"
  exit 1
fi

# List current deployments
echo "Current deployments:"
kubectl get deployments -n "$NAMESPACE" -l app=owls-insight-server -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image

# Step 3: Create new deployment
echo ""
echo -e "${YELLOW}[Step 3/4] Creating new deployment: $NEW_DEPLOYMENT${NC}"

# Get the base deployment and modify it using jq for clean JSON manipulation
kubectl get deployment "$DEPLOYMENT_BASE" -n "$NAMESPACE" -o json | \
  jq --arg name "$NEW_DEPLOYMENT" \
     --arg version "$VERSION" \
     --arg image "$ECR_REPO:$VERSION" '
    # Update metadata
    .metadata.name = $name |
    .metadata.labels.version = $version |
    del(.metadata.resourceVersion) |
    del(.metadata.uid) |
    del(.metadata.creationTimestamp) |
    del(.metadata.generation) |
    del(.metadata.annotations["deployment.kubernetes.io/revision"]) |
    del(.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]) |

    # Update spec
    .spec.replicas = 1 |
    .spec.template.metadata.labels.version = $version |
    .spec.template.spec.containers[0].image = $image |

    # Clear status
    del(.status)
  ' | kubectl apply -f -

# Add APP_VERSION environment variable
kubectl set env deployment/"$NEW_DEPLOYMENT" -n "$NAMESPACE" APP_VERSION="$VERSION"

# Step 4: Wait for rollout
echo ""
echo -e "${YELLOW}[Step 4/4] Waiting for deployment to be ready...${NC}"
kubectl rollout status deployment/"$NEW_DEPLOYMENT" -n "$NAMESPACE" --timeout=300s

# Final status
echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}       DEPLOYMENT COMPLETE                       ${NC}"
echo -e "${GREEN}=================================================${NC}"
echo ""
echo "All deployments:"
kubectl get deployments -n "$NAMESPACE" -l app=owls-insight-server -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image

echo ""
echo "Pods:"
kubectl get pods -n "$NAMESPACE" -l app=owls-insight-server -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,VERSION:.metadata.labels.version,IP:.status.podIP

echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Verify new pods are healthy and receiving traffic"
echo "2. Monitor connection counts on old pods"
echo "3. Run cleanup when old pods are drained:"
echo "   ./scripts/rainbow-cleanup.sh $VERSION"
