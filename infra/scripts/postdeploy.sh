#!/usr/bin/env bash
# postdeploy.sh — Updates seed job image to the deployed backend image and runs it.
# Runs after `azd deploy` once the real image is in ACR.
set -euo pipefail

echo "==> Post-deploy: running seed job..."

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP not set}"
: "${SEED_JOB_NAME:?SEED_JOB_NAME not set}"
: "${SERVICE_BACKEND_RESOURCE_NAME:?SERVICE_BACKEND_RESOURCE_NAME not set}"

# Retrieve the image azd just deployed to the Container App
IMAGE=$(az containerapp show \
  --name "${SERVICE_BACKEND_RESOURCE_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --query "properties.template.containers[0].image" \
  --output tsv)
echo "--> Using image: ${IMAGE}"

# Update seed job to the same image
az containerapp job update \
  --name "${SEED_JOB_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --image "${IMAGE}" \
  --output none

# Trigger the seed job
echo "--> Triggering seed job: ${SEED_JOB_NAME}"
az containerapp job start \
  --name "${SEED_JOB_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --output none

# Poll for completion (30 x 10s = 5 min)
echo "--> Waiting for seed job to complete..."
for i in $(seq 1 30); do
  STATUS=$(az containerapp job execution list \
    --name "${SEED_JOB_NAME}" \
    --resource-group "${AZURE_RESOURCE_GROUP}" \
    --query "[0].properties.status" -o tsv 2>/dev/null || echo "Pending")
  echo "    Status: ${STATUS} (attempt ${i}/30)"
  if [ "${STATUS}" = "Succeeded" ]; then
    echo "==> Seed complete."
    exit 0
  elif [ "${STATUS}" = "Failed" ]; then
    echo "ERROR: Seed job failed"
    exit 1
  fi
  sleep 10
done
echo "WARNING: Seed job timed out — check manually"
exit 0