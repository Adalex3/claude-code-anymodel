import { useState, useEffect } from 'react';

export interface Stats {
  ram: {
    usedGB:   number | null;
    totalGB:  number | null;
    freeGB:   number | null;
    claudeMB: number;
  };
  cpu: { load: number | null };
  gpu: { model: string; vramMB: number | null } | null;
  proxy: {
    status: string;
    model:  string | null;
    port:   number | null;
  };
}

export function useSystemStats(): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    const unsub = window.electronAPI.stats.onUpdate((raw) => setStats(raw as Stats));
    return unsub;
  }, []);
  return stats;
}
