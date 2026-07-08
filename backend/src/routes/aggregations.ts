import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

// Window filter for deal_aggregations rows.
// Uses created_at (= actual deal processing time stored per row) to match
// the selected display window. window_start is the 1-hour aggregation slot
// kept for bundle lookup, NOT for time filtering.
function windowFilter(w: string, alias = 'da'): string {
  const col = `${alias}.created_at`;
  switch (w) {
    case '1m':    return `${col} >= NOW() - INTERVAL '1 minute'`;
    case '15m':   return `${col} >= NOW() - INTERVAL '15 minutes'`;
    case '30m':   return `${col} >= NOW() - INTERVAL '30 minutes'`;
    case '1h':    return `${col} >= NOW() - INTERVAL '1 hour'`;
    case '24h':   return `${col} >= NOW() - INTERVAL '24 hours'`;
    case 'today': return `${col} >= date_trunc('day', NOW())`;
    default:      return `${col} >= NOW() - INTERVAL '10 minutes'`;
  }
}

  // Window filter for the deal_journey table (has created_at, not window_start).
function windowFilterDeals(w: string, alias = 'dj'): string {
  const col = `${alias}.created_at`;
  switch (w) {
    case '1m':    return `${col} >= NOW() - INTERVAL '1 minute'`;
    case '15m':   return `${col} >= NOW() - INTERVAL '15 minutes'`;
    case '30m':   return `${col} >= NOW() - INTERVAL '30 minutes'`;
    case '1h':    return `${col} >= NOW() - INTERVAL '1 hour'`;
    case '24h':   return `${col} >= NOW() - INTERVAL '24 hours'`;
    case 'today': return `${col} >= date_trunc('day', NOW())`;
    default:      return `${col} >= NOW() - INTERVAL '10 minutes'`;
  }
}

