/**
 * GET /api/deals/list
 *
 * Returns up to 100 deals matching the requested filter, enriched with
 * delivery urgency and last-seen system info so the UI can show "what is
 * missing / broken" at a glance.
 *
 * Query params:
 *   filter   : 'critical_at_risk' | 'in_flight' | 'stuck' | 'not_completed'
 *              | 'failed' | 'all'   (default: 'all')
 *   systemId : number  (optional – scope failed/all to one system)
 *   window   : same window strings as /api/dashboard  (default: '10m')
 */
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

function windowSql(cfg: ReturnType<typeof parseWindow>): string {
  return cfg.useToday
    ? `created_at >= date_trunc('day', NOW())`
    : `created_at >= NOW() - INTERVAL '${cfg.interval}'`;
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const windowParam = typeof req.query.window   === 'string' ? req.query.window   : '10m';
  const filter      = typeof req.query.filter   === 'string' ? req.query.filter   : 'all';
  const rawSysId    = typeof req.query.systemId === 'string' ? parseInt(req.query.systemId, 10) : null;
  const systemId    = rawSysId && !isNaN(rawSysId) ? rawSysId : null;

  const cfg = parseWindow(windowParam);
  const wSql = windowSql(cfg);

  try {
    const systemsRes = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM systems ORDER BY id`,
    );
    const vatpId  = systemsRes.rows.find((s) => s.name === 'VAT-P')?.id;
    const paceId  = systemsRes.rows.find((s) => s.name === 'PACE')?.id;
    const neonId  = systemsRes.rows.find((s) => s.name === 'NEON')?.id;
    const endurId = systemsRes.rows.find((s) => s.name === 'Endur')?.id;
    const sysName = systemId ? (systemsRes.rows.find((s) => s.id === systemId)?.name ?? 'Unknown') : null;

    // gap filter params
    const rawFromId = typeof req.query.fromSystemId === 'string' ? parseInt(req.query.fromSystemId, 10) : null;
    const rawToId   = typeof req.query.toSystemId   === 'string' ? parseInt(req.query.toSystemId,   10) : null;
    const fromSysId = rawFromId && !isNaN(rawFromId) ? rawFromId : null;
    const toSysId   = rawToId   && !isNaN(rawToId)   ? rawToId   : null;

    // ── Build the "candidates" subquery (which correlation_ids to include) ──
    let candidatesSql: string;
    let label: string;

    switch (filter) {
      case 'critical_at_risk':
        if (systemId) {
          // Match the reconciliation query exactly: scope to deals that entered VAT-P
          // within the selected window, are critical (delivery ≤ 2h), and whose
          // last-seen system (excluding PACE) is the clicked system.
          label = `⚡ Critical stuck at ${sysName}`;
          candidatesSql = `
            WITH vatp_window AS (
              SELECT DISTINCT correlation_id FROM deal_journey
              WHERE system_id = ${vatpId} AND ${wSql}
            ),
            critical_ids AS (
              SELECT DISTINCT d.correlation_id
              FROM deals d
              JOIN vatp_window vw ON vw.correlation_id = d.correlation_id
              WHERE d.delivery_start <= NOW() + INTERVAL '2 hours'
                AND d.delivery_start >= NOW() - INTERVAL '1 hour'
                AND d.correlation_id NOT IN (
                  SELECT DISTINCT correlation_id FROM deal_journey
                  WHERE system_id = ${neonId} AND status = 'processed'
                )
            ),
            last_seen AS (
              SELECT DISTINCT ON (dj.correlation_id)
                dj.correlation_id,
                dj.system_id
              FROM deal_journey dj
              JOIN critical_ids ci ON dj.correlation_id = ci.correlation_id
              WHERE dj.system_id != ${paceId}
              ORDER BY dj.correlation_id, dj.created_at DESC
            )
            SELECT correlation_id FROM last_seen
            WHERE system_id = ${systemId}`;
        } else {
          label = '⚡ Deals with delivery ≤ 2 h not yet in NEON';
          candidatesSql = `
            SELECT DISTINCT correlation_id FROM deals
            WHERE delivery_start <= NOW() + INTERVAL '2 hours'
              AND delivery_start >= NOW() - INTERVAL '1 hour'
              AND correlation_id NOT IN (
                SELECT DISTINCT correlation_id FROM deal_journey
                WHERE system_id = ${neonId} AND status = 'processed'
              )`;
        }
        break;

      case 'in_flight':
        label = 'In-flight deals (entered today, not yet in Endur)';
        candidatesSql = `
          SELECT DISTINCT correlation_id FROM deal_journey
          WHERE system_id = ${vatpId}
            AND created_at >= date_trunc('day', NOW())
            AND correlation_id NOT IN (
              SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = ${endurId}
            )`;
        break;

      case 'stuck':
        label = 'Stuck deals (in-flight and no progress for > 15 min)';
        candidatesSql = `
          SELECT correlation_id FROM (
            SELECT DISTINCT correlation_id, MIN(created_at) AS entered_at
            FROM deal_journey
            WHERE system_id = ${vatpId}
              AND created_at >= date_trunc('day', NOW())
            GROUP BY correlation_id
          ) sub
          WHERE NOW() - entered_at > INTERVAL '15 minutes'
            AND correlation_id NOT IN (
              SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = ${endurId}
            )`;
        break;

      case 'not_completed':
        label = 'Deals entered today not yet completed in Endur';
        candidatesSql = `
          SELECT DISTINCT correlation_id FROM deal_journey
          WHERE system_id = ${vatpId}
            AND created_at >= date_trunc('day', NOW())
            AND correlation_id NOT IN (
              SELECT DISTINCT correlation_id FROM deal_journey
              WHERE system_id = ${endurId} AND status = 'processed'
            )`;
        break;

      case 'failed':
        label = systemId
          ? `Failed deals at ${sysName} (${windowParam})`
          : `All failed deals (${windowParam})`;
        if (systemId) {
          // Anchor to deals that entered VAT-P in the window (same as reconciliation)
          // then look at the latest status for the requested system.
          candidatesSql = `
            WITH vatp_window AS (
              SELECT DISTINCT correlation_id FROM deal_journey
              WHERE system_id = ${vatpId} AND ${wSql}
            ),
            latest_status AS (
              SELECT DISTINCT ON (dj.correlation_id)
                dj.correlation_id,
                dj.status
              FROM deal_journey dj
              JOIN vatp_window vw ON dj.correlation_id = vw.correlation_id
              WHERE dj.system_id = ${systemId}
              ORDER BY dj.correlation_id, dj.created_at DESC
            )
            SELECT correlation_id FROM latest_status
            WHERE status IN ('failed', 'rejected')`;
        } else {
          candidatesSql = `
            WITH vatp_window AS (
              SELECT DISTINCT correlation_id FROM deal_journey
              WHERE system_id = ${vatpId} AND ${wSql}
            ),
            latest_status AS (
              SELECT DISTINCT ON (dj.correlation_id, dj.system_id)
                dj.correlation_id,
                dj.status
              FROM deal_journey dj
              JOIN vatp_window vw ON dj.correlation_id = vw.correlation_id
              ORDER BY dj.correlation_id, dj.system_id, dj.created_at DESC
            )
            SELECT DISTINCT correlation_id FROM latest_status
            WHERE status IN ('failed', 'rejected')`;
        }
        break;

      default: // 'all'
        label = systemId
          ? `All deals at ${sysName} (${windowParam})`
          : `All deals (${windowParam})`;
        if (systemId) {
          // Anchor to deals that entered VAT-P in the window (same as reconciliation
          // total_deals), then confirm a record exists at the requested system.
          candidatesSql = `
            WITH vatp_window AS (
              SELECT DISTINCT correlation_id FROM deal_journey
              WHERE system_id = ${vatpId} AND ${wSql}
            )
            SELECT DISTINCT dj.correlation_id
            FROM deal_journey dj
            JOIN vatp_window vw ON dj.correlation_id = vw.correlation_id
            WHERE dj.system_id = ${systemId}`;
        } else {
          candidatesSql = `
            SELECT DISTINCT correlation_id FROM deal_journey
            WHERE ${wSql}`;
        }
        break;

      case 'gap': {
        const fromName = fromSysId ? (systemsRes.rows.find((s) => s.id === fromSysId)?.name ?? '?') : '?';
        const toName   = toSysId   ? (systemsRes.rows.find((s) => s.id === toSysId)?.name   ?? '?') : '?';
        label = `⚠ Gap: processed at ${fromName}, not yet at ${toName}`;
        candidatesSql = `
          SELECT DISTINCT dj.correlation_id FROM deal_journey dj
          WHERE dj.correlation_id IN (
            SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = ${vatpId} AND ${wSql}
          )
          AND dj.system_id = ${fromSysId} AND dj.status = 'processed'
          AND dj.correlation_id NOT IN (
            SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = ${toSysId}
          )`;
        break;
      }
    }

    // ── Total count (before LIMIT) ──
    const countRes = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM (${candidatesSql}) sub`,
    );
    const totalCount = parseInt(countRes.rows[0].total, 10);

    // ── Main query: enrich each candidate deal ──
    const { rows } = await pool.query<{
      correlation_id: string;
      volume_mwh: string;
      entered_at: Date;
      delivery_start: Date | null;
      mins_until_delivery: number | null;
      last_system: string;
      last_status: string;
      error_message: string | null;
      is_completed: boolean;
      is_critical: boolean;
    }>(`
      WITH candidates AS (${candidatesSql}),
      deal_info AS (
        SELECT d.correlation_id, d.volume_mwh, d.delivery_start, d.created_at AS entered_at
        FROM deals d
        JOIN candidates c ON d.correlation_id = c.correlation_id
      ),
      last_event AS (
        SELECT DISTINCT ON (dj.correlation_id)
          dj.correlation_id,
          s.name   AS last_system,
          dj.status AS last_status,
          dj.error_message
        FROM deal_journey dj
        JOIN systems s ON s.id = dj.system_id
        JOIN candidates c ON dj.correlation_id = c.correlation_id
        ORDER BY dj.correlation_id, dj.created_at DESC
      ),
      completed AS (
        SELECT DISTINCT correlation_id FROM deal_journey
        WHERE system_id = ${endurId} AND status = 'processed'
      )
      SELECT
        f.correlation_id,
        f.volume_mwh::float            AS volume_mwh,
        f.entered_at,
        f.delivery_start,
        CASE WHEN f.delivery_start IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (f.delivery_start - NOW())) / 60)::int
          ELSE NULL END                AS mins_until_delivery,
        l.last_system,
        l.last_status,
        l.error_message,
        (comp.correlation_id IS NOT NULL)                          AS is_completed,
        (f.delivery_start IS NOT NULL
         AND f.delivery_start <= NOW() + INTERVAL '2 hours'
         AND f.delivery_start >= NOW() - INTERVAL '1 hour'
         AND comp.correlation_id IS NULL)                          AS is_critical
      FROM deal_info f
      JOIN last_event  l    ON l.correlation_id = f.correlation_id
      LEFT JOIN completed comp ON comp.correlation_id = f.correlation_id
      ORDER BY
        is_critical DESC NULLS LAST,
        f.delivery_start ASC NULLS LAST,
        f.entered_at DESC
      LIMIT 100
    `);

    res.json({
      filter,
      systemId,
      label,
      total: totalCount,
      deals: rows.map((r) => ({
        correlationId:      r.correlation_id,
        volumeMwh:          parseFloat(r.volume_mwh as unknown as string),
        enteredAt:          r.entered_at,
        deliveryStart:      r.delivery_start ?? null,
        minsUntilDelivery:  r.mins_until_delivery ?? null,
        lastSystem:         r.last_system,
        lastStatus:         r.last_status,
        errorMessage:       r.error_message ?? null,
        isCompleted:        r.is_completed,
        isCritical:         r.is_critical,
      })),
    });
  } catch (err) {
    console.error('Deal list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
