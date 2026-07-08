import { useState, useEffect, useCallback, useRef } from 'react';
import type { DashboardData, TimeWindow } from '../types';

const LIVE_INTERVAL_MS = 10_000; // refresh every 10s when live

export function useDashboard(window: TimeWindow, isLive: boolean) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard?window=${window}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DashboardData = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (isLive) {
      timerRef.current = setInterval(fetchData, LIVE_INTERVAL_MS);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isLive, fetchData]);

  return { data, loading, error, refetch: fetchData };
}
