/**
 * Seed script: populates systems, middleware, and synthetic deal journey history.
 *
 * Model:
 *   - Each unique `correlation_id` (UUID) represents ONE energy deal.
 *   - Deals originate at VAT-P (the entry point). PACE runs in parallel as a
 *     validator — both should show the same counts (divergence = recon issue).
 *   - Downstream chain: VAT-P → NEON → Endur
 *   - `volume_mwh` is the energy volume committed to the grid for that deal.
 *   - `status` at each system: processed | failed | pending
 *
 * Run with:  npm run seed
 */
import { randomUUID } from 'crypto';
import pool from './db';

// Pipeline: VAT-P is the entry point; PACE is a parallel validator; Endur is book of record
const SYSTEMS = [
  { name: 'VAT-P', status: 'online' },
  { name: 'PACE',  status: 'online' },
  { name: 'NEON',  status: 'online' },
  { name: 'Endur', status: 'degraded' },
];

const MIDDLEWARE: Record<string, { name: string; messagesIn: number | null; messagesOut: number | null; status: string }[]> = {
  'VAT-P': [
    { name: 'vatp-inbound-topic',    messagesIn: 6100, messagesOut: 6088, status: 'online' },
    { name: 'vatp-validated-topic',  messagesIn: 6088, messagesOut: 6070, status: 'online' },
    { name: 'vatp-dlq-topic',        messagesIn: 0,    messagesOut: 0,    status: 'online' },
  ],
  'PACE': [
    { name: 'pace-validation-topic', messagesIn: 6088, messagesOut: 6070, status: 'online' },
  ],
  'NEON': [
    { name: 'neon-inbound-topic',    messagesIn: 6038, messagesOut: 6038, status: 'online' },
    { name: 'neon-offtake-topic',    messagesIn: 6038, messagesOut: 6005, status: 'online' },
    { name: 'neon-dlq-topic',        messagesIn: 0,    messagesOut: 0,    status: 'online' },
  ],
  'Endur': [
    { name: 'endur-inbound-topic',   messagesIn: 6005, messagesOut: 6005, status: 'online' },
    { name: 'endur-offtake-topic',   messagesIn: 6005, messagesOut: 4820, status: 'degraded' },
    { name: 'endur-dlq-topic',       messagesIn: 0,    messagesOut: 0,    status: 'online' },
  ],
};

// Latency for PACE: receives deals at the same time as VAT-P (both fed simultaneously)
// Inter-stage latency ranges (seconds) for the downstream chain: VAT-P → NEON → Endur
const STAGE_LATENCY_RANGES: [number, number][] = [
  [30, 120],  // VAT-P → NEON
  [45, 180],  // NEON → Endur
];

// MWh volume range per deal — intraday/day-ahead power trades (10–80 MWh each)
const VOLUME_RANGE: [number, number] = [10, 80];

