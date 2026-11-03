import type { ShoppingService } from './shopping-service';
import { logger } from './logger';
const MAX_CONCURRENT_JOBS = 4;
export function startWorker(service: ShoppingService, isReady: () => boolean = () => true) {
  let stopped = false, pumping = false, active = 0;
  const tasks = new Set<Promise<void>>();
  const pump = async () => {
    if (stopped || pumping || active >= MAX_CONCURRENT_JOBS || !isReady()) return;
    pumping = true;
    try {
      while (!stopped && active < MAX_CONCURRENT_JOBS) {
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
  void pump();
  return async () => { stopped = true; clearInterval(timer); await Promise.allSettled([...tasks]); };
}
