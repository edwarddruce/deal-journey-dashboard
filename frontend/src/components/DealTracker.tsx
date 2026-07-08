import { useState, useRef, useEffect, useCallback } from 'react';
import type { DealJourney, DealStage } from '../types';
import { SYSTEM_COLORS } from '../types';
import styles from './DealTracker.module.css';

function systemKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function fmtLag(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${(ms / 60_000).toFixed(1)}m`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtDelivery(iso: string | null, minsUntil: number | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function DeliveryBanner({ journey }: { journey: DealJourney }) {
  if (!journey.deliveryStart) return null;

  const mins = journey.minsUntilDelivery;
  const isComplete = journey.journeyStatus === 'complete';

  let urgency: 'ok' | 'warn' | 'critical' | 'overdue' = 'ok';
  if (!isComplete) {
    if (mins !== null && mins < 0) urgency = 'overdue';
    else if (mins !== null && mins <= 120) urgency = 'critical';
    else if (mins !== null && mins <= 240) urgency = 'warn';
  }

  const label =
    urgency === 'overdue'   ? `⚡ OVERDUE — delivery was ${Math.abs(mins!)} min ago` :
    urgency === 'critical'  ? `⚡ CRITICAL — delivery in ${mins} min` :
    urgency === 'warn'      ? `⚠ Delivery in ${mins} min` :
    isComplete              ? `✓ Delivery ${fmtDelivery(journey.deliveryStart, mins)}` :
                              `Delivery ${fmtDelivery(journey.deliveryStart, mins)}`;

  const cls =
    urgency === 'overdue'  ? styles.deliveryOverdue  :
    urgency === 'critical' ? styles.deliveryCritical :
    urgency === 'warn'     ? styles.deliveryWarn     :
    isComplete             ? styles.deliveryOk       :
                             styles.deliveryNeutral;

  return (
    <div className={`${styles.deliveryBanner} ${cls}`}>
      <span className={styles.deliveryLabel}>DELIVERY START</span>
      <span className={styles.deliveryValue}>{fmtDelivery(journey.deliveryStart, mins)}</span>
      {urgency !== 'ok' && !isComplete && (
        <span className={styles.deliveryUrgency}>{label}</span>
      )}
    </div>
  );
}

// NEON is the most timing-sensitive stage — flag lag > 5 min as critical, > 2 min as warning
const NEON_CRITICAL_MS = 5 * 60_000;
const NEON_WARN_MS = 2 * 60_000;

function StageNode({ stage, isLast }: { stage: DealStage; isLast: boolean }) {
  const color = SYSTEM_COLORS[systemKey(stage.systemName)] ?? '#94a3b8';
  const statusClass = styles[`stage_${stage.status}`] ?? '';

  const isNeon = stage.systemName.toUpperCase() === 'NEON';
  const lagIsCritical = isNeon && stage.lagFromPreviousMs !== null && stage.lagFromPreviousMs >= NEON_CRITICAL_MS;
  const lagIsWarn = isNeon && !lagIsCritical && stage.lagFromPreviousMs !== null && stage.lagFromPreviousMs >= NEON_WARN_MS;

  const icon =
    stage.status === 'processed'   ? '✓' :
    stage.status === 'failed'      ? '✗' :
    stage.status === 'not_reached' ? '○' : '⋯';

  return (
    <div className={styles.stageWrap}>
      <div className={styles.stageCol}>
        {/* Lag label from previous stage */}
        {stage.lagFromPreviousMs !== null && (
          <div className={
            `${styles.lagLabel}
            ${lagIsCritical ? styles.lagCritical : ''}
            ${lagIsWarn ? styles.lagWarn : ''}`.trim()
          }>
            {lagIsCritical && '⚡ '}{fmtLag(stage.lagFromPreviousMs)}
          </div>
        )}
        <div
          className={`${styles.stageNode} ${statusClass}`}
          style={stage.status !== 'not_reached' ? { borderColor: color } : {}}
        >
          <span className={styles.stageIcon} style={stage.status !== 'not_reached' ? { color } : {}}>
            {icon}
          </span>
          <span className={styles.stageName}>{stage.systemName}</span>
          {stage.processedAt && (
            <span className={styles.stageTime}>{fmtTime(stage.processedAt)}</span>
          )}
        </div>
        {stage.errorMessage && (
          <div className={styles.stageError}>{stage.errorMessage}</div>
        )}
      </div>
      {!isLast && (
        <div className={styles.connector}>
          <svg width="32" height="2"><line x1="0" y1="1" x2="32" y2="1" stroke="#e2e8f0" strokeWidth="2" /></svg>
        </div>
      )}
    </div>
  );
}

function JourneyResult({ journey }: { journey: DealJourney }) {
  const statusClass =
    journey.journeyStatus === 'complete'  ? styles.journeyComplete  :
    journey.journeyStatus === 'failed'    ? styles.journeyFailed    :
                                            styles.journeyInFlight;
  const statusLabel =
    journey.journeyStatus === 'complete'  ? 'COMPLETE' :
    journey.journeyStatus === 'failed'    ? 'FAILED'   : 'IN FLIGHT';

  return (
    <div className={styles.result}>
      <div className={styles.resultHeader}>
        <div>
          <div className={styles.corrId}>{journey.correlationId}</div>
          <div className={styles.resultMeta}>
            <span>{journey.volumeMwh.toFixed(1)} MWh</span>
            <span className={styles.dot}>·</span>
            <span>Entered PACE {fmtTime(journey.enteredAt)}</span>
            {journey.totalJourneyMs !== null && (
              <>
                <span className={styles.dot}>·</span>
                <span>Total: {fmtDuration(journey.totalJourneyMs)}</span>
              </>
            )}
          </div>
        </div>
        <span className={`${styles.journeyBadge} ${statusClass}`}>{statusLabel}</span>
      </div>

      <DeliveryBanner journey={journey} />

      <div className={styles.stagesRow}>
        {journey.stages.map((stage, i) => (
          <StageNode key={stage.systemId} stage={stage} isLast={i === journey.stages.length - 1} />
        ))}
      </div>
    </div>
  );
}

export function DealTracker({ externalId }: { externalId?: string | null }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [journey, setJourney] = useState<DealJourney | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lookup = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setShowSuggestions(false);
    setSuggestions([]);
    setLoading(true);
    setError(null);
    setJourney(null);
    try {
      const res = await fetch(`/api/deal/${encodeURIComponent(id.trim())}`);
      if (res.status === 404) { setError('Deal not found'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: DealJourney = await res.json();
      setJourney(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search-as-you-type
  const handleQueryChange = (val: string) => {
    setQuery(val);
    setJourney(null);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length < 4) { setSuggestions([]); setShowSuggestions(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/deal/search?q=${encodeURIComponent(val.trim())}`);
        if (!res.ok) return;
        const data = await res.json();
        setSuggestions(data.results ?? []);
        setShowSuggestions((data.results ?? []).length > 0);
      } catch { /* ignore */ }
    }, 250);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        !inputRef.current?.contains(e.target as Node) &&
        !suggestRef.current?.contains(e.target as Node)
      ) setShowSuggestions(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Auto-load when an external correlation ID is pushed in
  useEffect(() => {
    if (externalId) {
      setQuery(externalId);
      lookup(externalId);
    }
  }, [externalId, lookup]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { lookup(query); }
    if (e.key === 'Escape') { setShowSuggestions(false); }
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionLabel}>DEAL TRACKER</div>
      <div className={styles.searchRow}>
        <div className={styles.inputWrap}>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Type a correlation ID (UUID)…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            spellCheck={false}
            autoComplete="off"
          />
          {showSuggestions && (
            <div ref={suggestRef} className={styles.suggestions}>
              {suggestions.map((id) => (
                <button
                  key={id}
                  className={styles.suggestionItem}
                  onMouseDown={(e) => { e.preventDefault(); setQuery(id); lookup(id); }}
                >
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className={styles.searchBtn}
          onClick={() => lookup(query)}
          disabled={loading || !query.trim()}
        >
          {loading ? 'Looking up…' : 'Track Deal'}
        </button>
      </div>

      {error && <div className={styles.errorMsg}>{error}</div>}
      {journey && <JourneyResult journey={journey} />}

      {!journey && !error && !loading && (
        <div className={styles.placeholder}>
          Enter a <code>correlation_id</code> to trace a single deal across all systems.
        </div>
      )}
    </section>
  );
}
