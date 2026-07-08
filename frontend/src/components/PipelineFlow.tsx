import type { PipelineSystem } from '../types';
import { SYSTEM_COLORS } from '../types';
import styles from './PipelineFlow.module.css';

interface Props {
  systems: PipelineSystem[];
}

function systemKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

export function PipelineFlow({ systems }: Props) {
  // VAT-P and PACE are peers — render them as a stacked pair with no arrow between them.
  // All other transitions show a normal arrow.
  const paceSystem = systems.find((s) => s.name === 'PACE');
  const displaySystems = systems.filter((s) => s.name !== 'PACE');

  return (
    <div className={styles.flow}>
      {displaySystems.map((sys, i) => (
        <div key={sys.id} className={styles.nodeWrap}>
          {sys.name === 'VAT-P' ? (
            // Render VAT-P and PACE stacked — they receive deals simultaneously
            <span className={styles.peerNodes}>
              <span
                className={`${styles.node} ${styles[sys.status]}`}
                style={{ borderColor: SYSTEM_COLORS[systemKey(sys.name)] ?? '#64748b' }}
              >
                <span className={styles.dot} style={{ background: SYSTEM_COLORS[systemKey(sys.name)] ?? '#64748b' }} />
                {sys.name}
              </span>
              {paceSystem && (
                <span
                  className={`${styles.node} ${styles[paceSystem.status]}`}
                  style={{ borderColor: SYSTEM_COLORS[systemKey(paceSystem.name)] ?? '#64748b' }}
                >
                  <span className={styles.dot} style={{ background: SYSTEM_COLORS[systemKey(paceSystem.name)] ?? '#64748b' }} />
                  {paceSystem.name}
                </span>
              )}
            </span>
          ) : (
            <span
              className={`${styles.node} ${styles[sys.status]}`}
              style={{ borderColor: SYSTEM_COLORS[systemKey(sys.name)] ?? '#64748b' }}
            >
              <span className={styles.dot} style={{ background: SYSTEM_COLORS[systemKey(sys.name)] ?? '#64748b' }} />
              {sys.name}
            </span>
          )}
          {i < displaySystems.length - 1 && (
            <span className={styles.arrow}>——&gt;</span>
          )}
        </div>
      ))}
    </div>
  );
}