// GET /api/aggregations/summary?window=10m
router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  const w = typeof req.query.window === 'string' ? req.query.window : '10m';
  const wf = windowFilter(w);

  try {
    const result = await pool.query<{
      stage: string;
      bundle_count: string;
      deals_covered: string;
      avg_bundle_size: string;
    }>(`
      SELECT
        stage,
        COUNT(DISTINCT agg_id)::text                                                        AS bundle_count,
        COUNT(*)::text                                                                       AS deals_covered,
        ROUND(COUNT(*)::decimal / NULLIF(COUNT(DISTINCT agg_id), 0), 1)::text               AS avg_bundle_size
      FROM deal_aggregations da
      WHERE ${wf}
      GROUP BY stage
    `);

    const vatpNeon  = result.rows.find((r) => r.stage === 'vat_p_neon');
    const neonEndur = result.rows.find((r) => r.stage === 'neon_endur');

    res.json({
      window: w,
      vatpToNeon: {
        bundles:      vatpNeon  ? parseInt(vatpNeon.bundle_count,   10) : 0,
        dealsCovered: vatpNeon  ? parseInt(vatpNeon.deals_covered,  10) : 0,
        avgBundleSize:vatpNeon  ? parseFloat(vatpNeon.avg_bundle_size)  : 0,
      },
      neonToEndur: {
        bundles:      neonEndur ? parseInt(neonEndur.bundle_count,   10) : 0,
        dealsCovered: neonEndur ? parseInt(neonEndur.deals_covered,  10) : 0,
        avgBundleSize:neonEndur ? parseFloat(neonEndur.avg_bundle_size)  : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

// GET /api/aggregations/bundles?stage=vat_p_neon&window=10m
// Returns bundle list with summary (deal count, MWh, delivery day)
router.get('/bundles', async (req: Request, res: Response): Promise<void> => {
  const w     = typeof req.query.window === 'string' ? req.query.window : '10m';
  const stage = typeof req.query.stage  === 'string' ? req.query.stage  : 'vat_p_neon';

  if (!['vat_p_neon', 'neon_endur'].includes(stage)) {
    res.status(400).json({ error: 'Invalid stage. Use vat_p_neon or neon_endur' });
    return;
  }

  const wf = windowFilter(w);

  try {
    // Use CTE to get one row per (agg_id, correlation_id) — most recent system status.
    // Also join the target system's deal events to derive the bundle-level status
    // (all members share the same fate after harmonisation).
    const targetSysName = stage === 'vat_p_neon' ? 'NEON' : 'Endur';
    const bundlesRes = await pool.query<{
      agg_id: string;
      delivery_day: string | null;
      delivery_period: string | null;
      product: string | null;
      counterparty: string | null;
      deal_count: string;
      total_mwh: string;
      min_delivery: string | null;
      bundle_status: string;
    }>(`
      WITH bundle_deals AS (
        SELECT DISTINCT ON (da.agg_id, da.correlation_id)
          da.agg_id,
          da.delivery_day,
          da.delivery_period,
          da.product,
          da.counterparty,
          d.volume_mwh,
          d.delivery_start
        FROM deal_aggregations da
        JOIN deals d ON d.correlation_id = da.correlation_id
        WHERE da.stage = $1
          AND ${wf}
        ORDER BY da.agg_id, da.correlation_id, d.created_at DESC
      ),
      bundle_target AS (
        -- Get the status of each bundle at the target system.
        -- After harmonisation every member has the same status, so any one row suffices.
        SELECT DISTINCT ON (da.agg_id)
          da.agg_id,
          dj.status AS bundle_status
        FROM deal_aggregations da
        JOIN systems ts ON ts.name = $2
        JOIN deal_journey dj ON dj.correlation_id = da.correlation_id AND dj.system_id = ts.id
        WHERE da.stage = $1
          AND ${wf}
        ORDER BY da.agg_id, dj.created_at DESC
      )
      SELECT
        bd.agg_id,
        MIN(bd.delivery_day)::text            AS delivery_day,
        MIN(bd.delivery_period)::text         AS delivery_period,
        MIN(bd.product)                       AS product,
        MIN(bd.counterparty)                  AS counterparty,
        COUNT(*)::text                        AS deal_count,
        COALESCE(SUM(bd.volume_mwh), 0)::text AS total_mwh,
        MIN(bd.delivery_start)::text          AS min_delivery,
        COALESCE(MIN(bt.bundle_status), 'pending') AS bundle_status
      FROM bundle_deals bd
      LEFT JOIN bundle_target bt ON bt.agg_id = bd.agg_id
      GROUP BY bd.agg_id
      ORDER BY MIN(bd.delivery_period) ASC NULLS LAST, COUNT(*) DESC
      LIMIT 200
    `, [stage, targetSysName]);

    res.json({
      stage,
      window: w,
      bundles: bundlesRes.rows.map((b) => ({
        aggId:            b.agg_id,
        deliveryDay:      b.delivery_day,
        deliveryPeriod:   b.delivery_period,
        product:          b.product,
        counterparty:     b.counterparty,
        dealCount:        parseInt(b.deal_count, 10),
        totalMwh:         parseFloat(b.total_mwh),
        earliestDelivery: b.min_delivery,
        bundleStatus:     b.bundle_status as 'processed' | 'failed' | 'pending',
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

// GET /api/aggregations/bundle/:aggId?window=10m
// Returns the individual deals inside one aggregation bundle, filtered to the same time window
router.get('/bundle/:aggId', async (req: Request, res: Response): Promise<void> => {
  const { aggId } = req.params;
  const w = typeof req.query.window === 'string' ? req.query.window : '10m';
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(aggId)) {
    res.status(400).json({ error: 'Invalid aggId format' });
    return;
  }

  const wf = windowFilter(w, 'da');

  try {
    const result = await pool.query<{
      correlation_id: string;
      volume_mwh: string;
      delivery_start: string | null;
      status: string;
      system_name: string;
    }>(`
      SELECT DISTINCT ON (da.correlation_id)
        da.correlation_id,
        d.volume_mwh::text,
        d.delivery_start::text,
        COALESCE(td.status, 'pending')  AS status,
        ts.name                         AS system_name
      FROM deal_aggregations da
      -- Metadata (volume/delivery) from any deal event — pick the earliest for consistency
      JOIN deals d   ON d.correlation_id = da.correlation_id
      -- The target system for this bundle's stage
      JOIN systems ts ON ts.name = CASE WHEN da.stage = 'vat_p_neon' THEN 'NEON' ELSE 'Endur' END
      -- The deal's event specifically at the target system (NULL if not yet reached)
      LEFT JOIN deal_journey td ON td.correlation_id = da.correlation_id
                         AND td.system_id     = ts.id
      WHERE da.agg_id = $1
        AND ${wf}
      ORDER BY da.correlation_id, d.created_at ASC
    `, [aggId]);

    // Bundle status: after harmonisation all members share the same status.
    // Derive from the result set directly (no extra query needed).
    const statuses = result.rows.map((r) => r.status);
    const bundleStatus: string =
      statuses.length === 0               ? 'pending' :
      statuses.some((s) => s === 'failed') ? 'failed'  :
      statuses.every((s) => s === 'processed') ? 'processed' : 'pending';

    res.json({
      aggId,
      bundleStatus,
      deals: result.rows.map((r) => {
        const delivMs = r.delivery_start ? new Date(r.delivery_start).getTime() - Date.now() : null;
        return {
          correlationId:     r.correlation_id,
          volumeMwh:         parseFloat(r.volume_mwh),
          deliveryStart:     r.delivery_start,
          minsUntilDelivery: delivMs !== null ? Math.round(delivMs / 60_000) : null,
          status:            r.status,
          lastSystem:        r.system_name,
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

// GET /api/aggregations/individual?stage=vat_p_neon&window=10m
// Returns deals at the source system that are NOT in any bundle for this stage+window
router.get('/individual', async (req: Request, res: Response): Promise<void> => {
  const w     = typeof req.query.window === 'string' ? req.query.window : '10m';
  const stage = typeof req.query.stage  === 'string' ? req.query.stage  : 'vat_p_neon';

  if (!['vat_p_neon', 'neon_endur'].includes(stage)) {
    res.status(400).json({ error: 'Invalid stage. Use vat_p_neon or neon_endur' });
    return;
  }

  const sourceSystem = stage === 'vat_p_neon' ? 'VAT-P' : 'NEON';
  const wfDeals = windowFilterDeals(w, 'dj');  // deal_journey uses created_at
  const wfAgg   = windowFilter(w, 'da');       // deal_aggregations uses window_start (or created_at fallback)

  try {
    const candidateSql = `
      SELECT DISTINCT ON (dj.correlation_id)
        dj.correlation_id,
        d.volume_mwh::text,
        d.delivery_start::text,
        dj.status,
        s.name AS system_name
      FROM deal_journey dj
      JOIN deals d ON d.correlation_id = dj.correlation_id
      JOIN systems s ON s.id = dj.system_id
      WHERE s.name = $1
        AND ${wfDeals}
        AND dj.correlation_id NOT IN (
          SELECT DISTINCT da.correlation_id
          FROM deal_aggregations da
          WHERE da.stage = $2
            AND ${wfAgg}
        )
      ORDER BY dj.correlation_id, dj.created_at DESC
    `;

    const countRes = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM (${candidateSql}) sub`,
      [sourceSystem, stage],
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const result = await pool.query<{
      correlation_id: string;
      volume_mwh: string;
      delivery_start: string | null;
      status: string;
      system_name: string;
    }>(`${candidateSql} LIMIT 200`, [sourceSystem, stage]);

    res.json({
      stage,
      window: w,
      total,
      deals: result.rows.map((r) => {
        const delivMs = r.delivery_start ? new Date(r.delivery_start).getTime() - Date.now() : null;
        return {
          correlationId:     r.correlation_id,
          volumeMwh:         parseFloat(r.volume_mwh),
          deliveryStart:     r.delivery_start,
          minsUntilDelivery: delivMs !== null ? Math.round(delivMs / 60_000) : null,
          status:            r.status,
          lastSystem:        r.system_name,
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

export default router;
