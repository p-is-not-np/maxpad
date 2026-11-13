import { describe, expect, it } from 'vitest';
import { formatBytes, readMemory } from './host-memory';

const GB = 1024 ** 3;

describe('formatBytes', () => {
  it('speaks binary units the way free -h does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812 * 1024 ** 2)).toBe('812 MB');
    expect(formatBytes(31.2 * GB)).toBe('31.2 GB');
    expect(formatBytes(1.5 * 1024 ** 4)).toBe('1.5 TB');
  });
});

describe('readMemory', () => {
  it('turns the swap-96%-full morning into a red gauge with readable lines', () => {
    const r = readMemory({
      platform: 'linux',
      ramTotalBytes: 31 * GB,
      ramAvailableBytes: 3 * GB,
      swapTotalBytes: 8 * GB,
      swapUsedBytes: 7.68 * GB,
      top: [],
    });
    expect(r.pressure).toBe('critical');
    expect(r.ramLine).toBe('RAM 3.0 GB free of 31.0 GB (10%)');
    expect(r.swapLine).toBe('Swap 7.7 GB used of 8.0 GB (96%)');
    expect(r.swapUsed).toBeCloseTo(0.96, 2);
  });

  it('stays neutral on a full swap when most of RAM is free', () => {
    const r = readMemory({
      platform: 'linux',
      ramTotalBytes: 31 * GB,
      ramAvailableBytes: 20 * GB,
      swapTotalBytes: 8 * GB,
      swapUsedBytes: 7.68 * GB,
      top: [],
    });
    expect(r.pressure).toBe('ok');
  });

  it('says "none" rather than 0 of 0 on a host without swap', () => {
    const r = readMemory({
      platform: 'darwin',
      ramTotalBytes: 16 * GB,
      ramAvailableBytes: 8 * GB,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      top: [],
    });
    expect(r.pressure).toBe('ok');
    expect(r.hasSwap).toBe(false);
    expect(r.swapLine).toBe('Swap none');
  });
});
