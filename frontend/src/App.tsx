import { useState, useRef } from 'react';
import { Header } from './components/Header';
import { KpiCard } from './components/KpiCard';
import { PipelineCard } from './components/PipelineCard';
import { PipelineFlow } from './components/PipelineFlow';
import { PositionChart } from './components/PositionChart';
import { DealTracker } from './components/DealTracker';
import { DrillDownPanel } from './components/DrillDownPanel';
import { AggregationPanel } from './components/AggregationPanel';
import { useDashboard } from './hooks/useDashboard';
import { useReconciliation } from './hooks/useReconciliation';
import { useAggregations } from './hooks/useAggregations';
import type { AggStage, DrillDownFilter, DrillDownRequest, TimeWindow } from './types';
import styles from './App.module.css';

function fmtMwh(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} TWh`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)} GWh`;
  return `${n.toFixed(1)} MWh`;
}

export default function App() {
  const [window, setWindow] = useState<TimeWindow>('10m');
  const [isLive, setIsLive] = useState(true);
  const { data, loading, error, refetch } = useDashboard(window, isLive);
  const { data: reconData, loading: reconLoading } = useReconciliation(window, isLive);

  // Drill-down state
  const [drillDown, setDrillDown] = useState<DrillDownRequest | null>(null);
  const [trackerDeal, setTrackerDeal] = useState<string | undefined>(undefined);
  const trackerRef = useRef<HTMLDivElement>(null);

  // Aggregation panel state — uses same window as the dashboard
  const [aggStage, setAggStage] = useState<AggStage | null>(null);
  const { data: aggData } = useAggregations(window, isLive);

  // Toggle: show bundle counts at NEON/Endur instead of raw deal counts
  const [showAggregated, setShowAggregated] = useState(false);

  // Seeding pause/resume
  const [seedingPaused, setSeedingPaused] = useState(false);
  async function toggleSeeding() {
    const next = !seedingPaused;
    try {
      await fetch(`/api/live/${next ? 'pause' : 'resume'}`, { method: 'POST' });
      setSeedingPaused(next);
    } catch { /* ignore */ }
  }

  function openDrill(filter: DrillDownFilter, systemId?: number, systemName?: string, label?: string) {
    setDrillDown({ filter, systemId, systemName, label: label ?? filter });
  }

  function handleViewDeal(correlationId: string) {
    setDrillDown(null);
    setTrackerDeal(correlationId);
    setTimeout(() => trackerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }

  const summary = data?.summary ?? null;
  const pipeline = data?.pipeline ?? [];
  const chart = data?.chart ?? [];
  const deliveryChart = data?.deliveryChart ?? [];

  // When showAggregated, swap NEON and Endur dealCounts with bundle counts
  const displayPipeline = showAggregated
    ? pipeline.map((sys, i) => {
        if (i === 2) return { ...sys, dealCount: aggData?.vatpToNeon.bundles ?? sys.dealCount };
        if (i === 3) return { ...sys, dealCount: aggData?.neonToEndur.bundles ?? sys.dealCount };
        return sys;
      })
    : pipeline;

  const completionDisplay = summary?.completionRate !== null && summary?.completionRate !== undefined
    ? `${summary.completionRate.toFixed(1)}%`
    : '—';

  const inFlightDisplay = loading ? '—' : `${(summary?.inFlight ?? 0).toLocaleString()}`;
  const stuckCount = summary?.stuck ?? 0;
  const criticalCount = summary?.criticalAtRisk ?? 0;

  // Map recon rows by system name for easy lookup in PipelineCard
  const reconByName = new Map((reconData?.systems ?? []).map((r) => [r.name, r]));
  const vatpTotal = reconData?.vatpTotal ?? 0;
  const endurTotal = reconData?.endurTotal ?? 0;
  const totalLoss = reconData?.totalLoss ?? 0;
  const totalLossPct = reconData?.totalLossPct ?? 0;

  return (
    <div className={styles.app}>
      <Header
        summary={summary}
        window={window}
        onWindowChange={setWindow}
        isLive={isLive}
        onToggleLive={() => setIsLive((v) => !v)}
        onRefresh={refetch}
        seedingPaused={seedingPaused}
        onToggleSeeding={toggleSeeding}
      />

      <main className={styles.main}>
        {error && (
          <div className={styles.errorBanner}>
            Could not reach API: {error}. Ensure the backend is running on port 3001.
          </div>
        )}

        {/* KPI row */}
        <div className={styles.kpiRow}>
          <KpiCard
            label="Deals in Window"
            value={loading ? '—' : (summary?.totalDeals ?? 0).toLocaleString()}
            sub={`distinct deals entering VAT-P (${window === 'today' ? 'today' : window})`}
            accent="blue"
            onClick={() => openDrill('all', undefined, undefined, 'All deals in window')}
          />
          <KpiCard
            label="Grid Position"
            value={loading ? '—' : fmtMwh(summary?.gridPositionMwh ?? 0)}
            sub={`energy committed to grid (${window === 'today' ? 'today' : window})`}
            accent="teal"
          />
          <KpiCard
            label="Completion Rate"
            value={loading ? '—' : completionDisplay}
            sub="deals reaching Endur today"
            accent={
              summary?.completionRate === null ? 'blue'
              : (summary?.completionRate ?? 0) >= 95 ? 'green'
              : (summary?.completionRate ?? 0) >= 80 ? 'orange'
              : 'red'
            }
            onClick={() => openDrill('not_completed', undefined, undefined, 'Deals not yet completed')}
          />
          <KpiCard
            label="In-Flight (today)"
            value={loading ? '—' : inFlightDisplay}
            sub={stuckCount > 0 ? `${stuckCount} stuck (>15 min) — today` : 'deals not yet at Endur today'}
            accent={stuckCount > 0 ? 'orange' : 'blue'}
            onClick={() => openDrill(stuckCount > 0 ? 'stuck' : 'in_flight', undefined, undefined, stuckCount > 0 ? 'Stuck deals (>15 min)' : 'In-flight deals')}
          />
          <KpiCard
            label="⚡ Critical Deliveries"
            value={loading ? '—' : criticalCount.toLocaleString()}
            sub="delivery ≤ 2 h, not yet in NEON"
            accent={criticalCount > 0 ? 'red' : 'green'}
            onClick={() => openDrill('critical_at_risk', undefined, undefined, '⚡ Deals with delivery ≤ 2 h not yet in NEON')}
          />
        </div>

        {/* Reconciliation — deal count breakdown across pipeline */}

        {/* Pipeline section */}
        <section className={styles.pipelineSection}>
          <div className={styles.pipelineSectionHeader}>
            <span className={styles.sectionLabel}>DEAL JOURNEY PIPELINE</span>
            <label className={styles.aggToggle}>
              <input
                type="checkbox"
                checked={showAggregated}
                onChange={(e) => setShowAggregated(e.target.checked)}
              />
              Show aggregated counts (NEON &amp; Endur)
            </label>
          </div>

          <div className={styles.pipelineGrid}>
            {(() => {
              // VAT-P and PACE are peers — render them stacked in one column, no arrow between them.
              // The remaining columns (NEON, Endur) follow in the normal linear chain.
              const paceSys  = pipeline.find((s) => s.name === 'PACE');
              const neonSys  = pipeline.find((s) => s.name === 'NEON');
              const endurSys = pipeline.find((s) => s.name === 'Endur');

              return pipeline
                .filter((sys) => sys.name !== 'PACE')   // PACE is rendered inside the VAT-P column
                .map((sys) => {
                  const isPeerCol  = sys.name === 'VAT-P';
                  const isLastCol  = sys.name === 'Endur';
                  // Gap for the arrow AFTER this column
                  const gapCount   = sys.gapToNext ?? 0;
                  // Next system in the downstream chain (skip PACE)
                  const nextSys    = isPeerCol ? neonSys : (sys.name === 'NEON' ? endurSys : undefined);
                  // Aggregation arrow stage
                  const aggArrowStage: AggStage | null =
                    isPeerCol        ? 'vat_p_neon' :
                    sys.name === 'NEON' ? 'neon_endur' :
                    null;
                  const bundleMode = showAggregated && (sys.name === 'NEON' || sys.name === 'Endur');

                  return (
                    <div key={sys.id} className={styles.pipelineColWrap}>
                      {isPeerCol ? (
                        // VAT-P + PACE stacked — no arrow, they receive the same deals simultaneously
                        <div className={styles.peerStack}>
                          <PipelineCard
                            system={sys}
                            reconRow={reconByName.get(sys.name)}
                            onDrillDown={openDrill}
                          />
                          {paceSys && (
                            <PipelineCard
                              system={paceSys}
                              reconRow={reconByName.get('PACE')}
                              compact
                              onDrillDown={openDrill}
                            />
                          )}
                        </div>
                      ) : (
                        <PipelineCard
                          system={sys}
                          reconRow={reconByName.get(sys.name)}
                          bundleMode={bundleMode}
                          onDrillDown={openDrill}
                        />
                      )}
                      {!isLastCol && (
                        <div className={styles.arrowWrap}>
                          {aggArrowStage ? (
                            <button
                              className={styles.aggArrowBtn}
                              onClick={() => setAggStage(aggArrowStage)}
                              title={`View ${aggArrowStage === 'vat_p_neon' ? 'VAT-P → NEON' : 'NEON → Endur'} aggregation bundles`}
                            >
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2">
                                <line x1="5" y1="12" x2="19" y2="12" />
                                <polyline points="12 5 19 12 12 19" />
                              </svg>
                            </button>
                          ) : (
                            <div className={styles.pipelineArrow}>
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="2">
                                <line x1="5" y1="12" x2="19" y2="12" />
                                <polyline points="12 5 19 12 12 19" />
                              </svg>
                            </div>
                          )}
                          {gapCount > 0 && nextSys && !showAggregated && (
                            <button
                              className={styles.gapBadge}
                              onClick={() => setDrillDown({
                                filter: 'gap',
                                systemId: sys.id,
                                systemName: sys.name,
                                toSystemId: nextSys.id,
                                toSystemName: nextSys.name,
                                label: `⚠ Gap: ${sys.name} → ${nextSys.name}`,
                              })}
                              title={`${gapCount} deals processed at ${sys.name} with no ${nextSys.name} row yet`}
                            >
                              ⚠ {gapCount}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                });
            })()}
          </div>

          <PipelineFlow systems={pipeline} />

          {/* Funnel summary — deals entering VAT-P vs reaching Endur */}
          {vatpTotal > 0 && (
            <div className={styles.funnelStrip}>
              <span
                className={`${styles.funnelNode} ${styles.funnelPace}`}
                onClick={() => openDrill('all', undefined, undefined, 'All deals in window')}
              >
                {vatpTotal.toLocaleString()} entered VAT-P
              </span>
              <span className={styles.funnelSep}>→</span>
              <span
                className={`${styles.funnelNode} ${styles.funnelEndur}`}
                onClick={() => openDrill('not_completed', undefined, undefined, 'Deals not yet in Endur')}
              >
                {endurTotal.toLocaleString()} reached Endur
              </span>
              {totalLoss > 0 ? (
                <span className={styles.funnelLoss}>
                  · ⚠ {totalLoss.toLocaleString()} deals not yet in Endur
                  <span className={styles.funnelLossPct}>({totalLossPct.toFixed(1)}% gap)</span>
                </span>
              ) : (
                <span className={styles.funnelOk}>· ✓ All deals reaching Endur</span>
              )}
            </div>
          )}
        </section>

        {/* Chart */}
        {deliveryChart.length > 0 && (
          <PositionChart
            data={deliveryChart}
            window={window}
            systemNames={pipeline.map((s) => s.name)}
          />
        )}
        {!loading && deliveryChart.length === 0 && !error && (
          <div className={styles.emptyChart}>
            No deal data in the selected time window. Try a wider window or run the seed script.
          </div>
        )}

        {/* Deal Tracker */}
        <div ref={trackerRef}>
          <DealTracker externalId={trackerDeal} />
        </div>
      </main>

      <DrillDownPanel
        request={drillDown}
        window={window}
        onClose={() => setDrillDown(null)}
        onViewDeal={handleViewDeal}
      />

      <AggregationPanel
        stage={aggStage}
        window={window}
        onClose={() => setAggStage(null)}
        onViewDeal={handleViewDeal}
      />
    </div>
  );
}
