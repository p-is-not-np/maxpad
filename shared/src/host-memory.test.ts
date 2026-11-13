import { describe, expect, it } from 'vitest';
import { type HostMemory, memoryPressure, swapUsedRatio } from './host-memory.js';

const GB = 1024 ** 3;
const host = (availGb: number, swapUsedGb: number, swapTotalGb = 8): HostMemory => ({
  platform: 'linux',
  ramTotalBytes: 100 * GB,
  ramAvailableBytes: availGb * GB,
  swapTotalBytes: swapTotalGb * GB,
  swapUsedBytes: swapUsedGb * GB,
  top: [],
});

describe('memoryPressure — neutral until memory is actually tight', () => {
  it('is ok with room in RAM and little swap used', () => {
    expect(memoryPressure(host(40, 1))).toBe('ok');
  });

  it('warns below 15% of RAM available, not at it', () => {
    expect(memoryPressure(host(15, 0))).toBe('ok');
    expect(memoryPressure(host(14.9, 0))).toBe('warn');
  });

  it('warns above 75% of swap used, even with RAM to spare', () => {
    expect(memoryPressure(host(50, 6))).toBe('ok'); // exactly 75%
    expect(memoryPressure(host(50, 6.1))).toBe('warn');
  });

  it('goes critical below 5% RAM or above 90% swap — the state before both OOM kills', () => {
    expect(memoryPressure(host(4, 0))).toBe('critical');
    expect(memoryPressure(host(50, 7.7))).toBe('critical'); // 96%
  });

  it('reads no swap as empty swap, not full swap', () => {
    const m = host(50, 0, 0);
    expect(swapUsedRatio(m)).toBe(0);
    expect(memoryPressure(m)).toBe('ok');
  });
});
