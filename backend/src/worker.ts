import type { ShoppingService } from './shopping-service';
export function startWorker(service: ShoppingService) {
  let stopped = false, pumping = false, active = 0;
  const tasks = new Set<Promise<void>>();
  const pump = async () => {
    if (stopped || pumping || active >= 2) return;
    pumping = true;
    try {
      while (!stopped && active < 2) {
        const job = await service.store.claim();
        if (!job) break;
        active++;
        const task = service.runJob(job).catch(() => { console.error('Discovery job persistence failed; its lease will expire and recover.'); }).finally(() => { active--; tasks.delete(task); });
        tasks.add(task);
      }
    } catch { console.error('Discovery queue temporarily unavailable.'); }
    finally { pumping = false; }
  };
  const timer = setInterval(() => { void pump(); }, 1000);
  const cleanup = setInterval(() => { void service.store.cleanup().catch(() => console.error('Retention cleanup failed.')); }, 60 * 60 * 1000);
  void pump(); void service.store.cleanup().catch(() => {});
  return async () => { stopped = true; clearInterval(timer); clearInterval(cleanup); await Promise.allSettled([...tasks]); };
}
