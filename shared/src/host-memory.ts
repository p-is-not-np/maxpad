/**
 * HOST MEMORY — what `GET /api/host/memory` answers, and how loud it is.
 *
 * Why this exists: on a Linux box the kernel's OOM killer picked the muxpad
 * server (twice) after stale dev servers had quietly filled RAM and 96% of
 * swap. Nothing on screen said so. The rail now carries a small gauge that is
 * neutral until memory is actually tight, so the person notices before the
 * kernel does.
 *
 * The thresholds live HERE, not in the web component, so the numbers the
 * server reports and the colour the client paints cannot drift apart.
 */

export interface HostMemoryProcess {
  pid: number;
  /** argv[0]'s basename, else `/proc/<pid>/comm` — never the arguments,
   *  which can carry tokens. */
  name: string;
  /** Last two segments of its working directory, when readable — usually the
   *  project a stale dev server belongs to. */
  cwd: string | null;
  rssBytes: number;
  swapBytes: number;
}

export interface HostMemory {
  platform: string;
  ramTotalBytes: number;
  /** What a new allocation could get without swapping: Linux `MemAvailable`,
   *  not `MemFree` (which ignores reclaimable page cache and reads "full" on a
   *  perfectly healthy box). */
  ramAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /** Largest processes by RSS + swap. Linux only; empty elsewhere. */
  top: HostMemoryProcess[];
}

export type MemoryPressure = 'ok' | 'warn' | 'critical';

/**
 * AVAILABLE RAM IS THE SIGNAL; SWAP ONLY CORROBORATES IT.
 *
 * Swap used on its own says nothing about now: Linux leaves pages it swapped
 * out hours ago where they are, so this box sits at ~6 GB of swap with 20 GB
 * of RAM free. A gauge that went amber on that would be amber forever and
 * then ignored. So swap can only RAISE the level, and only while RAM is also
 * getting tight — full swap plus shrinking RAM is the state that preceded
 * both OOM kills.
 */
/** Below this share of RAM available, the gauge warns. */
export const RAM_AVAILABLE_WARN = 0.15;
/** Below this, it is red: the OOM killer is close. */
export const RAM_AVAILABLE_CRITICAL = 0.07;
/** Swap above this share used, with RAM available below `RAM_TIGHT_FOR_SWAP`,
 *  is at least a warning. */
export const SWAP_USED_WARN = 0.75;
export const RAM_TIGHT_FOR_SWAP = 0.25;
/** Swap above this share used, with RAM already in the warning band, is red. */
export const SWAP_USED_CRITICAL = 0.9;

export function ramAvailableRatio(m: HostMemory): number {
  return m.ramTotalBytes > 0 ? m.ramAvailableBytes / m.ramTotalBytes : 1;
}

/** No swap configured is 0, not NaN: "no swap" is not "swap is full". */
export function swapUsedRatio(m: HostMemory): number {
  return m.swapTotalBytes > 0 ? m.swapUsedBytes / m.swapTotalBytes : 0;
}

export function memoryPressure(m: HostMemory): MemoryPressure {
  const ram = ramAvailableRatio(m);
  const swap = swapUsedRatio(m);
  if (ram < RAM_AVAILABLE_CRITICAL) return 'critical';
  if (ram < RAM_AVAILABLE_WARN) return swap > SWAP_USED_CRITICAL ? 'critical' : 'warn';
  if (ram < RAM_TIGHT_FOR_SWAP && swap > SWAP_USED_WARN) return 'warn';
  return 'ok';
}
