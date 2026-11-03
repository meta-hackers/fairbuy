import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from '../src/worker';
import type { ShoppingService } from '../src/shopping-service';
import type { Job } from '../src/store';

afterEach(() => { vi.useRealTimers(); });

describe('discovery worker concurrency', () => {
  it('runs up to four searches, leaves others queued and refills freed slots', async () => {
    vi.useFakeTimers();
    const jobs: Job[] = Array.from({ length: 6 }, (_, i) => ({ id: `job-${i}`, sessionId: `session-${i}`, attempts: 1 }));
    const claim = vi.fn(async () => jobs.shift() ?? null);
    const releases: (() => void)[] = [];
    let active = 0, peak = 0;
    const runJob = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => { releases.push(resolve); });
      active--;
    });
    const service = { store: { claim }, runJob } as unknown as ShoppingService;
    const stop = startWorker(service);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(runJob).toHaveBeenCalledTimes(4);
      expect(active).toBe(4); expect(jobs).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(claim).toHaveBeenCalledTimes(4);
      releases[0]();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runJob).toHaveBeenCalledTimes(5);
      expect(active).toBe(4); expect(jobs).toHaveLength(1);
      releases[1]();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runJob).toHaveBeenCalledTimes(6);
      expect(active).toBe(4); expect(peak).toBe(4);
    } finally {
      const stopped = stop();
      for (const release of releases) release();
      await stopped;
    }
    const calls = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(claim).toHaveBeenCalledTimes(calls);
  });

  it('waits for readiness and never starts overlapping queue pumps', async () => {
    vi.useFakeTimers();
    let ready = false;
    let finishClaim!: (job: Job | null) => void;
    const claim = vi.fn(() => new Promise<Job | null>(resolve => { finishClaim = resolve; }));
    const service = { store: { claim }, runJob: vi.fn() } as unknown as ShoppingService;
    const stop = startWorker(service, () => ready);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(claim).not.toHaveBeenCalled();
      ready = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(claim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(claim).toHaveBeenCalledTimes(1);
      finishClaim(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.runJob).not.toHaveBeenCalled();
    } finally { await stop(); }
  });
});
