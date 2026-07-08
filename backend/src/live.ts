/**
 * Live feed simulator.
 * Continuously inserts new deals flowing through the VAT-P → NEON → Endur pipeline.
 * PACE runs in parallel as a validator — same deals, same counts as VAT-P.
 * Keeps short time windows (1m, 10m, 15m) populated without needing a full re-seed.
 *
 * Run with:  npm run live
 */
import { randomUUID } from 'crypto';
import pool from './db';

const PRODUCTS      = ['Power Base', 'Power Peak', 'Power HH', 'Power Off-Peak', 'Power Spreads'];
const COUNTERPARTIES = [
  'Shell Energy', 'BP Trading', 'EDF Trading', 'RWE Supply',
  'Centrica', 'Vitol', 'Gunvor', 'Trafigura',
];
const VOLUME_RANGE: [number, number] = [10, 80];
const STAGE_LATENCY_RANGES: [number, number][] = [
  [30, 120],  // VAT-P → NEON
  [45, 180],  // NEON → Endur
];
const FAIL_PROB   = 0.03;
const REJECT_PROB = 0.02;

// ~5 new deals every 5 seconds = ~60/min — higher volume for meaningful 1-min window bundling
const DEALS_PER_TICK  = 5;
const TICK_INTERVAL_MS = 5_000;

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min: number, max: number) { return Math.random() * (max - min) + min; }

// Shared pause state — mutated by the Express pause/resume endpoints
export const liveState = { paused: false };

