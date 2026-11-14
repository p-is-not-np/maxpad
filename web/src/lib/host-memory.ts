import {
  type HostMemory,
  type MemoryPressure,
  memoryPressure,
  ramAvailableRatio,
  swapUsedRatio,
} from '@muxpad/shared';

/** `31.2 GB`, `812 MB` — binary units, one decimal under 100, as `free -h`
 *  would say it, so the number matches what the person checks it against. */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

const GB = 1024 ** 3;

export function gaugeText(m: HostMemory): string {
  const total = Math.round(m.ramTotalBytes / GB);
  const used = Math.round(Math.max(0, m.ramTotalBytes - m.ramAvailableBytes) / GB);
  return `${used}/${total}G`;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

export interface MemoryReading {
  pressure: MemoryPressure;
  /** The gauge itself: `11/31G` — RAM in use (total − available) of total,
   *  whole GB. Short enough for a 160px rail and a phone's top bar. */
  text: string;
  /** One line per fact, for the tooltip and the popover. */
  ramLine: string;
  swapLine: string;
}

export function readMemory(m: HostMemory): MemoryReading {
  const avail = ramAvailableRatio(m);
  const swap = swapUsedRatio(m);
  const hasSwap = m.swapTotalBytes > 0;
  return {
    pressure: memoryPressure(m),
    text: gaugeText(m),
    ramLine: `RAM ${formatBytes(m.ramAvailableBytes)} free of ${formatBytes(m.ramTotalBytes)} (${pct(avail)})`,
    swapLine: hasSwap
      ? `Swap ${formatBytes(m.swapUsedBytes)} used of ${formatBytes(m.swapTotalBytes)} (${pct(swap)})`
      : 'Swap none',
  };
}
