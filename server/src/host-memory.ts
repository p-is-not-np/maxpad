import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import os from 'node:os';
import { basename } from 'node:path';
import type { HostMemory, HostMemoryProcess } from '@muxpad/shared';

/**
 * Read this host's memory: RAM total/available and swap total/used, plus the
 * few processes holding the most of it.
 *
 * Linux reads `/proc` and nothing else. macOS asks two stock system binaries
 * (`vm_stat`, `sysctl vm.swapusage`) — neither touches another app's bundle,
 * a protected folder, the keychain or the display, so neither can raise a TCC
 * prompt (see the rules in agent-instructions.ts). If either fails we fall
 * back to `os.freemem()`, which on macOS counts only truly free pages and so
 * under-reports; the gauge would rather be pessimistic than blank.
 */

const KB = 1024;

/** `/proc/meminfo` lines are `Key:   12345 kB`. Unknown or missing keys are
 *  left out rather than guessed. */
export function parseMeminfo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+(kB))?/.exec(line);
    if (!m) continue;
    out.set(m[1] as string, Number(m[2]) * (m[3] ? KB : 1));
  }
  return out;
}

export function memoryFromMeminfo(text: string): Omit<HostMemory, 'platform' | 'top'> {
  const f = parseMeminfo(text);
  const total = f.get('MemTotal') ?? os.totalmem();
  // MemAvailable has been there since 3.14; the fallback is the kernel's own
  // pre-3.14 estimate, which is close enough for a warning light.
  const available =
    f.get('MemAvailable') ??
    (f.get('MemFree') ?? 0) + (f.get('Buffers') ?? 0) + (f.get('Cached') ?? 0);
  const swapTotal = f.get('SwapTotal') ?? 0;
  const swapFree = f.get('SwapFree') ?? swapTotal;
  return {
    ramTotalBytes: total,
    ramAvailableBytes: Math.min(available, total),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/** The two fields of `/proc/<pid>/status` we want, in bytes. */
export function parseProcStatus(text: string): { rss: number; swap: number } {
  const f = parseMeminfo(text);
  return { rss: f.get('VmRSS') ?? 0, swap: f.get('VmSwap') ?? 0 };
}

/** `vm_stat` on macOS: a page-size header, then `Pages free:   1234.` lines.
 *  Available ≈ free + inactive + speculative + purgeable — the pages the
 *  kernel hands out without compressing or swapping anything. */
export function availableFromVmStat(text: string): number | null {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  const page = Number(size[1]);
  const pages = (label: string) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page;
}

/** `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1536.25M  free = …`. */
export function parseSwapUsage(text: string): { total: number; used: number } | null {
  const unit = (n: string, u: string) =>
    Number(n) * ({ K: KB, M: KB ** 2, G: KB ** 3 }[u.toUpperCase()] ?? 1);
  const t = /total\s*=\s*([\d.]+)([KMG])/i.exec(text);
  const u = /used\s*=\s*([\d.]+)([KMG])/i.exec(text);
  if (!t || !u) return null;
  return {
    total: unit(t[1] as string, t[2] as string),
    used: unit(u[1] as string, u[2] as string),
  };
}

/**
 * What to call a process: the basename of argv[0], else the kernel's `comm`.
 * `comm` alone is often useless — node renames its main thread `MainThread`.
 * Only argv[0] is ever read: the arguments after it can carry tokens.
 */
export function processName(comm: string, cmdline: string): string {
  const argv0 = cmdline.split('\0')[0]?.trim();
  return (argv0 && basename(argv0.split(' ')[0] as string)) || comm.trim();
}

/** The last two segments of a path — `maxpad/server`, not `server`, because
 *  two checkouts of the same project otherwise read as one. */
export function shortPath(p: string): string {
  return p.split('/').filter(Boolean).slice(-2).join('/') || p;
}

/** Rank and trim. Pure, so the ordering is testable without a /proc. */
export function topByFootprint(procs: HostMemoryProcess[], n: number): HostMemoryProcess[] {
  return [...procs]
    .sort((a, b) => b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes))
    .slice(0, n);
}

async function linuxTop(n: number): Promise<HostMemoryProcess[]> {
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((d) => /^\d+$/.test(d));
  const procs = await Promise.all(
    pids.map(async (pid): Promise<HostMemoryProcess | null> => {
      try {
        const [status, comm, cmdline] = await Promise.all([
          readFile(`/proc/${pid}/status`, 'utf8'),
          readFile(`/proc/${pid}/comm`, 'utf8'),
          readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
        ]);
        const { rss, swap } = parseProcStatus(status);
        if (rss + swap === 0) return null; // kernel threads
        // Another user's cwd is unreadable; that is fine, it is just context.
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        return {
          pid: Number(pid),
          name: processName(comm, cmdline),
          cwd: cwd ? shortPath(cwd) : null,
          rssBytes: rss,
          swapBytes: swap,
        };
      } catch {
        return null; // exited between readdir and read
      }
    }),
  );
  return topByFootprint(
    procs.filter((p): p is HostMemoryProcess => p !== null),
    n,
  );
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}

export async function readHostMemory(opts: { top?: number } = {}): Promise<HostMemory> {
  const top = Math.max(0, Math.min(opts.top ?? 0, 20));
  if (process.platform === 'linux') {
    const text = await readFile('/proc/meminfo', 'utf8');
    return {
      platform: 'linux',
      ...memoryFromMeminfo(text),
      top: top > 0 ? await linuxTop(top) : [],
    };
  }
  const total = os.totalmem();
  let available = os.freemem();
  let swap = { total: 0, used: 0 };
  if (process.platform === 'darwin') {
    const [vm, sw] = await Promise.all([
      run('/usr/bin/vm_stat', []).catch(() => ''),
      run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']).catch(() => ''),
    ]);
    available = availableFromVmStat(vm) ?? available;
    swap = parseSwapUsage(sw) ?? swap;
  }
  return {
    platform: process.platform,
    ramTotalBytes: total,
    ramAvailableBytes: Math.min(available, total),
    swapTotalBytes: swap.total,
    swapUsedBytes: swap.used,
    top: [],
  };
}

/**
 * A reading from ANOTHER machine, checked field by field — or null.
 *
 * It arrives over the host link from a peer that may be old, buggy or
 * compromised, and it ends up in the gauge's arithmetic and in the popover's
 * text. So every number must be finite and non-negative, available is clamped
 * to total, the process list is capped, and strings are cut short. Anything
 * that is not a reading is `null`, which the gauge shows as "unknown".
 */
export function parseHostMemory(v: unknown): HostMemory | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  const text = (x: unknown, max: number): string | null =>
    typeof x === 'string' ? x.slice(0, max) : null;
  const total = num(o.ramTotalBytes);
  const avail = num(o.ramAvailableBytes);
  const swapTotal = num(o.swapTotalBytes);
  const swapUsed = num(o.swapUsedBytes);
  if (total === null || total === 0 || avail === null || swapTotal === null || swapUsed === null)
    return null;
  const top: HostMemory['top'] = [];
  if (Array.isArray(o.top))
    for (const p of o.top.slice(0, 20)) {
      if (!p || typeof p !== 'object') continue;
      const q = p as Record<string, unknown>;
      const pid = num(q.pid);
      const name = text(q.name, 64);
      const rss = num(q.rssBytes);
      const swap = num(q.swapBytes);
      if (pid === null || name === null || rss === null || swap === null) continue;
      top.push({ pid, name, cwd: text(q.cwd, 128), rssBytes: rss, swapBytes: swap });
    }
  return {
    platform: text(o.platform, 32) ?? 'unknown',
    ramTotalBytes: total,
    ramAvailableBytes: Math.min(avail, total),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.min(swapUsed, swapTotal),
    top,
  };
}