async function tick(sysMap: Map<string, number>) {
  if (liveState.paused) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < DEALS_PER_TICK; i++) {
      const corrId       = randomUUID();
      const volumeMwh    = rand(VOLUME_RANGE[0], VOLUME_RANGE[1]);
      const product      = pick(PRODUCTS);
      const counterparty = pick(COUNTERPARTIES);

      // Delivery start: same urgency distribution as the seed
      const deliveryOffsetHours = (() => {
        const r = Math.random();
        if (r < 0.05) return rand(0, 2);
        if (r < 0.15) return rand(2, 4);
        if (r < 0.35) return rand(4, 12);
        if (r < 0.70) return rand(12, 24);
        return rand(24, 72);
      })();
      // Snap to 1-hour boundary — delivery periods grouped at the hourly level for aggregation
      const deliveryMs = Math.floor((Date.now() + deliveryOffsetHours * 3_600_000) / (60 * 60_000)) * (60 * 60_000);
      const deliveryStart = new Date(deliveryMs).toISOString();

      // Start the deal at a random point in the recent past (up to 10 min ago)
      // so that downstream stage timestamps (VAT-P + latency) fall in the past.
      // VAT-P — entry point for all deals
      const vatpId = sysMap.get('VAT-P')!;
      let stageTimeMs = Date.now() - rand(0, 600) * 1000;

      // Roll for VAT-P failure (validation errors, schema mismatch, etc.)
      const vatpErrors = ['Price feed timeout', 'Validation schema mismatch'];
      const vatpRoll = Math.random();
      const vatpStatus = vatpRoll < FAIL_PROB ? 'failed'
                       : vatpRoll < FAIL_PROB + REJECT_PROB ? 'failed'
                       : 'processed';
      const vatpErr: string | null = vatpStatus === 'failed'
        ? (vatpRoll < FAIL_PROB ? vatpErrors[Math.floor(Math.random() * vatpErrors.length)] : 'Deal rejected by risk engine')
        : null;
      // Insert the unique deal record and the VAT-P journey event
      await client.query(
        `INSERT INTO deals (correlation_id, volume_mwh, delivery_start, product, counterparty, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [corrId, volumeMwh.toFixed(3), deliveryStart, product, counterparty, new Date(stageTimeMs).toISOString()],
      );
      await client.query(
        `INSERT INTO deal_journey (correlation_id, system_id, status, error_message, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [corrId, vatpId, vatpStatus, vatpErr, new Date(stageTimeMs).toISOString()],
      );

      // vat_p_neon aggregation bundle (processed deals at VAT-P only)
      let prevAggId: string | null = null;
      let prevAggStage: string | null = null;
      if (vatpStatus === 'processed') {
        const delivDay = deliveryStart.substring(0, 10);
        // delivery_start is already snapped to 15-min boundary — use directly as the period
        const deliveryPeriod = deliveryStart;
        const windowStart = new Date(Math.floor(stageTimeMs / 60_000) * 60_000).toISOString();
        const dispatchTs  = new Date(Math.floor(stageTimeMs / 60_000) * 60_000 + 60_000).toISOString();
        const existingVatpBundle = await client.query<{ agg_id: string }>(
          `SELECT agg_id FROM deal_aggregations
           WHERE stage = 'vat_p_neon' AND delivery_day = $1 AND delivery_period = $2
             AND product = $3 AND counterparty = $4 AND window_start = $5
           LIMIT 1`,
          [delivDay, deliveryPeriod, product, counterparty, windowStart],
        );
        const vatpAggId = existingVatpBundle.rows[0]?.agg_id ?? randomUUID();
        await client.query(
          `INSERT INTO deal_aggregations (agg_id, stage, correlation_id, delivery_day, delivery_period, product, counterparty, window_start, created_at)
           VALUES ($1,'vat_p_neon',$2,$3,$4,$5,$6,$7,$8)`,
          [vatpAggId, corrId, delivDay, deliveryPeriod, product, counterparty, windowStart, dispatchTs],
        );
        prevAggId    = vatpAggId;
        prevAggStage = 'vat_p_neon';
      }

      // PACE — only receives deals that passed VAT-P validation; always processed, never fails
      const paceId = sysMap.get('PACE')!;
      if (vatpStatus === 'processed') {
        await client.query(
          `INSERT INTO deal_journey (correlation_id, system_id, status, error_message, created_at)
           VALUES ($1,$2,'processed',NULL,$3)`,
          [corrId, paceId, new Date(stageTimeMs).toISOString()],
        );
      }

      if (vatpStatus !== 'processed') continue;

      // Downstream chain: VAT-P → NEON → Endur
      const stages = ['NEON', 'Endur'] as const;
      // Stage names that trigger aggregation bundle membership
      const AGG_STAGES: Partial<Record<string, string>> = {
        'NEON': 'neon_endur',
      };

      for (let s = 0; s < stages.length; s++) {
        stageTimeMs += rand(...STAGE_LATENCY_RANGES[s]) * 1000;

        // Only insert past-dated rows (don't generate future stage events)
        if (stageTimeMs > Date.now()) break;

        const sysId = sysMap.get(stages[s])!;
        let status  = 'processed';
        let errMsg: string | null = null;

        const failProb   = stages[s] === 'Endur' ? FAIL_PROB * 3   : FAIL_PROB;
        const rejectProb = stages[s] === 'Endur' ? REJECT_PROB * 2 : REJECT_PROB;

        // Is this stage the target of a bundle from the previous stage?
        const isBundleTarget =
          (prevAggStage === 'vat_p_neon' && stages[s] === 'NEON') ||
          (prevAggStage === 'neon_endur' && stages[s] === 'Endur');

        if (prevAggId && isBundleTarget) {
          // Check if another bundle member already has an event at this system
          const siblingFate = await client.query<{ status: string; error_message: string | null }>(
            `SELECT dj.status, dj.error_message
             FROM deal_journey dj
             WHERE dj.system_id = $1
               AND dj.correlation_id IN (
                 SELECT correlation_id FROM deal_aggregations
                 WHERE agg_id = $2 AND correlation_id <> $3
               )
             LIMIT 1`,
            [sysId, prevAggId, corrId],
          );
          if (siblingFate.rows.length > 0) {
            // Honour the bundle fate already decided by a sibling
            status = siblingFate.rows[0].status;
            errMsg = siblingFate.rows[0].error_message;
          } else {
            // First bundle member to reach this stage — decide fate for the whole bundle
            const roll = Math.random();
            if (roll < failProb) {
              const errors: Record<string, string[]> = {
                'NEON':  ['Position limit breach', 'Netting rule violation'],
                'Endur': ['Settlement Eng. timeout', 'Book lock error', 'Confirm. Service unavailable'],
              };
              errMsg = errors[stages[s]]?.[Math.floor(Math.random() * (errors[stages[s]]?.length ?? 1))] ?? 'Unknown error';
              status = 'failed';
            } else if (roll < failProb + rejectProb) {
              status = 'failed';
              errMsg = 'Deal rejected by risk engine';
            }
          }
          prevAggId = null;
          prevAggStage = null;
        } else {
          // No bundle context — independent fate
          const roll = Math.random();
          if (roll < failProb) {
            const errors: Record<string, string[]> = {
              'NEON':  ['Position limit breach', 'Netting rule violation'],
              'Endur': ['Settlement Eng. timeout', 'Book lock error', 'Confirm. Service unavailable'],
            };
            errMsg = errors[stages[s]]?.[Math.floor(Math.random() * (errors[stages[s]]?.length ?? 1))] ?? 'Unknown error';
            status = 'failed';
          } else if (roll < failProb + rejectProb) {
            status = 'failed';
            errMsg = 'Deal rejected by risk engine';
          }
        }

        await client.query(
          `INSERT INTO deal_journey (correlation_id, system_id, status, error_message, created_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [corrId, sysId, status, errMsg, new Date(stageTimeMs).toISOString()],
        );

        // Create / join an aggregation bundle for processed deals at VAT-P and NEON
        if (status === 'processed' && AGG_STAGES[stages[s]]) {
          const aggStage = AGG_STAGES[stages[s]]!;
          const delivDay = deliveryStart.substring(0, 10);
          // delivery_start is already snapped to 15-min boundary — use directly as the period
          const deliveryPeriod = deliveryStart;

          // 1-minute aggregation window: the bundle is keyed to the minute slot of
          // the deal's processing time at this stage.
          const windowStart = new Date(Math.floor(stageTimeMs / 60_000) * 60_000).toISOString();
          const dispatchTs  = new Date(Math.floor(stageTimeMs / 60_000) * 60_000 + 60_000).toISOString();

          // Find an existing bundle for the same (minute-window × delivery-period × product × counterparty).
          const existingBundle = await client.query<{ agg_id: string }>(
            `SELECT agg_id FROM deal_aggregations
             WHERE stage = $1 AND delivery_day = $2 AND delivery_period = $3
               AND product = $4 AND counterparty = $5 AND window_start = $6
             LIMIT 1`,
            [aggStage, delivDay, deliveryPeriod, product, counterparty, windowStart],
          );

          const aggId = existingBundle.rows[0]?.agg_id ?? randomUUID();
          await client.query(
            `INSERT INTO deal_aggregations (agg_id, stage, correlation_id, delivery_day, delivery_period, product, counterparty, window_start, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [aggId, aggStage, corrId, delivDay, deliveryPeriod, product, counterparty, windowStart, dispatchTs],
          );

          // Track bundle membership for the next stage's fate decision
          prevAggId    = aggId;
          prevAggStage = aggStage;
        }

        if (status !== 'processed') break;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Live feed tick error:', err);
  } finally {
    client.release();
  }
}

async function main() {
  // Resolve system IDs once
  const { rows } = await pool.query<{ id: number; name: string }>('SELECT id, name FROM systems');
  if (rows.length === 0) {
    console.error('No systems found — run npm run seed first.');
    process.exit(1);
  }
  const sysMap = new Map(rows.map((r) => [r.name, r.id]));

  console.log(`Live feed started — inserting ${DEALS_PER_TICK} deals every ${TICK_INTERVAL_MS / 1000}s`);
  console.log('Press Ctrl+C to stop.\n');

  // Run once immediately, then on interval
  await tick(sysMap);
  setInterval(() => tick(sysMap), TICK_INTERVAL_MS);
}

// Called by index.ts to embed the live feed in the backend process
export async function startLiveFeed(): Promise<void> {
  const { rows } = await pool.query<{ id: number; name: string }>('SELECT id, name FROM systems');
  if (rows.length === 0) { console.warn('Live feed: no systems found, skipping.'); return; }
  const sysMap = new Map(rows.map((r) => [r.name, r.id]));
  console.log(`[live] feed started — ${DEALS_PER_TICK} deals every ${TICK_INTERVAL_MS / 1000}s (pauseable via /api/live)`);
  await tick(sysMap);
  setInterval(() => tick(sysMap), TICK_INTERVAL_MS);
}

// Standalone mode: only run when executed directly (npm run live)
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
