# postdeploy.ps1 — Updates seed job image to the deployed backend image and runs it.
# Runs after `azd deploy` once the real image is in ACR.
$ErrorActionPreference = "Stop"

Write-Host "==> Post-deploy: running seed job..."

if (-not $env:AZURE_RESOURCE_GROUP)         { throw "AZURE_RESOURCE_GROUP not set" }
if (-not $env:SEED_JOB_NAME)                { throw "SEED_JOB_NAME not set" }
if (-not $env:SERVICE_BACKEND_RESOURCE_NAME) { throw "SERVICE_BACKEND_RESOURCE_NAME not set" }

# Retrieve the image azd just deployed to the Container App
$IMAGE = az containerapp show `
  --name $env:SERVICE_BACKEND_RESOURCE_NAME `
  --resource-group $env:AZURE_RESOURCE_GROUP `
  --query "properties.template.containers[0].image" `
  --output tsv

if ($LASTEXITCODE -ne 0) { throw "Failed to get Container App image" }
Write-Host "--> Using image: $IMAGE"

# Update seed job to the same image
az containerapp job update `
  --name $env:SEED_JOB_NAME `
  --resource-group $env:AZURE_RESOURCE_GROUP `
  --image $IMAGE `
  --output none

if ($LASTEXITCODE -ne 0) { throw "Failed to update seed job image" }

# Trigger the seed job
Write-Host "--> Triggering seed job: $env:SEED_JOB_NAME"
az containerapp job start `
  --name $env:SEED_JOB_NAME `
  --resource-group $env:AZURE_RESOURCE_GROUP `
  --output none

if ($LASTEXITCODE -ne 0) { throw "Failed to start seed job" }

# Poll for completion (30 x 10s = 5 min)
Write-Host "--> Waiting for seed job to complete..."
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 10
    $STATUS = az containerapp job execution list `
      --name $env:SEED_JOB_NAME `
      --resource-group $env:AZURE_RESOURCE_GROUP `
      --query "[0].properties.status" -o tsv 2>$null
    if (-not $STATUS) { $STATUS = "Pending" }
    Write-Host "    Status: $STATUS (attempt $i/30)"
    if ($STATUS -eq "Succeeded") {
        Write-Host "==> Seed complete."
        exit 0
    }
    if ($STATUS -eq "Failed") {
        Write-Error "ERROR: Seed job failed"
        exit 1
    }
}
Write-Warning "Seed job timed out - check manually"
exit 0
