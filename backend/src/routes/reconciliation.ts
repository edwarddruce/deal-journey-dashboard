import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

function parseWindow(w: string): { interval: string | null; useToday: boolean } {
  switch (w) {
    case '1m':    return { interval: '1 minute',   useToday: false };
    case '15m':   return { interval: '15 minutes', useToday: false };
    case '30m':   return { interval: '30 minutes', useToday: false };
    case '1h':    return { interval: '1 hour',     useToday: false };
    case '24h':   return { interval: '24 hours',   useToday: false };
    case 'today': return { interval: null,          useToday: true  };
    default:      return { interval: '10 minutes', useToday: false };
  }
}

function windowFilter(cfg: ReturnType<typeof parseWindow>): string {
  return cfg.useToday
    ? `created_at >= date_trunc('day', NOW())`
    : `created_at >= NOW() - INTERVAL '${cfg.interval}'`;
}

/**
 * GET /api/reconciliation?window=10m
 *
 * Returns per-system deal counts and status breakdowns for the selected window,
 * plus the delta (drop) between each successive system in the pipeline.
 * This lets operators see exactly where deals are being lost in the journey.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const windowParam = typeof req.query.window === 'string' ? req.query.window : '10m';
  const cfg = parseWindow(windowParam);
  const wf = windowFilter(cfg);

  try {
    const [systemsRes, dealsBySystemRes, criticalBySystemRes] = await Promise.all([
      pool.query<{ id: number; name: string; status: string }>(
        `SELECT id, name, status FROM systems
         ORDER BY CASE name WHEN 'VAT-P' THEN 1 WHEN 'PACE' THEN 2 WHEN 'NEON' THEN 3 WHEN 'Endur' THEN 4 ELSE 5 END`,
      ),
      pool.query<{
        system_id: number;
        total_deals: string;
        processed: string;
        failed: string;
        pending: string;
      }>(
        `SELECT
           system_id,
           COUNT(*)                                                       AS total_deals,
           COUNT(*) FILTER (WHERE status = 'processed')                   AS processed,
           COUNT(*) FILTER (WHERE status IN ('failed', 'rejected'))       AS failed,
           COUNT(*) FILTER (WHERE status = 'pending')                     AS pending
         FROM (
           SELECT DISTINCT ON (dj.correlation_id, dj.system_id)
             dj.correlation_id, dj.system_id, dj.status
           FROM deal_journey dj
           WHERE dj.correlation_id IN (
             SELECT DISTINCT correlation_id FROM deal_journey
             WHERE system_id = (SELECT id FROM systems WHERE name = 'VAT-P') AND ${wf}
           )
           ORDER BY dj.correlation_id, dj.system_id, dj.created_at DESC
         ) deduped
         GROUP BY system_id`,
      ),
      // Critical deals: delivery window opens within 2 h, last seen at each system,
      // anchored to deals that entered PACE within the selected window so the count
      // never exceeds the deal count shown on each card.
      pool.query<{ system_id: number; critical_stuck: string }>(
        `WITH vatp_window AS (
           SELECT DISTINCT correlation_id FROM deal_journey
           WHERE system_id = (SELECT id FROM systems WHERE name = 'VAT-P')
             AND ${wf}
         ),
         critical_ids AS (
           SELECT DISTINCT d.correlation_id
           FROM deals d
           JOIN vatp_window pw ON pw.correlation_id = d.correlation_id
           WHERE d.delivery_start <= NOW() + INTERVAL '2 hours'
             AND d.delivery_start >= NOW() - INTERVAL '1 hour'
             AND d.correlation_id NOT IN (
               SELECT DISTINCT correlation_id FROM deal_journey
               WHERE status = 'processed'
                 AND system_id = (SELECT id FROM systems WHERE name = 'NEON')
             )
         ),
         last_seen AS (
           SELECT DISTINCT ON (dj.correlation_id)
             dj.correlation_id,
             dj.system_id
           FROM deal_journey dj
           JOIN critical_ids ci ON dj.correlation_id = ci.correlation_id
           WHERE dj.system_id != (SELECT id FROM systems WHERE name = 'PACE')
           ORDER BY dj.correlation_id, dj.created_at DESC
         )
         SELECT system_id, COUNT(*) AS critical_stuck
         FROM last_seen
         GROUP BY system_id`,
      ),
    ]);

    const countMap = new Map<number, {
      totalDeals: number; processed: number;
      failed: number; pending: number;
    }>();

    for (const row of dealsBySystemRes.rows) {
      countMap.set(Number(row.system_id), {
        totalDeals: parseInt(row.total_deals, 10),
        processed:  parseInt(row.processed,   10),
        failed:     parseInt(row.failed,      10),
        pending:    parseInt(row.pending,     10),
      });
    }

    const criticalMap = new Map<number, number>();
    for (const row of criticalBySystemRes.rows) {
      criticalMap.set(Number(row.system_id), parseInt(row.critical_stuck, 10));
    }

    const systems = systemsRes.rows.map((s, i) => {
      const counts = countMap.get(s.id) ?? {
        totalDeals: 0, processed: 0, failed: 0, pending: 0,
      };
      const prevCount = i > 0
        ? (countMap.get(systemsRes.rows[i - 1].id)?.totalDeals ?? null)
        : null;

      const delta = prevCount !== null ? prevCount - counts.totalDeals : null;
      const deltaPct = prevCount !== null && prevCount > 0
        ? parseFloat((((prevCount - counts.totalDeals) / prevCount) * 100).toFixed(1))
        : null;

      return {
        id:       s.id,
        name:     s.name,
        status:   s.status,
        totalDeals: counts.totalDeals,
        processed:  counts.processed,
        failed:     counts.failed,
        pending:    counts.pending,
        criticalStuck: criticalMap.get(s.id) ?? 0,
        deltaFromPrevious:    delta,
        deltaFromPreviousPct: deltaPct,
      };
    });

    // End-to-end summary: VAT-P total (entry point) vs Endur total (book of record)
    const vatpTotal  = systems[0]?.totalDeals ?? 0;
    const endurTotal = systems[systems.length - 1]?.totalDeals ?? 0;
    const totalLoss  = vatpTotal - endurTotal;
    const totalLossPct = vatpTotal > 0
      ? parseFloat(((totalLoss / vatpTotal) * 100).toFixed(1))
      : 0;

    res.json({ window: windowParam, systems, vatpTotal, endurTotal, totalLoss, totalLossPct });
  } catch (err) {
    console.error('Reconciliation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
