import type { HostMemoryProcess } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { req } from '../api';
import {
  type MachineMemory,
  formatBytes,
  gaugeTitle,
  machineLabel,
  readMemory,
} from '../lib/host-memory';
import './MemoryGauge.css';

/** Slow on purpose: memory fills over minutes, and this runs in every window. */
const POLL_MS = 15_000;
const TOP_N = 5;

function fetchMemory(tabId: string | null, top = 0): Promise<MachineMemory> {
  const q = new URLSearchParams();
  if (tabId) q.set('tab', tabId);
  if (top) q.set('top', String(top));
  const s = q.toString();
  return req<MachineMemory>(`/api/host/memory${s ? `?${s}` : ''}`);
}

/**
 * THE MEMORY OF THE MACHINE YOU ARE WORKING ON, ON THE CHROME.
 *
 * One short reading — `11/31G`, RAM in use of RAM installed — in the
 * dim chrome colour until available RAM is actually tight, then turn amber,
 * then red. Swap alone never colours it (see shared/src/host-memory.ts).
 * The point is to be seen BEFORE the OOM killer picks the server, which on
 * this machine it has, twice. Hover for the numbers; tap (phones have no
 * hover) for the numbers and the processes holding the most.
 *
 * ── WHICH MACHINE ────────────────────────────────────────────────────────
 * The one running the chat you are in (`tabId`), resolved by the server; this
 * machine when there is no chat. On a one-machine install that is always this
 * machine and nothing about the gauge changes. With several, the popover
 * names the machine, and a machine that cannot say — unreachable, or an older
 * muxpad-node — reads `?` rather than borrowing another machine's number.
 *
 * `placement` says which way the popover opens: up from the rail's foot, down
 * from the phone's top bar.
 */
export function MemoryGauge({
  placement = 'up',
  tabId = null,
}: { placement?: 'up' | 'down'; tabId?: string | null }) {
  const [mem, setMem] = useState<MachineMemory | null>(null);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState<HostMemoryProcess[] | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      fetchMemory(tabId)
        .then((m) => alive && setMem(m))
        // A gauge that cannot read stays as it was; it is never an error.
        .catch(() => {});
    };
    load();
    const t = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', load);
    };
  }, [tabId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTop(null);
    fetchMemory(tabId, TOP_N)
      .then((m) => {
        if (!alive) return;
        setMem(m);
        setTop(m.memory?.top ?? []);
      })
      .catch(() => alive && setTop([]));
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', away);
    document.addEventListener('keydown', esc);
    return () => {
      alive = false;
      document.removeEventListener('click', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, tabId]);

  if (!mem) return null;
  const r = mem.memory ? readMemory(mem.memory) : null;
  const label = gaugeTitle(mem);
  const name = machineLabel(mem);

  return (
    <div className="memgauge" ref={wrap} data-pressure={r?.pressure ?? 'ok'}>
      <button
        type="button"
        className="icon-btn memgauge-btn"
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="memgauge-text" aria-hidden="true">
          {r ? r.text : '?G'}
        </span>
      </button>
      {open && (
        <div className="memgauge-pop" data-placement={placement} aria-label="Memory">
          <div className="memgauge-head">
            {name ? `${name} · Memory` : 'Memory'}
            {r && r.pressure !== 'ok' && (
              <span className="memgauge-chip">
                {r.pressure === 'critical' ? 'critical' : 'tight'}
              </span>
            )}
          </div>
          {r ? (
            <>
              <div className="memgauge-line">{r.ramLine}</div>
              <div className="memgauge-line">{r.swapLine}</div>
            </>
          ) : (
            <div className="memgauge-line">
              Unknown
              {mem.reason && <div className="memgauge-dim">{mem.reason}</div>}
            </div>
          )}
          {!r ? null : top === null ? (
            <div className="memgauge-dim">Reading processes…</div>
          ) : top.length > 0 ? (
            <ol className="memgauge-top">
              {top.map((p) => (
                <li key={p.pid} title={`pid ${p.pid}`}>
                  <span className="memgauge-proc">
                    {p.name}
                    {p.cwd && <span className="memgauge-cwd">{p.cwd}</span>}
                  </span>
                  <span className="memgauge-num">
                    {formatBytes(p.rssBytes)}
                    {p.swapBytes > 0 && (
                      <span className="memgauge-dim"> +{formatBytes(p.swapBytes)} swap</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}
    </div>
  );
}
