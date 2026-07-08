#!/usr/bin/env bash
# postprovision.sh — Links the Container App as the SWA /api backend.
# Runs after `azd provision` (Terraform apply). Image not available yet;
# seed is triggered by postdeploy.sh after azd builds and pushes the image.
set -euo pipefail

echo "==> Post-provision: linking SWA backend..."

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP not set}"
: "${SWA_NAME:?SWA_NAME not set}"
: "${BACKEND_CONTAINER_APP_ID:?BACKEND_CONTAINER_APP_ID not set}"

echo "--> Linking Container App backend to Static Web App..."
az staticwebapp backends link \
  --name "${SWA_NAME}" \
  --resource-group "${AZURE_RESOURCE_GROUP}" \
  --backend-resource-id "${BACKEND_CONTAINER_APP_ID}" \
  --output none
echo "==> SWA backend linked."