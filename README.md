# Deal Journey Dashboard

A real-time monitoring dashboard for tracking energy deal flow through a multi-system trading pipeline (VAT-P → NEON → Endur). Built with React, Node.js, and PostgreSQL, deployed to Azure Container Apps.

![Pipeline: VAT-P → NEON → Endur](https://img.shields.io/badge/Pipeline-VAT--P%20→%20NEON%20→%20Endur-blue)

---

## What it does

The dashboard gives operations teams a live view of deals flowing through the trading pipeline:

- **KPI cards** — Total deals, completion rate, grid position (MWh), in-flight deals, stuck deals, and critical deliveries at risk
- **Pipeline flow** — Per-system status (online/degraded/offline), deal counts, success rates, and gap analysis between systems
- **Aggregation panels** — Drill into VAT-P→NEON and NEON→Endur bundle aggregations with individual deal breakdowns
- **Reconciliation panel** — Cross-system deal matching to identify discrepancies
- **Deal tracker** — Search and inspect individual deals by ID or keyword
- **Time window filter** — View data across 1m, 15m, 30m, 1h, 24h, or today
- **Live feed** — Simulated deal seeding every 5 seconds (pauseable via the header toggle)

---

## Architecture

```
Browser → Container App (Express)
              ├── /           → React SPA (bundled into the image)
              ├── /api/*      → REST API routes
              └── PostgreSQL  → Deal journey data
```

**Azure resources:**
- Azure Container Apps — hosts the combined backend + frontend image
- Azure Container Registry — stores Docker images (built via ACR Tasks)
- Azure PostgreSQL Flexible Server — deal journey database
- Container Apps Environment + Log Analytics — runtime environment
- Container App Job — one-shot seed job to populate initial data

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 5, CSS Modules |
| Backend | Node.js 20, Express 4, TypeScript |
| Database | PostgreSQL 16 |
| IaC | Terraform (via Azure Developer CLI) |
| Container | Docker multi-stage build, ACR remote build |

---

## Local development

### Prerequisites

- Node.js 20+
- PostgreSQL 16 running locally (or via Docker)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/deal-journey-dashboard.git
cd deal-journey-dashboard
```

Install both sets of dependencies:

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Set up the database

Create a local database and apply the schema + seed data:

```bash
psql -U postgres -c "CREATE DATABASE deal_journey;"
psql -U postgres -d deal_journey -f db/schema.sql
psql -U postgres -d deal_journey -f db/seed.sql
```

### 3. Configure the backend

Create `backend/.env`:

```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/deal_journey
PORT=3001
```

### 4. Run

In two separate terminals:

```bash
# Terminal 1 — backend API
cd backend
npm run dev
# Listening on http://localhost:3001

# Terminal 2 — frontend
cd frontend
npm run dev
# Available at http://localhost:5173
```

The Vite dev server proxies all `/api` requests to `localhost:3001` automatically.

---

## Azure deployment

### Prerequisites

- [Azure Developer CLI (azd)](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) 1.5+
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.7+
- Azure subscription with Contributor access

> **Note:** Docker is not required locally — images are built remotely via ACR Tasks.

### Deploy

```bash
azd auth login
azd up
```

This will:
1. Provision all Azure infrastructure via Terraform
2. Build the Docker image (frontend + backend) using ACR Tasks
3. Deploy the image to Container Apps
4. Run a seed job to populate the database

The app URL is printed at the end of `azd up`.

### Redeploy after code changes

```bash
azd deploy
```

### Tear down

```bash
azd down
```

---

## Project structure

```
deal-journey-dashboard/
├── backend/
│   ├── src/
│   │   ├── index.ts          # Express app, serves API + React SPA in production
│   │   ├── db.ts             # PostgreSQL connection pool
│   │   ├── live.ts           # Live deal feed simulation
│   │   ├── seed.ts           # Database seed script
│   │   └── routes/           # API route handlers
│   ├── Dockerfile            # Multi-stage build (frontend + backend)
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/       # React UI components
│   │   ├── hooks/            # Data-fetching hooks
│   │   └── types/            # TypeScript type definitions
│   └── vite.config.ts
├── db/
│   ├── schema.sql            # Database schema (idempotent)
│   └── seed.sql              # Sample deal data
├── infra/                    # Terraform infrastructure
│   ├── container_apps.tf
│   ├── container_registry.tf
│   ├── postgresql.tf
│   ├── main.tf / variables.tf / outputs.tf / providers.tf
│   └── scripts/
│       └── postdeploy.ps1    # Updates seed job image and triggers run
└── azure.yaml                # azd configuration
```

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/dashboard?window=` | Dashboard summary + pipeline systems |
| GET | `/api/deals/list?` | Paginated deal list with filters |
| GET | `/api/deal/:id` | Single deal journey |
| GET | `/api/deal/search?q=` | Deal search |
| GET | `/api/aggregations/summary?window=` | Aggregation KPIs |
| GET | `/api/aggregations/bundles?stage=&window=` | Bundle list |
| GET | `/api/aggregations/individual?stage=&window=` | Individual deals in bundles |
| GET | `/api/reconciliation?window=` | Reconciliation rows |
| GET | `/api/live` | Live feed pause state |
| POST | `/api/live/pause` | Pause the live feed |
| POST | `/api/live/resume` | Resume the live feed |

Time window values: `1m`, `15m`, `30m`, `1h`, `24h`, `today`

---

## Notes

- The `.azure/` directory (Terraform state + secrets) is excluded from git — each deployment environment maintains its own state locally
- Re-running `azd up` is safe — Terraform is idempotent and the seed job uses `ON CONFLICT DO NOTHING`
- The live feed runs automatically on startup and simulates 5 new deals every 5 seconds
