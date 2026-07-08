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
  // Use the same anchor as the bundles/individual endpoints and the pipeline card:
  //   source system in window → confirmed at target system.
  // This ensures the summary bundle counts shown on the pipeline card match the
  // counts shown in the drill-down panel exactly.
  const wfSrc = windowFilterDeals(w, 'src');

  try {
    const result = await pool.query<{
      stage: string;
      bundle_count: string;
      deals_covered: string;
      avg_bundle_size: string;
    }>(`
      WITH vatp_in_window AS (
        SELECT DISTINCT src.correlation_id FROM deal_journey src
        JOIN systems ss ON ss.id = src.system_id AND ss.name = 'VAT-P'
        WHERE ${wfSrc}
      ),
      neon_in_window AS (
        SELECT DISTINCT src.correlation_id FROM deal_journey src
        JOIN systems ss ON ss.id = src.system_id AND ss.name = 'NEON'
        WHERE ${wfSrc}
      ),
      confirmed_vatp_neon AS (
        SELECT DISTINCT tgt.correlation_id FROM deal_journey tgt
        JOIN systems ts ON ts.id = tgt.system_id AND ts.name = 'NEON'
        WHERE tgt.correlation_id IN (SELECT correlation_id FROM vatp_in_window)
      ),
      confirmed_neon_endur AS (
        SELECT DISTINCT tgt.correlation_id FROM deal_journey tgt
        JOIN systems ts ON ts.id = tgt.system_id AND ts.name = 'Endur'
        WHERE tgt.correlation_id IN (SELECT correlation_id FROM neon_in_window)
      ),
      agg_vatp_neon AS (
        SELECT da.agg_id, da.correlation_id FROM deal_aggregations da
        JOIN confirmed_vatp_neon c ON c.correlation_id = da.correlation_id
        WHERE da.stage = 'vat_p_neon'
      ),
      agg_neon_endur AS (
        SELECT da.agg_id, da.correlation_id FROM deal_aggregations da
        JOIN confirmed_neon_endur c ON c.correlation_id = da.correlation_id
        WHERE da.stage = 'neon_endur'
      )
      SELECT 'vat_p_neon'::text AS stage,
        COUNT(DISTINCT agg_id)::text                                              AS bundle_count,
        COUNT(*)::text                                                            AS deals_covered,
        ROUND(COUNT(*)::decimal / NULLIF(COUNT(DISTINCT agg_id), 0), 1)::text    AS avg_bundle_size
      FROM agg_vatp_neon
      UNION ALL
      SELECT 'neon_endur'::text AS stage,
        COUNT(DISTINCT agg_id)::text                                              AS bundle_count,
        COUNT(*)::text                                                            AS deals_covered,
        ROUND(COUNT(*)::decimal / NULLIF(COUNT(DISTINCT agg_id), 0), 1)::text    AS avg_bundle_size
      FROM agg_neon_endur
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

  // Use the EXACT same anchor as the pipeline card:
  //   1. deals entering the SOURCE system (VAT-P / NEON) in the window
  //   2. that also have a TARGET system (NEON / Endur) deal_journey row
  // This guarantees bundled + individual = target pipeline card count with zero gap.
  const sourceSysName = stage === 'vat_p_neon' ? 'VAT-P' : 'NEON';
  const wfSource = windowFilterDeals(w, 'src');

  try {
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
      WITH source_in_window AS (
        -- Same anchor as the pipeline card: deals entering the source system in the window
        SELECT DISTINCT src.correlation_id
        FROM deal_journey src
        JOIN systems ss ON ss.id = src.system_id AND ss.name = $3
        WHERE ${wfSource}
      ),
      confirmed_at_target AS (
        -- Of those, deals confirmed at the target system (regardless of when target processed them).
        -- This is the identical population the pipeline card counts for NEON/Endur.
        SELECT DISTINCT tgt.correlation_id, tgt.status
        FROM deal_journey tgt
        JOIN systems ts ON ts.id = tgt.system_id AND ts.name = $2
        WHERE tgt.correlation_id IN (SELECT correlation_id FROM source_in_window)
      ),
      bundle_deals AS (
        SELECT DISTINCT ON (da.agg_id, da.correlation_id)
          da.agg_id,
          da.delivery_day,
          da.delivery_period,
          da.product,
          da.counterparty,
          d.volume_mwh,
          d.delivery_start
        FROM deal_aggregations da
        JOIN confirmed_at_target cat ON cat.correlation_id = da.correlation_id
        JOIN deals d ON d.correlation_id = da.correlation_id
        WHERE da.stage = $1
        ORDER BY da.agg_id, da.correlation_id, d.created_at DESC
      ),
      bundle_target AS (
        SELECT DISTINCT ON (da.agg_id)
          da.agg_id,
          cat.status AS bundle_status
        FROM deal_aggregations da
        JOIN confirmed_at_target cat ON cat.correlation_id = da.correlation_id
        WHERE da.stage = $1
        ORDER BY da.agg_id
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
    `, [stage, targetSysName, sourceSysName]);

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

  // Same anchor as bundles and pipeline card: source system in window → confirmed at target.
  const sourceSysName = stage === 'vat_p_neon' ? 'VAT-P' : 'NEON';
  const targetSystem  = stage === 'vat_p_neon' ? 'NEON'  : 'Endur';
  const wfSource = windowFilterDeals(w, 'src');  // filter on source system's created_at

  try {
    const candidateSql = `
      WITH source_in_window AS (
        SELECT DISTINCT src.correlation_id
        FROM deal_journey src
        JOIN systems ss ON ss.id = src.system_id AND ss.name = $3
        WHERE ${wfSource}
      )
      SELECT DISTINCT ON (tgt.correlation_id)
        tgt.correlation_id,
        d.volume_mwh::text,
        d.delivery_start::text,
        tgt.status,
        ts.name AS system_name
      FROM deal_journey tgt
      JOIN deals d ON d.correlation_id = tgt.correlation_id
      JOIN systems ts ON ts.id = tgt.system_id
      WHERE ts.name = $1
        AND tgt.correlation_id IN (SELECT correlation_id FROM source_in_window)
        AND tgt.correlation_id NOT IN (
          SELECT DISTINCT da.correlation_id
          FROM deal_aggregations da
          WHERE da.stage = $2
        )
      ORDER BY tgt.correlation_id, tgt.created_at DESC
    `;

    const countRes = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM (${candidateSql}) sub`,
      [targetSystem, stage, sourceSysName],
    );
    const total = parseInt(countRes.rows[0].total, 10);

    const result = await pool.query<{
      correlation_id: string;
      volume_mwh: string;
      delivery_start: string | null;
      status: string;
      system_name: string;
    }>(`${candidateSql} LIMIT 200`, [targetSystem, stage, sourceSysName]);

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
