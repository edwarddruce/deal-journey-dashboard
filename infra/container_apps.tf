# ─── Log Analytics (required by Container Apps Environment) ───────────────────
resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.token}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

# ─── Container Apps Environment ───────────────────────────────────────────────
resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.token}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = local.tags
}

# ─── Backend Container App ────────────────────────────────────────────────────
# Placeholder image is used on first provision; azd deploy replaces it.
# lifecycle.ignore_changes prevents Terraform reverting the image on re-runs.
resource "azurerm_container_app" "backend" {
  name                         = "ca-backend-${local.token}"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  tags                         = merge(local.tags, { "azd-service-name" = "backend" })

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "database-url"
    value = "postgresql://dealadmin:${random_password.postgres.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/deal_journey?sslmode=require"
  }

  ingress {
    external_enabled = true
    target_port      = 3001
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "backend"
      image  = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = "3001"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/health"
        port      = 3001
      }
    }
  }

  lifecycle {
    ignore_changes = [template]
  }
}

# ─── Seed Job ─────────────────────────────────────────────────────────────────
# Placeholder image on provision; postdeploy.sh updates to actual image and runs.
resource "azurerm_container_app_job" "seed" {
  name                         = "job-seed-${local.token}"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = azurerm_resource_group.main.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  tags                         = local.tags

  registry {
    server               = azurerm_container_registry.main.login_server
    username             = azurerm_container_registry.main.admin_username
    password_secret_name = "acr-password"
  }

  secret {
    name  = "acr-password"
    value = azurerm_container_registry.main.admin_password
  }

  secret {
    name  = "database-url"
    value = "postgresql://dealadmin:${random_password.postgres.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/deal_journey?sslmode=require"
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  replica_timeout_in_seconds = 600
  replica_retry_limit        = 1

  template {
    container {
      name   = "seed"
      image  = "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest"
      cpu    = 0.5
      memory = "1Gi"
      args   = ["node", "dist/seed.js"]

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
    }
  }

  lifecycle {
    ignore_changes = [template]
  }
}