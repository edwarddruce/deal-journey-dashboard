# ─── Outputs consumed by azd ───────────────────────────────────────────────────

# ACR — azd uses this to push the Docker image
output "AZURE_CONTAINER_REGISTRY_ENDPOINT" {
  value = azurerm_container_registry.main.login_server
}

output "AZURE_CONTAINER_REGISTRY_NAME" {
  value = azurerm_container_registry.main.name
}

# Resource group — used by azd hooks and CLI commands
output "AZURE_RESOURCE_GROUP" {
  value = azurerm_resource_group.main.name
}

# Backend Container App — azd deploys the image here
output "SERVICE_BACKEND_RESOURCE_NAME" {
  value = azurerm_container_app.backend.name
}

# Seed job — referenced by postdeploy hook
output "SEED_JOB_NAME" {
  value = azurerm_container_app_job.seed.name
}

# Dashboard URL — frontend is now served from the same Container App
output "FRONTEND_URL" {
  value = "https://${azurerm_container_app.backend.name}.${azurerm_container_app_environment.main.default_domain}"
}
