import type { DashboardSummary, TimeWindow } from '../types';
import styles from './Header.module.css';

interface Props {
  summary: DashboardSummary | null;
  window: TimeWindow;
  onWindowChange: (w: TimeWindow) => void;
  isLive: boolean;
  onToggleLive: () => void;
  onRefresh: () => void;
  seedingPaused: boolean;
  onToggleSeeding: () => void;
}

const WINDOWS: TimeWindow[] = ['1m', '10m', '15m', '30m', '1h', '24h', 'today'];

export function Header({ summary, window, onWindowChange, isLive, onToggleLive, onRefresh, seedingPaused, onToggleSeeding }: Props) {
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const status = summary?.overallStatus ?? 'online';

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.logo}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </span>
        <span className={styles.title}>DEAL JOURNEY</span>
        <span className={styles.divider}>|</span>
        <span className={`${styles.statusBadge} ${styles[status]}`}>
          <span className={styles.statusDot} />
          {status.toUpperCase()}
        </span>
      </div>

      <div className={styles.center}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            className={`${styles.windowBtn} ${window === w ? styles.active : ''}`}
            onClick={() => onWindowChange(w)}
          >
            {w}
          </button>
        ))}
      </div>

      <div className={styles.right}>
        <button
          className={`${styles.seedBtn} ${seedingPaused ? styles.seedPaused : styles.seedActive}`}
          onClick={onToggleSeeding}
          title={seedingPaused ? 'Resume live deal seeding' : 'Pause live deal seeding'}
        >
          {seedingPaused ? '▶ SEEDING' : '⏸ SEEDING'}
        </button>
        <button
          className={`${styles.liveBtn} ${isLive ? styles.liveActive : ''}`}
          onClick={onToggleLive}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 12.55a11 11 0 0 1 14.08 0" />
            <path d="M1.42 9a16 16 0 0 1 21.16 0" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <circle cx="12" cy="20" r="1" fill="currentColor" />
          </svg>
          LIVE
        </button>
        <button className={styles.refreshBtn} onClick={onRefresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          REFRESH
        </button>
        <span className={styles.clock}>{now}</span>
      </div>
    </header>
  );
}
