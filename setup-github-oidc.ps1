# setup-github-oidc.ps1
# Run ONCE to wire up passwordless OIDC auth between GitHub Actions and Azure.
# Requires: az CLI logged in with an account that can create app registrations
#           and assign roles on the resource group.
#
# Usage:
#   cd C:\Projects\deal-journey-dashboard
#   .\setup-github-oidc.ps1

$subscriptionId = "1f92d137-14d9-445a-9dbe-3a1af319858a"
$resourceGroup  = "rg-deal-journey-deal-journey-dashboard"
$acrName        = "acr4ba0be4f186fe"
$appName        = "github-actions-deal-journey"
$githubOrg      = "edwarddruce"
$githubRepo     = "deal-journey-dashboard"

Write-Host "Creating app registration '$appName'..."
$appId = (az ad app create --display-name $appName --query appId -o tsv)
if (-not $appId) { Write-Error "Failed to create app registration"; exit 1 }
Write-Host "App ID: $appId"

Write-Host "Creating service principal..."
az ad sp create --id $appId | Out-Null

# Wait a moment for replication
Start-Sleep -Seconds 5

Write-Host "Adding federated credential for push to main branch..."
$fedParams = [ordered]@{
    name      = "github-main"
    issuer    = "https://token.actions.githubusercontent.com"
    subject   = "repo:${githubOrg}/${githubRepo}:ref:refs/heads/main"
    audiences = @("api://AzureADTokenExchange")
} | ConvertTo-Json -Compress

az ad app federated-credential create --id $appId --parameters $fedParams | Out-Null

Write-Host "Assigning Contributor role on resource group..."
az role assignment create `
    --role        Contributor `
    --assignee    $appId `
    --scope       "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup" | Out-Null

Write-Host "Assigning AcrPush role on ACR..."
az role assignment create `
    --role        AcrPush `
    --assignee    $appId `
    --scope       "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup/providers/Microsoft.ContainerRegistry/registries/$acrName" | Out-Null

$tenantId = (az account show --query tenantId -o tsv)

Write-Host ""
Write-Host "============================================================"
Write-Host " DONE. Add these 3 secrets to your GitHub repo:"
Write-Host " https://github.com/$githubOrg/$githubRepo/settings/secrets/actions"
Write-Host "============================================================"
Write-Host "  AZURE_CLIENT_ID:       $appId"
Write-Host "  AZURE_TENANT_ID:       $tenantId"
Write-Host "  AZURE_SUBSCRIPTION_ID: $subscriptionId"
Write-Host "============================================================"
