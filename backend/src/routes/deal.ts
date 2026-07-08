/**
 * GET /api/deal/search?q=<partial-correlation-id>
 *   Returns up to 10 matching deals (by prefix/partial UUID match).
 *
 * GET /api/deal/:correlationId
 *   Returns the full journey for one deal — one entry per system that has seen it.
 */
import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

// Partial search — returns list of matching correlation_ids
router.get('/search', async (req: Request, res: Response): Promise<void> => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (q.length < 4) {
    res.status(400).json({ error: 'Query must be at least 4 characters' });
    return;
  }

  try {
    const { rows } = await pool.query<{ correlation_id: string; entered_at: Date; volume_mwh: string }>(
      `SELECT
         correlation_id,
         created_at  AS entered_at,
         volume_mwh
       FROM deals
       WHERE correlation_id::text LIKE $1
       ORDER BY correlation_id
       LIMIT 10`,
      [`${q}%`],
    );

    res.json(rows.map((r) => ({
      correlationId: r.correlation_id,
      enteredAt: r.entered_at,
      volumeMwh: parseFloat(r.volume_mwh),
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Full journey for one deal
router.get('/:correlationId', async (req: Request, res: Response): Promise<void> => {
  const { correlationId } = req.params;

  // Basic UUID format guard
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(correlationId)) {
    res.status(400).json({ error: 'Invalid correlation ID format' });
    return;
  }

  try {
    // All system events for this deal, ordered by time
    const { rows } = await pool.query<{
      system_id: number;
      system_name: string;
      system_status: string;
      volume_mwh: string;
      status: string;
      error_message: string | null;
      created_at: Date;
      delivery_start: Date | null;
    }>(
      `SELECT
         dj.system_id,
         s.name   AS system_name,
         s.status AS system_status,
         d.volume_mwh,
         dj.status,
         dj.error_message,
         dj.created_at,
         d.delivery_start
       FROM deal_journey dj
       JOIN systems s ON s.id = dj.system_id
       JOIN deals d ON d.correlation_id = dj.correlation_id
       WHERE dj.correlation_id = $1
       ORDER BY dj.created_at`,
      [correlationId],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Deal not found' });
      return;
    }

    // Enrich with inter-stage latency
    const stages = rows.map((r, i) => {
      const prevTime = i > 0 ? rows[i - 1].created_at.getTime() : null;
      const lagMs = prevTime !== null ? r.created_at.getTime() - prevTime : null;
      return {
        systemId: r.system_id,
        systemName: r.system_name,
        status: r.status,
        errorMessage: r.error_message ?? null,
        volumeMwh: parseFloat(r.volume_mwh),
        processedAt: r.created_at,
        lagFromPreviousMs: lagMs,
      };
    });

    // Determine all 4 expected systems in order
    const allSystems = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM systems ORDER BY id`,
    );
    const seenIds = new Set(rows.map((r) => r.system_id));

    const journey = allSystems.rows.map((sys) => {
      const stage = stages.find((s) => s.systemId === sys.id);
      return stage
        ? stage
        : {
            systemId: sys.id,
            systemName: sys.name,
            status: 'not_reached',
            errorMessage: null,
            volumeMwh: null,
            processedAt: null,
            lagFromPreviousMs: null,
          };
    });

    const firstEvent = rows[0];
    const lastEvent = rows[rows.length - 1];
    const deliveryStart = firstEvent.delivery_start?.toISOString() ?? null;
    const nowMs = Date.now();
    const deliveryStartMs = firstEvent.delivery_start ? firstEvent.delivery_start.getTime() : null;
    const minsUntilDelivery = deliveryStartMs !== null
      ? Math.round((deliveryStartMs - nowMs) / 60_000)
      : null;
    const isComplete = seenIds.has(allSystems.rows[allSystems.rows.length - 1].id) &&
                       lastEvent.status === 'processed';
    const hasFailed = rows.some((r) => r.status === 'failed' || r.status === 'rejected');
    const totalJourneyMs = lastEvent.created_at.getTime() - firstEvent.created_at.getTime();

    res.json({
      correlationId,
      volumeMwh: parseFloat(firstEvent.volume_mwh),
      enteredAt: firstEvent.created_at,
      deliveryStart,
      minsUntilDelivery,
      journeyStatus: isComplete ? 'complete' : hasFailed ? 'failed' : 'in_flight',
      totalJourneyMs: isComplete || hasFailed ? totalJourneyMs : null,
      stages: journey,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
