import { useEffect, useState } from 'react';
import type { DrillDownDeal, DrillDownRequest, DrillDownResult, TimeWindow } from '../types';
import styles from './DrillDownPanel.module.css';

interface Props {
  request: DrillDownRequest | null;
  window: TimeWindow;
  onClose: () => void;
  onViewDeal: (correlationId: string) => void;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function DeliveryCell({ deal }: { deal: DrillDownDeal }) {
  if (!deal.deliveryStart) return <td className={styles.numCol}>—</td>;

  const mins = deal.minsUntilDelivery;
  let cls = styles.delivOk;
  let badge = '';

  if (!deal.isCompleted) {
    if (mins !== null && mins < 0)   { cls = styles.delivOverdue;  badge = 'OVERDUE'; }
    else if (mins !== null && mins <= 120) { cls = styles.delivCrit; badge = '⚡ CRITICAL'; }
    else if (mins !== null && mins <= 240) { cls = styles.delivWarn; badge = '⚠'; }
  }

  const timeStr = fmtDate(deal.deliveryStart);
  const remaining = mins !== null
    ? (mins < 0 ? `${Math.abs(mins)}m ago` : `in ${mins}m`)
    : '';

  return (
    <td className={`${styles.numCol} ${cls}`}>
      {badge && <span className={styles.urgencyBadge}>{badge}</span>}
      <span>{timeStr}</span>
      {remaining && <span className={styles.minsRemaining}> ({remaining})</span>}
    </td>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'processed'  ? styles.statusProcessed :
    status === 'failed'     ? styles.statusFailed    :
    status === 'pending'    ? styles.statusPending   :
                              styles.statusOther;
  const icon =
    status === 'processed'  ? '✓' :
    status === 'failed'     ? '✗' : '⋯';

  return <span className={`${styles.statusBadge} ${cls}`}>{icon} {status}</span>;
}

export function DrillDownPanel({ request, window, onClose, onViewDeal }: Props) {
  const [result, setResult] = useState<DrillDownResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!request) { setResult(null); return; }
    setLoading(true);
    setResult(null);
    const params = new URLSearchParams({ filter: request.filter, window });
    if (request.systemId)   params.set('systemId',     String(request.systemId));
    if (request.toSystemId) params.set('toSystemId',   String(request.toSystemId));
    if (request.filter === 'gap' && request.systemId) params.set('fromSystemId', String(request.systemId));
    fetch(`/api/deals/list?${params}`)
      .then((r) => r.json())
      .then((data: DrillDownResult) => setResult(data))
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }, [request, window]);

  if (!request) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.panelTitle}>{request.label}</span>
            {result && (
              <span className={styles.totalBadge}>{result.total} deal{result.total !== 1 ? 's' : ''}</span>
            )}
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {loading && (
          <div className={styles.loadingRow}>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </div>
        )}

        {!loading && result && result.deals.length === 0 && (
          <div className={styles.empty}>No deals match this filter in the selected window.</div>
        )}

        {!loading && result && result.deals.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Correlation ID</th>
                  <th className={styles.numCol}>Volume</th>
                  <th className={styles.numCol}>Entered</th>
                  <th className={styles.numCol}>Delivery Start</th>
                  <th>Last System</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.deals.map((deal) => (
                  <tr
                    key={deal.correlationId}
                    className={`${styles.row} ${deal.isCritical ? styles.rowCritical : ''}`}
                  >
                    <td className={styles.corrId}>
                      {deal.correlationId.substring(0, 8)}…{deal.correlationId.slice(-4)}
                    </td>
                    <td className={styles.numCol}>{deal.volumeMwh.toFixed(1)} MWh</td>
                    <td className={styles.numCol}>{fmtTime(deal.enteredAt)}</td>
                    <DeliveryCell deal={deal} />
                    <td>
                      <span
                        className={styles.systemBadge}
                        style={{
                          background:
                            deal.lastSystem === 'PACE'  ? '#e0f2fe' :
                            deal.lastSystem === 'VAT-P' ? '#ede9fe' :
                            deal.lastSystem === 'NEON'  ? '#d1fae5' :
                            deal.lastSystem === 'Endur' ? '#f3e8ff' : '#f1f5f9',
                          color:
                            deal.lastSystem === 'PACE'  ? '#0369a1' :
                            deal.lastSystem === 'VAT-P' ? '#5b21b6' :
                            deal.lastSystem === 'NEON'  ? '#065f46' :
                            deal.lastSystem === 'Endur' ? '#7e22ce' : '#475569',
                        }}
                      >
                        {deal.lastSystem}
                      </span>
                    </td>
                    <td><StatusBadge status={deal.lastStatus} /></td>
                    <td className={styles.errorCell} title={deal.errorMessage ?? ''}>
                      {deal.errorMessage ?? ''}
                    </td>
                    <td>
                      <button
                        className={styles.viewBtn}
                        onClick={() => { onViewDeal(deal.correlationId); onClose(); }}
                      >
                        Track →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.deals.length < result.total && (
              <div className={styles.limitNote}>Showing first {result.deals.length} of {result.total.toLocaleString()} deals — refine with a shorter time window</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
