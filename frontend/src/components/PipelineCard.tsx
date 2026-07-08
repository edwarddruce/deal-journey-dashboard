import type { DrillDownFilter, PipelineSystem, ReconciliationRow } from '../types';
import styles from './PipelineCard.module.css';

interface Props {
  system: PipelineSystem;
  reconRow?: ReconciliationRow;
  bundleMode?: boolean;
  compact?: boolean;
  onDrillDown?: (filter: DrillDownFilter, systemId: number, systemName: string, label: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      <span className={styles.badgeDot} />
      {status.toUpperCase()}
    </span>
  );
}

function fmtMwh(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} TWh`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)} GWh`;
  return `${n.toFixed(1)} MWh`;
}

function fmtCount(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString();
}

function msgDiff(inVal: number | null, outVal: number | null): { pct: number; dropped: number } | null {
  if (inVal === null || outVal === null || inVal === 0) return null;
  const dropped = inVal - outVal;
  return { pct: (dropped / inVal) * 100, dropped };
}

export function PipelineCard({ system, reconRow, bundleMode = false, compact = false, onDrillDown }: Props) {
  const hasErrors = !bundleMode && system.failedCount > 0;
  const drill = (filter: DrillDownFilter, label: string) =>
    onDrillDown?.(filter, system.id, system.name, label);
  return (
    <div className={`${styles.card} ${styles[system.status]} ${compact ? styles.compact : ''}`}>
      <div className={styles.cardHeader}>
        <span className={styles.systemName}>{system.name}</span>
        <StatusBadge status={system.status} />
        <span className={styles.chevron}>▲</span>
      </div>

      <div className={styles.metrics}>
        <div>
          <div className={styles.metricLabel}>{bundleMode ? 'BUNDLE COUNT' : 'DEAL COUNT'}</div>
          <div
            className={`${styles.metricValue} ${!bundleMode && onDrillDown ? styles.drillable : ''}`}
            onClick={() => !bundleMode && drill('all', `All deals at ${system.name}`)}
          >
            {system.dealCount.toLocaleString()}
          </div>
          {hasErrors && (
            <div className={styles.errorLine}>
              {system.failedCount > 0 && (
                <span
                  className={`${styles.failed} ${onDrillDown ? styles.drillable : ''}`}
                  onClick={() => drill('failed', `Failed deals at ${system.name}`)}
                >
                  {system.failedCount} failed
                </span>
              )}
            </div>
          )}
          {!bundleMode && reconRow && reconRow.pending > 0 && (
            <div className={styles.pendingLine}>
              <span className={styles.pending}>{reconRow.pending} pending</span>
            </div>
          )}
          {!bundleMode && reconRow && reconRow.criticalStuck > 0 && (
            <div
              className={`${styles.criticalStuckLine} ${onDrillDown ? styles.drillable : ''}`}
              onClick={() => drill('critical_at_risk', `⚡ Critical stuck at ${system.name}`)}
            >
              ⚡ {reconRow.criticalStuck} critical stuck
            </div>
          )}
        </div>
        <div>
          <div className={styles.metricLabel}>POSITION (MWh)</div>
          <div className={`${styles.metricValue} ${styles.teal}`}>{fmtMwh(system.positionMwh)}</div>
          {system.successRate !== null && !compact && (
            <div className={styles.successRate}>
              <span
                className={system.successRate >= 95 ? styles.rateGood : system.successRate >= 80 ? styles.rateWarn : styles.rateBad}
              >
                {system.successRate.toFixed(1)}% success
              </span>
            </div>
          )}
        </div>
      </div>

      {!compact && (
      <div className={styles.mwSection}>
        <div className={styles.mwLabelRow}>
          <span className={styles.mwLabel}>KAFKA TOPICS</span>
          <span className={styles.mwColHdr}>IN</span>
          <span className={styles.mwColHdr}>OUT</span>
          <span className={styles.mwColHdrDrop} />
        </div>
        {system.middleware.map((mc) => {
          const diff = msgDiff(mc.messagesIn, mc.messagesOut);
          const hasDrop = diff !== null && diff.dropped > 0;
          return (
            <div key={mc.name} className={styles.mwRow}>
              <span className={`${styles.mwDot} ${styles[mc.status]}`} />
              <span className={styles.mwName}>{mc.name}</span>
              <span className={styles.mwIn}>{fmtCount(mc.messagesIn)}</span>
              <span className={`${styles.mwOut} ${hasDrop ? styles.mwDrop : ''}`}>
                {mc.messagesOut !== mc.messagesIn ? fmtCount(mc.messagesOut) : ''}
              </span>
              <span className={styles.mwDropCol}>
                {hasDrop && mc.messagesOut !== 0 && (
                  <span className={styles.mwDropBadge}>−{diff!.dropped.toLocaleString()}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
