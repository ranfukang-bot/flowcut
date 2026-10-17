"use client";
import { useEffect, useState } from 'react';

export function useTaskPage<T extends { id: string }>(initial: T[], status: string, q: string, refreshKey: string) {
  const key = JSON.stringify({ status, q });
  const [pages, setPages] = useState(1);
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<{ key: string; tasks: T[]; nextCursor: string | null }>({ key, tasks: initial, nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = window.setInterval(() => setTick(value => value + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (!alive) return;
      setLoading(true); setError('');
      const filters = JSON.parse(key) as { status: string; q: string };
      const tasks: T[] = [];
      let nextCursor: string | null = null;
      for (let index = 0; index < pages; index++) {
        const params: URLSearchParams = new URLSearchParams({ ...filters, limit: '50', ...(nextCursor ? { cursor: nextCursor } : {}) });
        const response: Response = await fetch('/api/tasks?' + params, { cache: 'no-store', signal: controller.signal });
        const result: { tasks?: T[]; nextCursor?: string | null; error?: string } = await response.json();
        if (!response.ok || !Array.isArray(result.tasks)) throw new Error(result.error || '任务列表加载失败，下面保留上次已加载的任务');
        tasks.push(...(result.tasks as T[]));
        nextCursor = result.nextCursor || null;
        if (!nextCursor) break;
      }
      if (alive) setView({ key, tasks, nextCursor });
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : '任务列表加载失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [key, pages, tick, refreshKey]);
  const current = view.key === key ? view : { tasks: [] as T[], nextCursor: null };
  return { tasks: current.tasks, hasMore: Boolean(current.nextCursor), loading, error, resetPages: () => setPages(1), loadMore: () => { if (!loading) setPages(value => value + 1); } };
}
