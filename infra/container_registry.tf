# ─── Azure Container Registry ──────────────────────────────────────────────────
resource "azurerm_container_registry" "main" {
  name                = "acr${local.token}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = true
  tags                = local.tags
}
