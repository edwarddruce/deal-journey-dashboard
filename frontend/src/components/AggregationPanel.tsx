import { useEffect, useState } from 'react';
import type { AggBundle, AggBundleDeal, AggStage, TimeWindow } from '../types';
import styles from './AggregationPanel.module.css';

interface Props {
  stage: AggStage | null;
  window: TimeWindow;
  onClose: () => void;
  onViewDeal: (correlationId: string) => void;
}

const STAGE_LABELS: Record<AggStage, { title: string; from: string; to: string }> = {
  vat_p_neon: { title: 'VAT-P → NEON Aggregation', from: 'VAT-P', to: 'NEON' },
  neon_endur: { title: 'NEON → Endur Aggregation',  from: 'NEON',  to: 'Endur' },
};

const WINDOW_LABELS: Record<string, string> = {
  '1m':    'last minute',
  '10m':   'last 10 min',
  '15m':   'last 15 min',
  '30m':   'last 30 min',
  '1h':    'last hour',
  '24h':   'last 24 hours',
  'today': 'today',
};

const PRODUCT_COLORS: Record<string, string> = {
  'Power Base':    '#7c3aed',
  'Power Peak':    '#d97706',
  'Power HH':      '#059669',
  'Power Off-Peak':'#0284c7',
  'Power Spreads': '#e11d48',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

// Format a delivery period as "01 Jul 14:00"
function fmtPeriod(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

function fmtMwh(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} GWh`;
  return `${n.toFixed(1)} MWh`;
}

function DeliveryCell({ mins }: { mins: number | null }) {
  if (mins === null) return <span>—</span>;
  if (mins < 0)   return <span className={styles.delivOverdue}>OVERDUE</span>;
  if (mins <= 120) return <span className={styles.delivCrit}>⚡ {mins}m</span>;
  if (mins <= 240) return <span className={styles.delivWarn}>{Math.floor(mins / 60)}h {mins % 60}m</span>;
  const h = Math.floor(mins / 60);
  return <span>{h}h</span>;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'processed' ? styles.statusProcessed :
    status === 'failed'    ? styles.statusFailed    :
    status === 'pending'   ? styles.statusPending   : styles.statusOther;
  return <span className={`${styles.statusBadge} ${cls}`}>{status}</span>;
}

function BundleRow({
  bundle,
  isExpanded,
  deals,
  loadingDeals,
  onToggle,
  onViewDeal,
}: {
  bundle: AggBundle;
  isExpanded: boolean;
  deals: AggBundleDeal[] | null;
  loadingDeals: boolean;
  onToggle: () => void;
  onViewDeal: (id: string) => void;
}) {
  const productColor = PRODUCT_COLORS[bundle.product ?? ''] ?? '#64748b';

  return (
    <div className={styles.bundleWrap}>
      <button className={`${styles.bundleRow} ${isExpanded ? styles.bundleRowOpen : ''}`} onClick={onToggle}>
        <span className={styles.bundleChevron}>{isExpanded ? '▾' : '▸'}</span>
        <span className={styles.bundleDelivery}>{fmtPeriod(bundle.deliveryPeriod)}</span>
        <span className={styles.bundleProduct} style={{ color: productColor }}>
          {bundle.product ?? '—'}
        </span>
        <span className={styles.bundleCounterparty}>{bundle.counterparty ?? '—'}</span>
        <span className={styles.bundleCount}>
          <strong>{bundle.dealCount}</strong> deals
        </span>
        <span className={styles.bundleMwh}>{fmtMwh(bundle.totalMwh)}</span>
        <span className={`${styles.bundleStatusBadge} ${
          bundle.bundleStatus === 'processed' ? styles.bundleStatusOk :
          bundle.bundleStatus === 'failed'    ? styles.bundleStatusFail :
                                               styles.bundleStatusPending
        }`}>{bundle.bundleStatus}</span>
      </button>

      {isExpanded && (
        <div className={styles.dealList}>
          {loadingDeals && (
            <div className={styles.loadingRow}>
              {[1, 2, 3].map((n) => <div key={n} className={styles.skeleton} />)}
            </div>
          )}
          {!loadingDeals && deals && deals.length === 0 && (
            <div className={styles.empty}>No deals found for this bundle.</div>
          )}
          {!loadingDeals && deals && deals.length > 0 && (
            <table className={styles.dealTable}>
              <thead>
                <tr>
                  <th>Correlation ID</th>
                  <th className={styles.numCol}>Volume</th>
                  <th>Status</th>
                  <th>Last System</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.correlationId}>
                    <td className={styles.corrId}>{d.correlationId.substring(0, 18)}…</td>
                    <td className={styles.numCol}>{d.volumeMwh.toFixed(1)} MWh</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td className={styles.systemCell}>{d.lastSystem}</td>
                    <td>
                      <button
                        className={styles.trackBtn}
                        onClick={() => onViewDeal(d.correlationId)}
                      >
                        Track →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export function AggregationPanel({ stage, window, onClose, onViewDeal }: Props) {
  const [bundles, setBundles]       = useState<AggBundle[]>([]);
  const [loadingBundles, setLoadingBundles] = useState(false);
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [dealCache, setDealCache]   = useState<Record<string, AggBundleDeal[]>>({});
  const [loadingDeal, setLoadingDeal] = useState<string | null>(null);

  const [individualDeals, setIndividualDeals] = useState<AggBundleDeal[]>([]);
  const [individualTotal, setIndividualTotal] = useState(0);
  const [loadingIndividual, setLoadingIndividual] = useState(false);
  const [showIndividual, setShowIndividual] = useState(false);

  // Fetch bundle list when stage/window changes
  useEffect(() => {
    if (!stage) return;
    setLoadingBundles(true);
    setBundles([]);
    setExpanded(null);

    fetch(`/api/aggregations/bundles?stage=${stage}&window=${window}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setBundles(d.bundles ?? []); })
      .catch(() => {})
      .finally(() => setLoadingBundles(false));
  }, [stage, window]);

  // Fetch individual (non-bundled) deals when stage/window changes
  useEffect(() => {
    if (!stage) return;
    setLoadingIndividual(true);
    setIndividualDeals([]);
    setIndividualTotal(0);
    setShowIndividual(false);

    fetch(`/api/aggregations/individual?stage=${stage}&window=${window}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) {
          setIndividualDeals(d.deals ?? []);
          setIndividualTotal(d.total ?? 0);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingIndividual(false));
  }, [stage, window]);

  const toggleBundle = async (aggId: string) => {
    if (expanded === aggId) { setExpanded(null); return; }
    setExpanded(aggId);
    if (dealCache[aggId]) return;

    setLoadingDeal(aggId);
    try {
      const res = await fetch(`/api/aggregations/bundle/${aggId}?window=${window}`);
      if (res.ok) {
        const d = await res.json();
        setDealCache((prev) => ({ ...prev, [aggId]: d.deals ?? [] }));
      }
    } catch { /* ignore */ } finally {
      setLoadingDeal(null);
    }
  };

  if (!stage) return null;

  const meta = STAGE_LABELS[stage];
  const totalDeals = bundles.reduce((s, b) => s + b.dealCount, 0);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.panelTitle}>{meta.title}</span>
            <span className={styles.headerMeta}>
              {(loadingBundles || loadingIndividual) ? '…' : `${bundles.length} bundles (${totalDeals.toLocaleString()} bundled) · ${individualTotal.toLocaleString()} individual · ${WINDOW_LABELS[window] ?? window}`}
            </span>
            <span className={styles.stagePill}>{meta.from} → {meta.to}</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.explainer}>
          Deals with the same 30-minute delivery period, product, and counterparty are grouped into
          aggregation bundles before being passed to <strong>{meta.to}</strong>.
          Showing bundles active in the {WINDOW_LABELS[window] ?? window}. Not all deals are bundled — unbundled deals flow individually. Click a bundle to see its deals.
        </div>

        <div className={styles.bundlesWrap}>
          {loadingBundles && (
            <div className={styles.loadingRow}>
              {[1, 2, 3, 4].map((n) => <div key={n} className={styles.skeleton} />)}
            </div>
          )}
          {!loadingBundles && bundles.length === 0 && (
            <div className={styles.empty}>No aggregation bundles in this time window.</div>
          )}
          {!loadingBundles && bundles.map((b) => (
            <BundleRow
              key={b.aggId}
              bundle={b}
              isExpanded={expanded === b.aggId}
              deals={dealCache[b.aggId] ?? null}
              loadingDeals={loadingDeal === b.aggId}
              onToggle={() => toggleBundle(b.aggId)}
              onViewDeal={(id) => { onClose(); onViewDeal(id); }}
            />
          ))}

          {/* Individual (non-bundled) deals section */}
          <button
            className={`${styles.sectionDivider} ${showIndividual ? styles.sectionDividerOpen : ''}`}
            onClick={() => setShowIndividual((v) => !v)}
          >
            <span className={styles.sectionChevron}>{showIndividual ? '▾' : '▸'}</span>
            Individual (unbundled) deals
            <span className={styles.indCount}>
              {loadingIndividual ? '…' : individualTotal.toLocaleString()}
            </span>
          </button>

          {showIndividual && (
            <div>
              {loadingIndividual && (
                <div className={styles.loadingRow}>
                  {[1, 2, 3].map((n) => <div key={n} className={styles.skeleton} />)}
                </div>
              )}
              {!loadingIndividual && individualDeals.length === 0 && (
                <div className={styles.empty}>No individual deals in this time window.</div>
              )}
              {!loadingIndividual && individualDeals.length > 0 && (
                <>
                  <table className={styles.dealTable}>
                    <thead>
                      <tr>
                        <th>Correlation ID</th>
                        <th className={styles.numCol}>Volume</th>
                        <th>Status</th>
                        <th>Last System</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {individualDeals.map((d) => (
                        <tr key={d.correlationId}>
                          <td className={styles.corrId}>{d.correlationId.substring(0, 18)}…</td>
                          <td className={styles.numCol}>{d.volumeMwh.toFixed(1)} MWh</td>
                          <td><StatusBadge status={d.status} /></td>
                          <td className={styles.systemCell}>{d.lastSystem}</td>
                          <td>
                            <button
                              className={styles.trackBtn}
                              onClick={() => { onClose(); onViewDeal(d.correlationId); }}
                            >
                              Track →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {individualTotal > individualDeals.length && (
                    <div className={styles.indLimitNote}>
                      Showing first {individualDeals.length} of {individualTotal.toLocaleString()} — refine with a shorter time window
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
