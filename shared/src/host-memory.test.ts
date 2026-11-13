import { describe, expect, it } from 'vitest';
import { type HostMemory, memoryPressure, swapUsedRatio } from './host-memory.js';

const GB = 1024 ** 3;
/** 100 GB of RAM and 8 GB of swap, so RAM figures read as percentages. */
const host = (availGb: number, swapUsedGb: number, swapTotalGb = 8): HostMemory => ({
  platform: 'linux',
  ramTotalBytes: 100 * GB,
  ramAvailableBytes: availGb * GB,
  swapTotalBytes: swapTotalGb * GB,
  swapUsedBytes: swapUsedGb * GB,
  top: [],
});

describe('memoryPressure — available RAM is the signal', () => {
  it('is ok with room in RAM and little swap used', () => {
    expect(memoryPressure(host(40, 1))).toBe('ok');
  });

  it('warns below 15% of RAM available, not at it', () => {
    expect(memoryPressure(host(15, 0))).toBe('ok');
    expect(memoryPressure(host(14.9, 0))).toBe('warn');
  });

  it('goes critical below 7% of RAM available, whatever swap says', () => {
    expect(memoryPressure(host(7, 0))).toBe('warn');
    expect(memoryPressure(host(6.9, 0))).toBe('critical');
    expect(memoryPressure(host(6.9, 0, 0))).toBe('critical');
  });
});

describe('memoryPressure — swap only corroborates', () => {
  it('stays neutral on stale swap while RAM is plentiful — this box, most days', () => {
    // ~6 GB of long-idle pages in swap, 20 GB of 31 GB free.
    expect(memoryPressure(host(65, 7.7))).toBe('ok');
    expect(memoryPressure(host(25, 7.7))).toBe('ok'); // at the 25% line, not under it
  });

  it('warns on swap above 75% once RAM available is under 25%', () => {
    expect(memoryPressure(host(24, 6))).toBe('ok'); // exactly 75% swap
    expect(memoryPressure(host(24, 6.1))).toBe('warn');
  });

  it('turns a RAM warning red when swap is above 90% — the state before both OOM kills', () => {
    expect(memoryPressure(host(10, 7.2))).toBe('warn'); // 90%, not above
    expect(memoryPressure(host(10, 7.7))).toBe('critical'); // 96%
  });

  it('reads no swap as empty swap, not full swap', () => {
    const m = host(20, 0, 0);
    expect(swapUsedRatio(m)).toBe(0);
    expect(memoryPressure(m)).toBe('ok');
  });
});
