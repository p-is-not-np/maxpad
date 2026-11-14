import { describe, expect, it } from 'vitest';
import {
  availableFromVmStat,
  memoryFromMeminfo,
  parseHostMemory,
  parseProcStatus,
  parseSwapUsage,
  processName,
  shortPath,
  topByFootprint,
} from './host-memory.js';

const KB = 1024;

/** Trimmed from this box on the day swap hit 96%. */
const MEMINFO = `MemTotal:       32617468 kB
MemFree:          412204 kB
MemAvailable:    3201544 kB
Buffers:          102400 kB
Cached:          2900000 kB
SwapCached:       220000 kB
Active(anon):   20000000 kB
HugePages_Total:       0
SwapTotal:       8388604 kB
SwapFree:         335544 kB
`;

describe('memoryFromMeminfo', () => {
  it('uses MemAvailable, not MemFree', () => {
    const m = memoryFromMeminfo(MEMINFO);
    expect(m.ramTotalBytes).toBe(32617468 * KB);
    expect(m.ramAvailableBytes).toBe(3201544 * KB);
  });

  it('reports swap used as total minus free', () => {
    const m = memoryFromMeminfo(MEMINFO);
    expect(m.swapTotalBytes).toBe(8388604 * KB);
    expect(m.swapUsedBytes).toBe((8388604 - 335544) * KB);
  });

  it("falls back to the kernel's old estimate on a kernel without MemAvailable", () => {
    const old = MEMINFO.replace(/^MemAvailable:.*\n/m, '');
    expect(memoryFromMeminfo(old).ramAvailableBytes).toBe((412204 + 102400 + 2900000) * KB);
  });

  it('treats a host with no swap as zero swap', () => {
    const m = memoryFromMeminfo(
      'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
    );
    expect(m.swapTotalBytes).toBe(0);
    expect(m.swapUsedBytes).toBe(0);
  });
});

describe('parseProcStatus', () => {
  it('reads VmRSS and VmSwap, and zero for a kernel thread that has neither', () => {
    expect(parseProcStatus('Name:\tnode\nVmRSS:\t  204800 kB\nVmSwap:\t   1024 kB\n')).toEqual({
      rss: 204800 * KB,
      swap: 1024 * KB,
    });
    expect(parseProcStatus('Name:\tkworker/0:1\nState:\tI (idle)\n')).toEqual({ rss: 0, swap: 0 });
  });
});

describe('topByFootprint', () => {
  it('ranks by RSS + swap, so a swapped-out dev server still surfaces', () => {
    const p = (pid: number, rss: number, swap: number) => ({
      pid,
      name: `p${pid}`,
      cwd: null,
      rssBytes: rss,
      swapBytes: swap,
    });
    const ranked = topByFootprint([p(1, 100, 0), p(2, 10, 500), p(3, 300, 0), p(4, 1, 0)], 2);
    expect(ranked.map((x) => x.pid)).toEqual([2, 3]);
  });
});

describe('macOS readers', () => {
  it('counts free + inactive + speculative + purgeable pages as available', () => {
    const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            500000.
Pages inactive:                           20000.
Pages speculative:                         3000.
Pages throttled:                              0.
Pages wired down:                        100000.
Pages purgeable:                           1000.
`;
    expect(availableFromVmStat(vm)).toBe((10000 + 20000 + 3000 + 1000) * 16384);
    expect(availableFromVmStat('garbage')).toBeNull();
  });

  it('parses sysctl vm.swapusage', () => {
    expect(
      parseSwapUsage('total = 2048.00M  used = 1536.25M  free = 511.75M  (encrypted)'),
    ).toEqual({
      total: 2048 * KB ** 2,
      used: 1536.25 * KB ** 2,
    });
    expect(parseSwapUsage('')).toBeNull();
  });
});

describe('processName', () => {
  it('prefers argv[0] and never reads past it', () => {
    expect(processName('MainThread\n', '/usr/bin/node\0vite\0--token=s3cret\0')).toBe('node');
    expect(processName('kthreadd\n', '')).toBe('kthreadd');
  });
});

describe('shortPath', () => {
  it('keeps two segments so two checkouts of one project stay apart', () => {
    expect(shortPath('/home/a/maxpad-wt/vitest5/server')).toBe('vitest5/server');
    expect(shortPath('/')).toBe('/');
  });
});

describe('parseHostMemory — a reading from another machine', () => {
  const ok = {
    platform: 'darwin',
    ramTotalBytes: 1000,
    ramAvailableBytes: 400,
    swapTotalBytes: 100,
    swapUsedBytes: 10,
    top: [{ pid: 1, name: 'node', cwd: null, rssBytes: 5, swapBytes: 0 }],
  };

  it('accepts a well-formed one', () => {
    expect(parseHostMemory(ok)).toEqual(ok);
  });

  it('clamps available to total and swap used to swap total', () => {
    const m = parseHostMemory({ ...ok, ramAvailableBytes: 5000, swapUsedBytes: 500 });
    expect(m?.ramAvailableBytes).toBe(1000);
    expect(m?.swapUsedBytes).toBe(100);
  });

  it('drops malformed processes, caps the list and cuts long strings', () => {
    const m = parseHostMemory({
      ...ok,
      top: [
        { pid: 'x', name: 'bad', rssBytes: 1, swapBytes: 0 },
        ...Array.from({ length: 30 }, (_, i) => ({
          pid: i,
          name: 'n'.repeat(500),
          cwd: 7,
          rssBytes: 1,
          swapBytes: 0,
        })),
      ],
    });
    expect(m?.top).toHaveLength(19); // 20 looked at, the malformed one dropped
    expect(m?.top[0]?.name).toHaveLength(64);
    expect(m?.top[0]?.cwd).toBe(null);
  });

  it('is null for anything that is not a reading', () => {
    for (const v of [null, 3, 'x', {}, { ...ok, ramTotalBytes: 0 }, { ...ok, swapTotalBytes: -1 }])
      expect(parseHostMemory(v), JSON.stringify(v)).toBe(null);
  });
});
