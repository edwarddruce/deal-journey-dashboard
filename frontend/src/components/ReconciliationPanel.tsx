import type { DrillDownFilter, ReconciliationData, ReconciliationRow } from '../types';
import { SYSTEM_COLORS } from '../types';
import styles from './ReconciliationPanel.module.css';

interface Props {
  data: ReconciliationData | null;
  loading: boolean;
  onDrillDown?: (filter: DrillDownFilter, systemId?: number, systemName?: string, label?: string) => void;
}

function systemColorKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function deltaClass(pct: number | null): string {
  if (pct === null) return '';
  if (pct <= 2)  return styles.deltaGood;
  if (pct <= 10) return styles.deltaWarn;
  return styles.deltaBad;
}

function DeltaConnector({ row }: { row: ReconciliationRow }) {
  if (row.deltaFromPrevious === null) return null;

  const pct = row.deltaFromPreviousPct ?? 0;
  const loss = row.deltaFromPrevious;

  return (
    <div className={styles.connector}>
      <div className={styles.connectorLine} />
      <div className={`${styles.deltaChip} ${deltaClass(pct)}`}>
        {loss > 0 ? (
          <>
            <span className={styles.deltaArrow}>▼</span>
            <span className={styles.deltaCount}>{loss.toLocaleString()}</span>
            <span className={styles.deltaPct}>({pct.toFixed(1)}%)</span>
          </>
        ) : (
          <span className={styles.deltaGainText}>+{Math.abs(loss)}</span>
        )}
      </div>
    </div>
  );
}

function SystemBlock({ row }: { row: ReconciliationRow }) {
  const colorKey = systemColorKey(row.name);
  const color = SYSTEM_COLORS[colorKey] ?? '#94a3b8';
  const total = row.totalDeals;
  const hasCritical = row.criticalStuck > 0;

  return (
    <div className={`${styles.systemBlock} ${hasCritical ? styles.systemBlockCritical : ''}`}>
      <div className={styles.systemHeader}>
        <span
          className={styles.systemDot}
          style={{ background: row.status === 'online' ? '#10b981' : row.status === 'degraded' ? '#f59e0b' : '#ef4444' }}
        />
        <span className={styles.systemName}>{row.name}</span>
        {hasCritical && (
          <span className={styles.criticalBadge}>⚡ {row.criticalStuck} critical</span>
        )}
      </div>

      <div className={styles.dealCount} style={{ color }}>
        {total.toLocaleString()}
      </div>
      <div className={styles.dealLabel}>deals</div>

      <div className={styles.statusBreakdown}>
        {row.processed > 0 && (
          <span className={`${styles.pill} ${styles.pillProcessed}`}>
            ✓ {row.processed.toLocaleString()}
          </span>
        )}
        {row.failed > 0 && (
          <span className={`${styles.pill} ${styles.pillFailed}`}>
            ✗ {row.failed.toLocaleString()}
          </span>
        )}
        {row.pending > 0 && (
          <span className={`${styles.pill} ${styles.pillPending}`}>
            ⏳ {row.pending.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

export function ReconciliationPanel({ data, loading, onDrillDown }: Props) {
  if (loading || !data) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.sectionLabel}>DEAL COUNT RECONCILIATION</div>
        <div className={styles.skeleton} />
      </div>
    );
  }

  const { systems, vatpTotal, endurTotal, totalLoss, totalLossPct } = data;

  const healthClass =
    totalLossPct <= 5  ? styles.healthGood :
    totalLossPct <= 15 ? styles.healthWarn :
    styles.healthBad;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.sectionLabel}>DEAL COUNT RECONCILIATION</span>
        <span className={`${styles.summaryBadge} ${healthClass}`}>
          End-to-end loss: {totalLoss > 0 ? `${totalLoss.toLocaleString()} deals (${totalLossPct}%)` : 'none'}
        </span>
      </div>

      <div className={styles.funnel}>
        {systems.map((row, i) => (
          <div key={row.id} className={styles.funnelSegment}>
            {i > 0 && <DeltaConnector row={row} />}
            <SystemBlock row={row} />
          </div>
        ))}
      </div>

      {/* Detail table */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>System</th>
              <th className={styles.numCol}>Total</th>
              <th className={styles.numCol}>Processed</th>
              <th className={styles.numCol}>Failed</th>
              <th className={styles.numCol}>Pending</th>
              <th className={styles.numCol}>⚡ Critical</th>
              <th className={styles.numCol}>Drop vs prev</th>
            </tr>
          </thead>
          <tbody>
            {systems.map((row) => (
              <tr key={row.id}>
                <td>
                  <span
                    className={styles.tableSystemDot}
                    style={{
                      background: row.status === 'online' ? '#10b981'
                        : row.status === 'degraded' ? '#f59e0b' : '#ef4444',
                    }}
                  />
                  {row.name}
                </td>
                <td
                  className={`${styles.numCol} ${onDrillDown ? styles.drillable : ''}`}
                  onClick={() => onDrillDown?.('all', row.id, row.name, `All deals at ${row.name}`)}
                >
                  <strong>{row.totalDeals.toLocaleString()}</strong>
                </td>
                <td className={`${styles.numCol} ${styles.colProcessed}`}>
                  {row.processed.toLocaleString()}
                </td>
                <td
                  className={`${styles.numCol} ${row.failed > 0 ? styles.colFailed : ''} ${row.failed > 0 && onDrillDown ? styles.drillable : ''}`}
                  onClick={() => row.failed > 0 && onDrillDown?.('failed', row.id, row.name, `Failed deals at ${row.name}`)}
                >
                  {row.failed.toLocaleString()}
                </td>
                <td className={styles.numCol}>
                  {row.pending.toLocaleString()}
                </td>
                <td
                  className={`${styles.numCol} ${row.criticalStuck > 0 ? styles.colCritical : ''} ${row.criticalStuck > 0 && onDrillDown ? styles.drillable : ''}`}
                  onClick={() => row.criticalStuck > 0 && onDrillDown?.('critical_at_risk', row.id, row.name, `⚡ Critical deals stuck at ${row.name}`)}
                >
                  {row.criticalStuck > 0 ? `⚡ ${row.criticalStuck}` : '—'}
                </td>
                <td className={`${styles.numCol} ${deltaClass(row.deltaFromPreviousPct)}`}>
                  {row.deltaFromPrevious === null ? '—' : (
                    row.deltaFromPrevious > 0
                      ? `▼ ${row.deltaFromPrevious.toLocaleString()} (${row.deltaFromPreviousPct}%)`
                      : row.deltaFromPrevious < 0
                        ? `▲ ${Math.abs(row.deltaFromPrevious).toLocaleString()}`
                        : '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={styles.totalsRow}>
              <td>VAT-P → Endur</td>
              <td className={styles.numCol}>{vatpTotal.toLocaleString()}</td>
              <td colSpan={4} />
              <td className={`${styles.numCol} ${healthClass}`}>
                {totalLoss > 0
                  ? `▼ ${totalLoss.toLocaleString()} (${totalLossPct}%)`
                  : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
