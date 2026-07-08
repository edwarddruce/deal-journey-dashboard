export type SystemStatus = 'online' | 'degraded' | 'offline';

export interface MiddlewareComponent {
  name: string;
  messagesIn: number | null;
  messagesOut: number | null;
  status: SystemStatus;
}

export interface PipelineSystem {
  id: number;
  name: string;
  status: SystemStatus;
  dealCount: number;
  positionMwh: number;          // energy volume flowing through this system in the window
  successRate: number | null;   // % of deals processed successfully
  failedCount: number;
  gapToNext: number;            // processed deals here that have no row at the next system
  middleware: MiddlewareComponent[];
}

export interface DashboardSummary {
  totalDeals: number;           // distinct deals entering VAT-P in the window
  gridPositionMwh: number;      // total MWh entering PACE in the window (grid commitment)
  completionRate: number | null; // % of today's deals reaching Endur
  inFlight: number;             // deals not yet at Endur today
  stuck: number;                // in-flight deals not progressed for > 15 min
  criticalAtRisk: number;       // deals with delivery_start ≤ NOW()+2h not yet in Endur
  overallStatus: SystemStatus;
  systemsOnline: number;
  systemsTotal: number;
  middlewareOnline: number;
  middlewareTotal: number;
}

export type ChartDataPoint = Record<string, number | string>;

// Delivery chart: one entry per hour with a `label` key plus one key per system (snake_case)
export type DeliveryChartPoint = Record<string, string | number>;

export interface DashboardData {
  summary: DashboardSummary;
  pipeline: PipelineSystem[];
  chart: ChartDataPoint[];
  deliveryChart: DeliveryChartPoint[];
}

export type TimeWindow = '1m' | '10m' | '15m' | '30m' | '1h' | '24h' | 'today';

// ── Aggregation types ────────────────────────────────────────────────────────

export type AggStage = 'vat_p_neon' | 'neon_endur';

export interface AggStageSummary {
  bundles: number;
  dealsCovered: number;
  avgBundleSize: number;
}

export interface AggregationSummary {
  window: string;
  vatpToNeon: AggStageSummary;
  neonToEndur: AggStageSummary;
}

export interface AggBundle {
  aggId: string;
  deliveryDay: string | null;
  deliveryPeriod: string | null;   // ISO timestamp of 30-min slot start
  product: string | null;
  counterparty: string | null;
  dealCount: number;
  totalMwh: number;
  earliestDelivery: string | null;
  bundleStatus: 'processed' | 'failed' | 'pending';
}

export interface AggBundleDeal {
  correlationId: string;
  volumeMwh: number;
  deliveryStart: string | null;
  minsUntilDelivery: number | null;
  status: string;
  lastSystem: string;
}

// Deal journey types (from /api/deal/:id)
export type DealJourneyStatus = 'complete' | 'failed' | 'in_flight';

export interface DealStage {
  systemId: number;
  systemName: string;
  status: 'processed' | 'failed' | 'pending' | 'not_reached';
  errorMessage: string | null;
  volumeMwh: number | null;
  processedAt: string | null;
  lagFromPreviousMs: number | null;
}

export interface DealJourney {
  correlationId: string;
  volumeMwh: number;
  enteredAt: string;
  deliveryStart: string | null;    // when energy must start flowing to the grid
  minsUntilDelivery: number | null; // negative = overdue
  journeyStatus: DealJourneyStatus;
  totalJourneyMs: number | null;
  stages: DealStage[];
}

// Colours assigned per system key (derived from name)
export const SYSTEM_COLORS: Record<string, string> = {
  pace:  '#06b6d4', // teal
  vat_p: '#3b82f6', // blue
  neon:  '#10b981', // green
  endur: '#8b5cf6', // purple
  total: '#f97316', // orange
};

export interface ReconciliationRow {
  id: number;
  name: string;
  status: SystemStatus;
  totalDeals: number;
  processed: number;
  failed: number;
  pending: number;
  criticalStuck: number;           // critical-delivery deals last seen at this system
  deltaFromPrevious: number | null;
  deltaFromPreviousPct: number | null;
}

export interface ReconciliationData {
  window: string;
  systems: ReconciliationRow[];
  vatpTotal: number;
  endurTotal: number;
  totalLoss: number;
  totalLossPct: number;
}

// ── Drill-down deal list ──────────────────────────────────────────────────────

export type DrillDownFilter =
  | 'critical_at_risk'
  | 'in_flight'
  | 'stuck'
  | 'not_completed'
  | 'failed'
  | 'gap'
  | 'all';

export interface DrillDownRequest {
  filter: DrillDownFilter;
  systemId?: number;
  systemName?: string;
  toSystemId?: number;
  toSystemName?: string;
  label: string;          // human-readable title for the panel header
}

export interface DrillDownDeal {
  correlationId: string;
  volumeMwh: number;
  enteredAt: string;
  deliveryStart: string | null;
  minsUntilDelivery: number | null;
  lastSystem: string;
  lastStatus: string;
  errorMessage: string | null;
  isCompleted: boolean;
  isCritical: boolean;
}

export interface DrillDownResult {
  filter: string;
  label: string;
  total: number;
  deals: DrillDownDeal[];
}
