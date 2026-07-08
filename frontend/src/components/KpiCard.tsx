import styles from './KpiCard.module.css';

interface Props {
  label: string;
  value: string;
  sub: string;
  accent?: 'blue' | 'purple' | 'green' | 'orange' | 'teal' | 'red';
  onClick?: () => void;
}

export function KpiCard({ label, value, sub, accent = 'blue', onClick }: Props) {
  return (
    <div className={`${styles.card} ${onClick ? styles.clickable : ''}`} onClick={onClick}>
      <div className={styles.label}>{label}</div>
      <div className={`${styles.value} ${styles[accent]}`}>
        {value}
        {onClick && <span className={styles.drillHint}> ↗</span>}
      </div>
      <div className={styles.sub}>{sub}</div>
    </div>
  );
}
