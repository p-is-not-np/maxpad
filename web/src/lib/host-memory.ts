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

/** What `GET /api/host/memory` answers: one machine's reading, or why not.
 *  `node`/`multiNode` are absent from a server that predates per-machine
 *  readings, which reads exactly as "this machine, one machine". */
export interface MachineMemory {
  memory: HostMemory | null;
  reason?: string;
  node?: { id: string; name: string };
  multiNode?: boolean;
}

/** The machine's name to show, or null when there is only one machine — a
 *  one-machine install must look exactly as it did. */
export function machineLabel(m: MachineMemory): string | null {
  if (!m.multiNode || !m.node) return null;
  // The local row is named "this machine", which opens a heading badly.
  const n = m.node.name;
  return m.node.id === 'local' ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

/** The gauge's tooltip. */
export function gaugeTitle(m: MachineMemory): string {
  const name = machineLabel(m);
  const head = name ? `${name} memory` : 'Memory';
  if (!m.memory) return `${head} — unknown${m.reason ? ` (${m.reason})` : ''}`;
  const r = readMemory(m.memory);
  return `${head} — ${r.ramLine} · ${r.swapLine}`;
}

/** One row of `GET /api/host/memory/nodes`. */
export interface NodeMemory {
  id: string;
  name: string;
  memory: HostMemory | null;
  reason?: string;
}

/** Settings → Machines: `13/31G RAM`, coloured like the gauge; or unknown. */
export function machineMemoryLine(n: NodeMemory): {
  text: string;
  pressure: MemoryPressure | 'unknown';
  title: string;
} {
  if (!n.memory)
    return {
      text: 'memory unknown',
      pressure: 'unknown',
      title: n.reason ?? 'that machine did not say',
    };
  const r = readMemory(n.memory);
  return { text: `${r.text} RAM`, pressure: r.pressure, title: `${r.ramLine} · ${r.swapLine}` };
}
