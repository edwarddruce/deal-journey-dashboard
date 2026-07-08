# ─── Naming ────────────────────────────────────────────────────────────────────
data "azurerm_client_config" "current" {}

locals {
  tags = {
    "azd-env-name" = var.environment_name
  }
  # Short token used to make resource names globally unique (13 hex chars)
  token = substr(sha256("${data.azurerm_client_config.current.subscription_id}${var.environment_name}"), 0, 13)
}

# ─── Resource Group ────────────────────────────────────────────────────────────
resource "azurerm_resource_group" "main" {
  name     = "rg-deal-journey-${var.environment_name}"
  location = var.location
  tags     = local.tags
}
