import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

function parseWindow(w: string): { interval: string | null; useToday: boolean; bucketSec: number } {
  switch (w) {
    case '1m':    return { interval: '1 minute',   useToday: false, bucketSec: 5    };
    case '15m':   return { interval: '15 minutes', useToday: false, bucketSec: 45   };
    case '30m':   return { interval: '30 minutes', useToday: false, bucketSec: 90   };
    case '1h':    return { interval: '1 hour',     useToday: false, bucketSec: 180  };
    case '24h':   return { interval: '24 hours',   useToday: false, bucketSec: 4320 };
    case 'today': return { interval: null,          useToday: true,  bucketSec: 1800 };
    default:      return { interval: '10 minutes', useToday: false, bucketSec: 30   };
  }
}

function windowFilter(cfg: ReturnType<typeof parseWindow>, alias = ''): string {
  const col = alias ? `${alias}.created_at` : 'created_at';
  return cfg.useToday
    ? `${col} >= date_trunc('day', NOW())`
    : `${col} >= NOW() - INTERVAL '${cfg.interval}'`;
}

/**
 * GET /api/dashboard?window=10m
 *
 * Position semantics (energy trading):
 *   - "Position" = sum of volume_mwh for deals that entered VAT-P in the window.
 *     Each deal is counted ONCE (via VAT-P as the entry point) to avoid
 *     double-counting across stages.
 *   - PACE runs in parallel as a validator: both VAT-P and PACE should report
 *     the same counts. Any divergence = reconciliation issue.
 *   - Per-system position = volume flowing through that system in the window
 *     (a deal contributes its volume to every system it has been processed by).
 *   - Chart = cumulative position building up over the window per system.
 *
 * Completion rate (today):
 *   - Deals that entered VAT-P since midnight and have a 'processed' row in Endur.
 *
 * In-flight:
 *   - Deals that entered VAT-P since midnight but have NOT yet reached Endur (any status).
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const windowParam = typeof req.query.window === 'string' ? req.query.window : '10m';
  const windowCfg = parseWindow(windowParam);
  const { bucketSec } = windowCfg;
  const wf   = windowFilter(windowCfg);
  const wfDj = windowFilter(windowCfg, 'dj');

  try {
    const [systemsRes, mwRes] = await Promise.all([
      pool.query<{ id: number; name: string; status: string }>(
        `SELECT id, name, status FROM systems
         ORDER BY CASE name WHEN 'VAT-P' THEN 1 WHEN 'PACE' THEN 2 WHEN 'NEON' THEN 3 WHEN 'Endur' THEN 4 ELSE 5 END`,
      ),
      pool.query<{
        id: number; system_id: number; name: string;
        messages_in: string | null; messages_out: string | null; status: string;
      }>(`SELECT id, system_id, name, messages_in, messages_out, status
          FROM middleware_components ORDER BY system_id, id`),
    ]);

    // --- KPI 1 & 2: Total distinct deals + grid position in the selected window ---
    // Anchored to VAT-P (entry point) to avoid double-counting.
    const paceId  = systemsRes.rows.find((s) => s.name === 'PACE')?.id;
    const vatpId   = systemsRes.rows.find((s) => s.name === 'VAT-P')?.id;
    const neonId   = systemsRes.rows.find((s) => s.name === 'NEON')?.id;
    const endurId  = systemsRes.rows.find((s) => s.name === 'Endur')?.id;

    const windowSummaryRes = await pool.query<{ total_deals: string; grid_position_mwh: string }>(
      `SELECT
         COUNT(DISTINCT dj.correlation_id) AS total_deals,
         COALESCE(SUM(d.volume_mwh), 0)   AS grid_position_mwh
       FROM deal_journey dj
       JOIN deals d ON d.correlation_id = dj.correlation_id
       WHERE dj.system_id = $1
         AND ${wfDj}`,
      [vatpId],
    );

    // --- KPI 3: Completion rate (today) ---
    // % of deals entering VAT-P today that have a processed Endur event.
    const completionRes = await pool.query<{ total_today: string; completed_today: string }>(
      `WITH today_vatp AS (
         SELECT DISTINCT correlation_id
         FROM deal_journey
         WHERE system_id = $1
           AND created_at >= date_trunc('day', NOW())
       ),
       endur_done AS (
         SELECT DISTINCT dj.correlation_id
         FROM deal_journey dj
         JOIN today_vatp tp ON tp.correlation_id = dj.correlation_id
         WHERE dj.system_id = $2
           AND dj.status = 'processed'
       )
       SELECT
         (SELECT COUNT(*) FROM today_vatp)  AS total_today,
         (SELECT COUNT(*) FROM endur_done)  AS completed_today`,
      [vatpId, endurId],
    );

    // --- KPI 4: In-flight count (today, not yet in Endur with any status) ---
    const inFlightRes = await pool.query<{ in_flight: string; stuck: string }>(
      `WITH today_vatp AS (
         SELECT DISTINCT correlation_id, MIN(created_at) AS entered_at
         FROM deal_journey
         WHERE system_id = $1
           AND created_at >= date_trunc('day', NOW())
         GROUP BY correlation_id
       ),
       reached_endur AS (
         SELECT DISTINCT dj.correlation_id
         FROM deal_journey dj
         JOIN today_vatp tp ON tp.correlation_id = dj.correlation_id
         WHERE dj.system_id = $2
       ),
       in_flight AS (
         SELECT tp.correlation_id, tp.entered_at
         FROM today_vatp tp
         WHERE tp.correlation_id NOT IN (SELECT correlation_id FROM reached_endur)
       )
       SELECT
         COUNT(*)                                                        AS in_flight,
         COUNT(*) FILTER (WHERE NOW() - entered_at > INTERVAL '15 minutes') AS stuck
       FROM in_flight`,
      [vatpId, endurId],
    );

    // --- KPI 5: Critical at-risk deals ---
    // Deals whose delivery window opens within the next 2 h (or just opened)
    // that have NOT yet reached NEON — anchored to deals that entered VAT-P
    // within the selected window (mirrors the pipeline card critical_stuck sum).
    const criticalRes = await pool.query<{ critical_at_risk: string }>(
      `SELECT COUNT(DISTINCT d.correlation_id) AS critical_at_risk
       FROM deals d
       WHERE d.delivery_start <= NOW() + INTERVAL '2 hours'
         AND d.delivery_start >= NOW() - INTERVAL '1 hour'
         AND d.correlation_id IN (
           SELECT DISTINCT correlation_id FROM deal_journey
           WHERE system_id = $1 AND ${wf}
         )
         AND d.correlation_id NOT IN (
           SELECT DISTINCT correlation_id
           FROM deal_journey
           WHERE system_id = $2 AND status = 'processed'
         )`,
      [vatpId, neonId],
    );

    // --- Per-system metrics in the window ---
    const dealsBySystemRes = await pool.query<{
      system_id: number;
      deal_count: string;
      position_mwh: string;
      processed_count: string;
      failed_count: string;
    }>(
      // Anchor to deals that entered VAT-P within the window so downstream
      // systems never exceed VAT-P's count (avoids window-boundary inflation).
      `SELECT
         deduped.system_id,
         COUNT(*)                                                AS deal_count,
         COALESCE(SUM(deduped.volume_mwh), 0)                   AS position_mwh,
         COUNT(*) FILTER (WHERE deduped.status = 'processed')   AS processed_count,
         COUNT(*) FILTER (WHERE deduped.status = 'failed')      AS failed_count
       FROM (
         SELECT DISTINCT ON (dj.correlation_id, dj.system_id)
           dj.correlation_id, dj.system_id, d.volume_mwh, dj.status
         FROM deal_journey dj
         JOIN deals d ON d.correlation_id = dj.correlation_id
         WHERE dj.correlation_id IN (
           SELECT DISTINCT correlation_id FROM deal_journey
           WHERE system_id = $1 AND ${wf}
         )
         ORDER BY dj.correlation_id, dj.system_id, dj.created_at DESC
       ) deduped
       GROUP BY deduped.system_id`,
      [vatpId],
    );

    // --- Chart: cumulative position per system over the window ---
    // Each system's volume is independent (a deal contributes to each system it passes through).
    const chartRes = await pool.query<{ bucket: Date; system_id: number; bucket_volume: string }>(
      `SELECT
         to_timestamp(floor(extract(epoch FROM dj.created_at) / $1) * $1) AS bucket,
         dj.system_id,
         SUM(d.volume_mwh) AS bucket_volume
       FROM deal_journey dj
       JOIN deals d ON d.correlation_id = dj.correlation_id
       WHERE ${wfDj}
         AND dj.status = 'processed'
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      [bucketSec],
    );

    // Build cumulative position series
    const allBuckets = [...new Set(chartRes.rows.map((r) => r.bucket.toISOString()))].sort();
    const cumulative: Record<number, number> = {};
    systemsRes.rows.forEach((s) => (cumulative[s.id] = 0));

    const bucketMap: Record<string, Record<number, number>> = {};
    for (const row of chartRes.rows) {
      const key = row.bucket.toISOString();
      if (!bucketMap[key]) bucketMap[key] = {};
      bucketMap[key][row.system_id] = parseFloat(row.bucket_volume);
    }

    const chartSeries = allBuckets.map((iso) => {
      const label = new Date(iso).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const point: Record<string, number | string> = { time: label };
      // "total" tracks only PACE (the single source of truth for position)
      for (const sys of systemsRes.rows) {
        const delta = bucketMap[iso]?.[sys.id] ?? 0;
        cumulative[sys.id] += delta;
        const key = sys.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        point[key] = Math.round(cumulative[sys.id]);
      }
      // total = VAT-P cumulative (the single source of truth for position)
      point['total'] = point[`vat_p`] ?? 0;
      return point;
    });

    // --- Compose pipeline ---
    const dealMap: Record<number, { deal_count: number; position_mwh: number; processed: number; failed: number }> = {};
    for (const row of dealsBySystemRes.rows) {
      dealMap[row.system_id] = {
        deal_count: parseInt(row.deal_count, 10),
        position_mwh: parseFloat(row.position_mwh),
        processed: parseInt(row.processed_count, 10),
        failed: parseInt(row.failed_count, 10),
      };
    }

    const mwBySystem: Record<number, typeof mwRes.rows> = {};
    for (const mc of mwRes.rows) {
      if (!mwBySystem[mc.system_id]) mwBySystem[mc.system_id] = [];
      mwBySystem[mc.system_id].push(mc);
    }

    // --- Gap counts ---
    // VAT-P+PACE → NEON: deals processed at VAT-P not yet at NEON (shown on the group → NEON arrow)
    // NEON  → Endur: booking pipeline gap
    const gapRes = await pool.query<{
      vatp_neon: string; neon_endur: string;
    }>(
      `WITH pw AS (
         SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = $1 AND ${wf}
       )
       SELECT
         (SELECT COUNT(DISTINCT dj.correlation_id) FROM deal_journey dj JOIN pw ON dj.correlation_id = pw.correlation_id
          WHERE dj.system_id = $1 AND dj.status = 'processed'
            AND dj.correlation_id NOT IN (SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = $2)
         ) AS vatp_neon,
         (SELECT COUNT(DISTINCT dj.correlation_id) FROM deal_journey dj JOIN pw ON dj.correlation_id = pw.correlation_id
          WHERE dj.system_id = $2 AND dj.status = 'processed'
            AND dj.correlation_id NOT IN (SELECT DISTINCT correlation_id FROM deal_journey WHERE system_id = $3)
         ) AS neon_endur`,
      [vatpId, neonId, endurId],
    );
    const gapMap: Record<number, number> = {
      [vatpId!]: parseInt(gapRes.rows[0].vatp_neon,  10),  // VAT-P+PACE group → NEON
      [paceId!]: 0,                                         // PACE shown alongside VAT-P, no own gap
      [neonId!]: parseInt(gapRes.rows[0].neon_endur, 10),
    };

    const pipeline = systemsRes.rows.map((sys) => {
      const dm = dealMap[sys.id];
      const processedCount = dm?.processed ?? 0;
      const totalCount = dm?.deal_count ?? 0;
      const failedCount  = dm?.failed   ?? 0;
      return {
        id: sys.id,
        name: sys.name,
        status: sys.status,
        dealCount: totalCount,
        positionMwh: dm?.position_mwh ?? 0,
        successRate: totalCount > 0 ? (processedCount / totalCount) * 100 : null,
        failedCount,
        gapToNext: gapMap[sys.id] ?? 0,
        middleware: (mwBySystem[sys.id] ?? []).map((mc) => {
        // vatp-inbound-topic (or any VAT-P entry topic): reflect live deal flow
          if (sys.id === vatpId && mc.name === 'vatp-inbound-topic') {
            return {
              name: mc.name,
              messagesIn:  totalCount,
              messagesOut: totalCount,
              status: mc.status,
            };
          }
          // For all other systems: drive inbound/validated/dlq topics from live deal counts
          const dlqName       = `${sys.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-dlq-topic`;
          const inboundName   = `${sys.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-inbound-topic`;
          const validatedName = `${sys.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-validated-topic`;
          const offtakeName   = `${sys.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-offtake-topic`;
          if (mc.name === dlqName) {
            const dlqCount = failedCount;
            return { name: mc.name, messagesIn: dlqCount, messagesOut: 0,
              status: dlqCount > 0 ? 'degraded' : 'online' };
          }
          if (mc.name === inboundName) {
            return { name: mc.name, messagesIn: totalCount, messagesOut: totalCount,
              status: mc.status };
          }
          if (mc.name === validatedName || mc.name === offtakeName) {
            return { name: mc.name, messagesIn: totalCount, messagesOut: processedCount,
              status: mc.status };
          }
          return {
            name: mc.name,
            messagesIn:  mc.messages_in  !== null ? parseInt(mc.messages_in,  10) : null,
            messagesOut: mc.messages_out !== null ? parseInt(mc.messages_out, 10) : null,
            status: mc.status,
          };
        }),
      };
    });

    // --- Delivery chart: volume (MWh) by delivery hour × system, next 48 h ---
    // Deduplicates per (correlation_id, system_id) then sums volume per delivery hour.
    // Pre-filter deal_journey to only the correlation_ids with upcoming deliveries to
    // avoid a full table scan.
    const deliveryChartRes = await pool.query<{
      delivery_hour: Date; system_name: string; total_mwh: string;
    }>(
      `SELECT
         date_trunc('hour', d.delivery_start) AS delivery_hour,
         s.name                                AS system_name,
         SUM(d.volume_mwh)                     AS total_mwh
       FROM (
         SELECT DISTINCT ON (dj.correlation_id, dj.system_id)
           dj.correlation_id, dj.system_id, dj.status
         FROM deal_journey dj
         WHERE dj.correlation_id IN (
           SELECT correlation_id FROM deals
           WHERE delivery_start >= NOW()
             AND delivery_start <  NOW() + INTERVAL '48 hours'
         )
         ORDER BY dj.correlation_id, dj.system_id, dj.created_at DESC
       ) deduped
       JOIN deals  d ON d.correlation_id = deduped.correlation_id
       JOIN systems s ON s.id             = deduped.system_id
       WHERE d.delivery_start IS NOT NULL
         AND d.delivery_start >= NOW()
         AND d.delivery_start <  NOW() + INTERVAL '48 hours'
         AND deduped.status = 'processed'
       GROUP BY 1, 2
       ORDER BY 1, 2`,
    );

    // Pivot: collect ordered labels and build one object per hour
    const dcLabels: string[] = [];
    const dcMap = new Map<string, Record<string, number>>();
    for (const row of deliveryChartRes.rows) {
      const dt  = new Date(row.delivery_hour);
      const day  = dt.toLocaleDateString('en-GB', { weekday: 'short' });
      const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const label = `${day} ${time}`;
      const sysKey = row.system_name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      if (!dcMap.has(label)) { dcMap.set(label, {}); dcLabels.push(label); }
      dcMap.get(label)![sysKey] = Math.round(parseFloat(row.total_mwh));
    }
    const deliveryChart = dcLabels.map((label) => ({ label, ...dcMap.get(label)! }));

    const totalToday = parseInt(completionRes.rows[0].total_today, 10);
    const completedToday = parseInt(completionRes.rows[0].completed_today, 10);
    const completionRate = totalToday > 0 ? (completedToday / totalToday) * 100 : null;

    const overallStatus = pipeline.some((s) => s.status === 'degraded' || s.status === 'offline')
      ? 'degraded'
      : 'online';

    res.json({
      summary: {
        totalDeals: parseInt(windowSummaryRes.rows[0].total_deals, 10),
        gridPositionMwh: parseFloat(windowSummaryRes.rows[0].grid_position_mwh),
        completionRate,
        inFlight: parseInt(inFlightRes.rows[0].in_flight, 10),
        stuck: parseInt(inFlightRes.rows[0].stuck, 10),
        criticalAtRisk: parseInt(criticalRes.rows[0].critical_at_risk, 10),
        overallStatus,
        // Retain system/middleware health counts for the header
        systemsOnline: systemsRes.rows.filter((s) => s.status === 'online').length,
        systemsTotal: systemsRes.rows.length,
        middlewareOnline: mwRes.rows.filter((m) => m.status === 'online').length,
        middlewareTotal: mwRes.rows.length,
      },
      pipeline,
      chart: chartSeries,
      deliveryChart,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
