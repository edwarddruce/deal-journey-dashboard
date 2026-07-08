import { useState } from 'react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea,
} from 'recharts';
import type { DeliveryChartPoint } from '../types';
import { SYSTEM_COLORS } from '../types';
import styles from './PositionChart.module.css';

interface Props {
  data: DeliveryChartPoint[];
  window: string;
  systemNames: string[];
}

function sysKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function fmtYAxis(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(0)}TWh`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(0)}GWh`;
  return `${val}MWh`;
}

function fmtTooltip(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)} TWh`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(2)} GWh`;
  return `${val.toLocaleString()} MWh`;
}

export function PositionChart({ data, window, systemNames }: Props) {
  const keys = systemNames.map(sysKey);
  const [horizon, setHorizon] = useState<12 | 24 | 48>(48);
  const visibleData = horizon === 24 ? data.slice(0, 24) : horizon === 12 ? data.slice(0, 12) : data;

  // MWh unconfirmed at NEON in the critical 2-hour window
  const criticalNeonGapMwh = visibleData.slice(0, 2).reduce((sum, d) => {
    const vatp = typeof d['vat_p'] === 'number' ? d['vat_p'] as number : 0;
    const neon = typeof d['neon'] === 'number' ? d['neon'] as number : 0;
    return sum + Math.max(0, vatp - neon);
  }, 0);
  function fmtMwh(n: number) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} TWh`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)} GWh`;
    return `${Math.round(n).toLocaleString()} MWh`;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.chartHeader}>
        <span className={styles.chartTitle}>
          VOLUME BY DELIVERY HOUR (MWh) — NEXT {horizon} HOURS
        </span>
        <div className={styles.controls}>
          <div className={styles.horizonToggle}>
            {([12, 24, 48] as const).map((h) => (
              <button
                key={h}
                className={`${styles.horizonBtn} ${horizon === h ? styles.horizonBtnActive : ''}`}
                onClick={() => setHorizon(h)}
              >
                {h}h
              </button>
            ))}
          </div>
          {criticalNeonGapMwh > 0 && (
            <span className={styles.neonGapBadge}>
              ⚡ {fmtMwh(criticalNeonGapMwh)} unconfirmed at NEON
            </span>
          )}
          <div className={styles.legend}>
          {keys.map((k) => (
            <span key={k} className={styles.legendItem}>
              <span
                className={styles.legendDot}
                style={{ background: SYSTEM_COLORS[k] ?? '#94a3b8' }}
              />
              {k.replace(/_/g, '-').toUpperCase()}
            </span>
          ))}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={visibleData} margin={{ top: 8, right: 16, left: 16, bottom: 48 }} barCategoryGap="10%">
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
          <XAxis
            dataKey="label"
            angle={-45}
            textAnchor="end"
            tick={{ fontSize: 11, fill: '#94a3b8', dy: 4 }}
            tickLine={false}
            axisLine={{ stroke: '#e2e8f0' }}
            interval={3}
          />
          <YAxis
            tickFormatter={fmtYAxis}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            width={56}
          />
          {visibleData.length >= 2 && (
            <ReferenceArea
              x1={visibleData[0].label}
              x2={visibleData[1].label}
              fill="#fef2f2"
              fillOpacity={1}
              stroke="#fca5a5"
              strokeOpacity={0.6}
              label={{ value: '⚡ NEXT 2H', position: 'insideTopLeft', fontSize: 9, fontWeight: 700, fill: '#ef4444' }}
            />
          )}
          <Tooltip
            formatter={(val: number, name: string) => [
              fmtTooltip(val),
              (name as string).replace(/_/g, '-').toUpperCase(),
            ]}
            contentStyle={{ fontSize: 12, border: '1px solid #e2e8f0', borderRadius: 8 }}
            labelStyle={{ color: '#64748b', fontWeight: 600 }}
            labelFormatter={(label) => `Delivery: ${label}`}
            cursor={{ fill: '#f0fdfa' }}
          />
          {keys.map((k) => (
            <Bar
              key={k}
              dataKey={k}
              name={k}
              fill={SYSTEM_COLORS[k] ?? '#94a3b8'}
              fillOpacity={0.85}
              radius={[3, 3, 0, 0]}
              maxBarSize={40}
            >
              {k === 'neon' && visibleData.map((_d, i) => (
                <Cell
                  key={`neon-${i}`}
                  fill={i < 2 ? '#ef4444' : (SYSTEM_COLORS['neon'] ?? '#94a3b8')}
                  fillOpacity={i < 2 ? 0.9 : 0.85}
                />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