// Energy products and counterparties for realistic aggregation grouping
const PRODUCTS = ['Power Base', 'Power Peak', 'Power HH', 'Power Off-Peak', 'Power Spreads'];
const COUNTERPARTIES = [
  'Shell Energy', 'BP Trading', 'EDF Trading', 'RWE Supply',
  'Centrica', 'Vitol', 'Gunvor', 'Trafigura',
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Probability a deal gets stuck/fails at or before reaching each stage (index = stage index 1-3) */
const FAIL_PROB    = 0.03;  // probability of failure at any stage
const REJECT_PROB  = 0.02;  // probability of rejection at any stage
// ~5% of today's deals are deliberately kept in-flight (entered recently, not yet complete)

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert systems
    for (const sys of SYSTEMS) {
      await client.query(
        `INSERT INTO systems (name, status) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
        [sys.name, sys.status],
      );
    }

    // 2. Replace middleware components
    await client.query('DELETE FROM middleware_components');
    for (const sys of SYSTEMS) {
      const { rows } = await client.query<{ id: number }>('SELECT id FROM systems WHERE name = $1', [sys.name]);
      const sysId = rows[0].id;
      for (const mc of MIDDLEWARE[sys.name]) {
        await client.query(
          `INSERT INTO middleware_components (system_id, name, messages_in, messages_out, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [sysId, mc.name, mc.messagesIn, mc.messagesOut, mc.status],
        );
      }
    }

    // 3. Generate deal journey history
    // Always regenerate: cascade from deals wipes deal_journey + deal_aggregations too
    await client.query('DELETE FROM deals');
    console.log('Generating deal journey history...');
    {  // block kept for consistent indent with legacy code below

      const systemRows = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM systems ORDER BY id',
      );
      const sysMap = new Map(systemRows.rows.map((r) => [r.name, r.id]));

      const now = Date.now();
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayStartMs = dayStart.getTime();

      // We'll generate deals spread across today + yesterday for 24h history
      const windowMs = 24 * 60 * 60 * 1000;
      // 10,000 deals over 24h (~417/hour) — higher volume needed for meaningful 1-min window bundling
      // with the product × delivery_hour grouping key (240 key combinations).
      const TOTAL_DEALS = 10_000;

      // Batch inserts — two tables: deals (unique per correlation_id) and deal_journey (per-system events).
      // flushJourney() always calls flushDeals() first to satisfy the FK constraint.
      const BATCH = 400;

      let dealRows: string[] = [];
      let dealParams: (string | number | null)[] = [];
      let dp = 1;

      const flushDeals = async () => {
        if (dealRows.length === 0) return;
        await client.query(
          `INSERT INTO deals (correlation_id, volume_mwh, delivery_start, product, counterparty, created_at)
           VALUES ${dealRows.join(',')}`,
          dealParams,
        );
        dealRows = []; dealParams = []; dp = 1;
      };

      const addDeal = async (
        corrId: string,
        volumeMwh: number,
        deliveryStart: string,
        product: string,
        counterparty: string,
        ts: string,
      ) => {
        dealRows.push(`($${dp}, $${dp+1}, $${dp+2}, $${dp+3}, $${dp+4}, $${dp+5})`);
        dealParams.push(corrId, volumeMwh.toFixed(3), deliveryStart, product, counterparty, ts);
        dp += 6;
        if (dealRows.length >= BATCH) await flushDeals();
      };

      let journeyRows: string[] = [];
      let journeyParams: (string | number | null)[] = [];
      let jp = 1;

      const flushJourney = async () => {
        if (journeyRows.length === 0) return;
        await flushDeals();  // ensure all referenced deal records exist in DB first (FK)
        await client.query(
          `INSERT INTO deal_journey (correlation_id, system_id, status, error_message, created_at)
           VALUES ${journeyRows.join(',')}`,
          journeyParams,
        );
        journeyRows = []; journeyParams = []; jp = 1;
      };

      const addJourney = async (
        corrId: string,
        sysId: number,
        status: string,
        errorMsg: string | null,
        ts: string,
      ) => {
        journeyRows.push(`($${jp}, $${jp+1}, $${jp+2}, $${jp+3}, $${jp+4})`);
        journeyParams.push(corrId, sysId, status, errorMsg, ts);
        jp += 5;
        if (journeyRows.length >= BATCH) await flushJourney();
      };

      for (let i = 0; i < TOTAL_DEALS; i++) {
        const corrId = randomUUID();
        const volumeMwh = randomBetween(VOLUME_RANGE[0], VOLUME_RANGE[1]);
        // Assign product and counterparty once per deal (consistent across all system rows)
        const product      = pick(PRODUCTS);
        const counterparty = pick(COUNTERPARTIES);

        // Deal entry time: spread uniformly across the 24h window
        const ageMs = Math.random() * windowMs;
        let stageTimeMs = now - ageMs;

        // Delivery start: when energy must start flowing to the grid.
        // Each deal's delivery_start is consistent across all its system rows.
        // Distribution designed to give a realistic mix of urgency levels:
        //   5% CRITICAL  — delivery in 0–2 h from now
        //   10% WARNING  — delivery in 2–4 h
        //   20% TODAY    — delivery in 4–12 h
        //   35% TOMORROW — delivery in 12–24 h
        //   30% FUTURE   — delivery in 1–3 days
        const deliveryOffsetHours = (() => {
          const r = Math.random();
          if (r < 0.05) return randomBetween(0, 2);
          if (r < 0.15) return randomBetween(2, 4);
          if (r < 0.35) return randomBetween(4, 12);
          if (r < 0.70) return randomBetween(12, 24);
          return randomBetween(24, 72);
        })();
        // Snap to 1-hour boundary — delivery periods grouped at the hourly level for aggregation
        const deliveryMs = Math.floor((now + deliveryOffsetHours * 3_600_000) / (60 * 60_000)) * (60 * 60_000);
        const deliveryStart = new Date(deliveryMs).toISOString();

        // VAT-P — entry point for all deals
        const vatpId = sysMap.get('VAT-P')!;
        const vatpRoll = Math.random();
        const vatpErrors = ['Price feed timeout', 'Validation schema mismatch'];
        const vatpStatus = vatpRoll < FAIL_PROB ? 'failed'
                         : vatpRoll < FAIL_PROB + REJECT_PROB ? 'failed'
                         : 'processed';
        const vatpErr = vatpStatus === 'failed'
          ? (vatpRoll < FAIL_PROB ? vatpErrors[Math.floor(Math.random() * vatpErrors.length)] : 'Deal rejected by risk engine')
          : null;
        // Insert the unique deal record at PACE entry time (PACE arrives first)
        await addDeal(corrId, volumeMwh, deliveryStart, product, counterparty, new Date(stageTimeMs).toISOString());

        // For very recent deals (< 30 s old), keep in-flight at PACE
        if (ageMs < 30 * 1000) continue;

        // PACE — parallel validator; receives deals first. No failures (metric not applicable).
        const paceId = sysMap.get('PACE')!;
        await addJourney(corrId, paceId, 'processed', null, new Date(stageTimeMs).toISOString());

        // VAT-P — entry point, arrives 1 second after PACE.
        await addJourney(corrId, vatpId, vatpStatus, vatpErr, new Date(stageTimeMs + 1000).toISOString());

        if (vatpStatus !== 'processed') continue;

        // Downstream chain: VAT-P → NEON → Endur
        const stageSystems = ['NEON', 'Endur'] as const;
        let stuckOrFailed = false;

        for (let s = 0; s < stageSystems.length; s++) {
          // Advance time by inter-stage latency
          stageTimeMs += randomBetween(...STAGE_LATENCY_RANGES[s]) * 1000;

          // Don't create future-dated rows
          if (stageTimeMs > now) break;

          const sysName = stageSystems[s];
          const sysId = sysMap.get(sysName)!;

          // Endur (degraded): higher failure rate
          const failProb  = sysName === 'Endur' ? FAIL_PROB * 3   : FAIL_PROB;
          const rejProb   = sysName === 'Endur' ? REJECT_PROB * 2 : REJECT_PROB;

          const roll = Math.random();
          if (roll < failProb) {
            const errors: Record<string, string[]> = {
              'NEON':  ['Position limit breach', 'Netting rule violation'],
              'Endur': ['Settlement Eng. timeout', 'Book lock error', 'Confirm. Service unavailable'],
            };
            const msgs = errors[sysName] ?? ['Unknown error'];
            const errMsg = msgs[Math.floor(Math.random() * msgs.length)];
            await addJourney(corrId, sysId, 'failed', errMsg, new Date(stageTimeMs).toISOString());
            stuckOrFailed = true;
            break;
          } else if (roll < failProb + rejProb) {
            await addJourney(corrId, sysId, 'failed', 'Deal rejected by risk engine', new Date(stageTimeMs).toISOString());
            stuckOrFailed = true;
            break;
          } else {
            await addJourney(corrId, sysId, 'processed', null, new Date(stageTimeMs).toISOString());
          }
        }

        // ~8% chance: deal gets stuck mid-journey (stops progressing after a stage)
        // This is already handled naturally by the time-based break above for recent deals.
        // For older deals, simulate stuck by not reaching Endur even if time allows.
        void stuckOrFailed; // suppress unused warning
      }

      await flushDeals();
      await flushJourney();
      console.log(`Inserted deal journey events for ${TOTAL_DEALS} deals.`);

      // 4. Generate deal aggregations
      // Group processed deals at VAT-P (vat_p_neon) and NEON (neon_endur)
      // by delivery_day + settlement period + product + counterparty. Bundles of 2+ deals get an agg_id.
      await client.query('DELETE FROM deal_aggregations');

      const makeAggregations = async (stageSysName: string, stage: string) => {
        const sysRes = await client.query<{
          correlation_id: string;
          delivery_start: string;
          product: string;
          counterparty: string;
          deal_created_at: string;
        }>(
          `SELECT dj.correlation_id,
                  d.delivery_start::text,
                  d.product,
                  d.counterparty,
                  dj.created_at::text AS deal_created_at
           FROM deal_journey dj
           JOIN deals d ON d.correlation_id = dj.correlation_id
           JOIN systems s ON s.id = dj.system_id AND s.name = $1
           WHERE dj.status = 'processed' AND d.delivery_start IS NOT NULL
             AND d.product IS NOT NULL AND d.counterparty IS NOT NULL`,
          [stageSysName],
        );

        const groups = new Map<string, Array<{ corrId: string; createdAt: string; counterparty: string }>>();
        for (const row of sysRes.rows) {
          const dt = new Date(row.delivery_start);
          const delivDay = dt.toISOString().substring(0, 10);
          // delivery_start is already snapped to 1-hour boundary — use it directly as the period key
          const deliveryPeriod = row.delivery_start;
          // 1-hour aggregation window: truncate deal's processing time to the hour
          const procMs = new Date(row.deal_created_at).getTime();
          const hourSlot = new Date(Math.floor(procMs / 3_600_000) * 3_600_000).toISOString();
          // Group by: delivery period + product + 1-hour processing window (counterparty excluded — deals for the same product/hour bundle regardless of counterparty)
          const key = `${delivDay}||${deliveryPeriod}||${row.product}||${hourSlot}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push({ corrId: row.correlation_id, createdAt: row.deal_created_at, counterparty: row.counterparty });
        }

        let aggRows: string[] = [];
        let aggParams: (string | null | string)[] = [];
        let ap = 1;
        const flushAgg = async () => {
          if (aggRows.length === 0) return;
          await client.query(
            `INSERT INTO deal_aggregations (agg_id, stage, correlation_id, delivery_day, delivery_period, product, counterparty, window_start, created_at) VALUES ${aggRows.join(',')}`,
            aggParams,
          );
          aggRows = []; aggParams = []; ap = 1;
        };

        for (const [key, items] of groups) {
          if (items.length < 2) continue;
          const [delivDay, deliveryPeriod, product, hourSlot] = key.split('||');
          const counterparty = items[0].counterparty;
          // window_start is the 1-hour slot; dispatch time (created_at) = window_start + 1h
          const windowStart = hourSlot;
          const dispatchTs  = new Date(new Date(hourSlot).getTime() + 3_600_000).toISOString();
          const aggId = randomUUID();
          for (const { corrId } of items) {
            aggRows.push(`($${ap},$${ap+1},$${ap+2},$${ap+3},$${ap+4},$${ap+5},$${ap+6},$${ap+7},$${ap+8})`);
            aggParams.push(aggId, stage, corrId, delivDay, deliveryPeriod, product, counterparty, windowStart, dispatchTs);
            ap += 9;
            if (aggRows.length >= 300) await flushAgg();
          }
        }
        await flushAgg();
      };

      await makeAggregations('VAT-P', 'vat_p_neon');

      // ── After grouping VAT-P bundles, enforce bundle-level fate at NEON ──
      // All members of a bundle must arrive at (and share the fate of) the target system together.
      const harmonizeBundleOutcomes = async (stage: string, targetSysName: string) => {
        const targetSysRes = await client.query<{ id: number }>(
          'SELECT id FROM systems WHERE name = $1', [targetSysName],
        );
        if (targetSysRes.rows.length === 0) return;
        const targetSysId = targetSysRes.rows[0].id;

        const bundlesRes = await client.query<{ agg_id: string; members: string[] }>(
          `SELECT agg_id, array_agg(correlation_id) AS members
           FROM deal_aggregations WHERE stage = $1 GROUP BY agg_id`,
          [stage],
        );

        const bundleErrors = [
          `${targetSysName} netting engine timeout`,
          `${targetSysName} position limit exceeded`,
          `${targetSysName} settlement service unavailable`,
        ];

        for (const bundle of bundlesRes.rows) {
          // Find bundle members that already have a target system event
          const existing = await client.query<{ correlation_id: string; created_at: string }>(
            `SELECT correlation_id, created_at::text FROM deal_journey
             WHERE system_id = $1 AND correlation_id = ANY($2)`,
            [targetSysId, bundle.members],
          );
          if (existing.rows.length === 0) continue; // all still in-flight — nothing to harmonize

          // Roll ONE dice for the entire bundle
          const bundleStatus = Math.random() < FAIL_PROB ? 'failed' : 'processed';
          const bundleError  = bundleStatus === 'failed' ? pick(bundleErrors) : null;

          // All members arrive at the same time (earliest of existing events)
          const arrivalTime = existing.rows.reduce(
            (min, r) => (r.created_at < min ? r.created_at : min),
            existing.rows[0].created_at,
          );

          await client.query(
            `UPDATE deal_journey SET status = $1, error_message = $2, created_at = $3
             WHERE system_id = $4 AND correlation_id = ANY($5)`,
            [bundleStatus, bundleError, arrivalTime, targetSysId, bundle.members],
          );

          // If the bundle failed, remove any erroneous downstream events
          if (bundleStatus === 'failed') {
            const downstream = stage === 'vat_p_neon' ? ['Endur'] : [];
            for (const ds of downstream) {
              await client.query(
                `DELETE FROM deal_journey WHERE system_id IN (SELECT id FROM systems WHERE name = $1)
                 AND correlation_id = ANY($2)`,
                [ds, bundle.members],
              );
            }
          }
        }
      };

      await harmonizeBundleOutcomes('vat_p_neon', 'NEON');
      await makeAggregations('NEON', 'neon_endur');
      await harmonizeBundleOutcomes('neon_endur', 'Endur');
      console.log('Deal aggregations seeded.');
    }

    // Sync middleware_components to reflect actual deal counts from the generated data.
    // VAT-P topics:
    //   inbound    : all deals entering VAT-P → those that passed (drop = failed)
    //   validated  : passed deals in → same out (no further drop; all validated deals advance)
    //   dlq        : failed deals in → 0 out (parked in the dead-letter queue)
    {
      const counts = await client.query<{ total: string; processed: string; failed: string }>(
        `SELECT COUNT(*)                                             AS total,
                COUNT(*) FILTER (WHERE status = 'processed')        AS processed,
                COUNT(*) FILTER (WHERE status = 'failed')           AS failed
         FROM deal_journey WHERE system_id = (SELECT id FROM systems WHERE name = 'VAT-P')`,
      );
      const total     = parseInt(counts.rows[0].total,     10);
      const processed = parseInt(counts.rows[0].processed, 10);
      const failed    = parseInt(counts.rows[0].failed,    10);

      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = $1
         WHERE system_id = (SELECT id FROM systems WHERE name = 'VAT-P') AND name = 'vatp-inbound-topic'`,
        [total],
      );
      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = $1
         WHERE system_id = (SELECT id FROM systems WHERE name = 'VAT-P') AND name = 'vatp-validated-topic'`,
        [processed],
      );
      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = 0
         WHERE system_id = (SELECT id FROM systems WHERE name = 'VAT-P') AND name = 'vatp-dlq-topic'`,
        [failed],
      );
      console.log(`VAT-P middleware synced: inbound ${total} (no drop), dlq ${failed}`);
    }

    // NEON topics:
    //   inbound  : deals arriving at NEON → those NEON processed (drop = NEON failures)
    //   offtake  : NEON-processed → how many actually reached Endur (gap = still in-flight)
    //   dlq      : NEON failures → 0
    {
      const neonCounts = await client.query<{ total: string; processed: string; failed: string }>(
        `SELECT COUNT(*)                                             AS total,
                COUNT(*) FILTER (WHERE status = 'processed')        AS processed,
                COUNT(*) FILTER (WHERE status = 'failed')           AS failed
         FROM deal_journey WHERE system_id = (SELECT id FROM systems WHERE name = 'NEON')`,
      );
      const nTotal     = parseInt(neonCounts.rows[0].total,     10);
      const nProcessed = parseInt(neonCounts.rows[0].processed, 10);
      const nFailed    = parseInt(neonCounts.rows[0].failed,    10);

      // How many NEON-processed deals actually reached Endur (dispatched downstream)
      const endurArrived = await client.query<{ cnt: string }>(
        `SELECT COUNT(DISTINCT dj.correlation_id) AS cnt
         FROM deal_journey dj
         WHERE dj.system_id = (SELECT id FROM systems WHERE name = 'Endur')
           AND dj.correlation_id IN (
             SELECT correlation_id FROM deal_journey
             WHERE system_id = (SELECT id FROM systems WHERE name = 'NEON') AND status = 'processed'
           )`,
      );
      const nDispatched = parseInt(endurArrived.rows[0].cnt, 10);

      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = $1
         WHERE system_id = (SELECT id FROM systems WHERE name = 'NEON') AND name = 'neon-inbound-topic'`,
        [nTotal],
      );
      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = $2
         WHERE system_id = (SELECT id FROM systems WHERE name = 'NEON') AND name = 'neon-offtake-topic'`,
        [nProcessed, nDispatched],
      );
      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = 0
         WHERE system_id = (SELECT id FROM systems WHERE name = 'NEON') AND name = 'neon-dlq-topic'`,
        [nFailed],
      );
      console.log(`NEON middleware synced: inbound ${nTotal} (no drop), offtake ${nProcessed}→${nDispatched}, dlq ${nFailed}`);
    }

    // Endur topics:
    //   inbound  : deals arriving at Endur → those Endur processed (drop = Endur failures)
    //   offtake  : processed deals dispatched out (settled/booked) — same as processed; no further drop
    //   dlq      : Endur failures → 0
    {
      const endurCounts = await client.query<{ total: string; processed: string; failed: string }>(
        `SELECT COUNT(*)                                             AS total,
                COUNT(*) FILTER (WHERE status = 'processed')        AS processed,
                COUNT(*) FILTER (WHERE status = 'failed')           AS failed
         FROM deal_journey WHERE system_id = (SELECT id FROM systems WHERE name = 'Endur')`,
      );
      const eTotal     = parseInt(endurCounts.rows[0].total,     10);
      const eProcessed = parseInt(endurCounts.rows[0].processed, 10);
      const eFailed    = parseInt(endurCounts.rows[0].failed,    10);

      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = $1
         WHERE system_id = (SELECT id FROM systems WHERE name = 'Endur') AND name = 'endur-inbound-topic'`,
        [eTotal],
      );
      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = $1
         WHERE system_id = (SELECT id FROM systems WHERE name = 'Endur') AND name = 'endur-offtake-topic'`,
        [eProcessed],
      );
      await client.query(
        `UPDATE middleware_components SET messages_in = $1, messages_out = 0
         WHERE system_id = (SELECT id FROM systems WHERE name = 'Endur') AND name = 'endur-dlq-topic'`,
        [eFailed],
      );
      console.log(`Endur middleware synced: inbound ${eTotal} (no drop), dlq ${eFailed}`);
    }

    await client.query('COMMIT');
    console.log('Seed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
