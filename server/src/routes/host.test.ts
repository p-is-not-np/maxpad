import type { HostMemory } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { hostRoutes } from './host.js';

const sample: HostMemory = {
  platform: 'linux',
  ramTotalBytes: 100,
  ramAvailableBytes: 40,
  swapTotalBytes: 10,
  swapUsedBytes: 2,
  top: [],
};

describe('GET /api/host/memory', () => {
  it('answers the reading, and asks for no processes unless told to', async () => {
    const asked: Array<{ top?: number }> = [];
    const app = hostRoutes({
      read: async (o) => {
        asked.push(o);
        return sample;
      },
    });
    const res = await app.request('/memory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memory: sample });
    expect(asked).toEqual([{ top: 0 }]);
  });

  it('clamps ?top= to 0..20', async () => {
    const asked: Array<{ top?: number }> = [];
    const app = hostRoutes({
      read: async (o) => {
        asked.push(o);
        return sample;
      },
    });
    await app.request('/memory?top=999');
    await app.request('/memory?top=nope');
    await app.request('/memory?top=5');
    expect(asked.map((o) => o.top)).toEqual([20, 0, 5]);
  });

  it('says 503 in the error envelope when memory cannot be read', async () => {
    const app = hostRoutes({
      read: async () => {
        throw new Error('ENOENT /proc/meminfo');
      },
    });
    const res = await app.request('/memory');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
  });

  it('reads the real host when no reader is injected', async () => {
    const res = await hostRoutes().request('/memory');
    const { memory } = (await res.json()) as { memory: HostMemory };
    expect(memory.ramTotalBytes).toBeGreaterThan(0);
    expect(memory.ramAvailableBytes).toBeLessThanOrEqual(memory.ramTotalBytes);
  });
});
