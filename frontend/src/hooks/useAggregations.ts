import { useState, useEffect, useCallback } from 'react';
import type { AggregationSummary, TimeWindow } from '../types';

export function useAggregations(window: TimeWindow, isLive: boolean) {
  const [data, setData]       = useState<AggregationSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/aggregations/summary?window=${window}`);
      if (res.ok) setData(await res.json());
    } catch { /* ignore network errors */ } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [isLive, fetchData]);

  return { data, loading, refetch: fetchData };
}
