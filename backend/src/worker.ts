import type { ShoppingService } from './shopping-service';
import { logger } from './logger';
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
        logger.info('discovery.job.claimed', { sessionId: job.sessionId, roundId: job.id, attempt: job.attempts, active });
        const task = service.runJob(job).catch(() => { logger.error('discovery.job.persistence_failed', { sessionId: job.sessionId, roundId: job.id }); }).finally(() => { active--; tasks.delete(task); });
        tasks.add(task);
      }
    } catch { logger.error('discovery.queue.unavailable'); }
    finally { pumping = false; }
  };
  const timer = setInterval(() => { void pump(); }, 1000);
  const cleanup = setInterval(() => { void service.store.cleanup().catch(() => logger.error('retention.cleanup.failed')); }, 60 * 60 * 1000);
  void pump(); void service.store.cleanup().catch(() => {});
  return async () => { stopped = true; clearInterval(timer); clearInterval(cleanup); await Promise.allSettled([...tasks]); };
}
