import { useState, useEffect, useCallback } from 'react';
import type { ReconciliationData, TimeWindow } from '../types';

export function useReconciliation(window: TimeWindow, isLive: boolean) {
  const [data, setData] = useState<ReconciliationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/reconciliation?window=${window}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ReconciliationData = await res.json();
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
    if (!isLive) return;
    const timer = setInterval(fetchData, 10_000);
    return () => clearInterval(timer);
  }, [isLive, fetchData]);

  return { data, loading, error };
}
