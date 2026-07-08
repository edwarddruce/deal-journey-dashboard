# ─── PostgreSQL Flexible Server ────────────────────────────────────────────────
resource "random_password" "postgres" {
  length           = 20
  special          = true
  override_special = "!#%&*()-_=+[]{}<>?"
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "psql-${local.token}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  administrator_login           = "dealadmin"
  administrator_password        = random_password.postgres.result
  storage_mb                    = 32768
  sku_name                      = "B_Standard_B2ms"
  backup_retention_days         = 7
  public_network_access_enabled = true
  tags                          = local.tags

  lifecycle {
    ignore_changes = [zone]
  }
}

# Allow all Azure services (includes Container Apps)
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "AllowAzureServices"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# deal_journey database
resource "azurerm_postgresql_flexible_server_database" "deal_journey" {
  name      = "deal_journey"
  server_id = azurerm_postgresql_flexible_server.main.id
  collation = "en_US.utf8"
  charset   = "utf8"
}
