import type { HostMemory, HostMemoryProcess } from '@muxpad/shared';
import { useEffect, useRef, useState } from 'react';
import { req } from '../api';
import { formatBytes, readMemory } from '../lib/host-memory';
import './MemoryGauge.css';

/** Slow on purpose: memory fills over minutes, and this runs in every window. */
const POLL_MS = 15_000;
const TOP_N = 5;

async function fetchMemory(top = 0): Promise<HostMemory> {
  const r = await req<{ memory: HostMemory }>(`/api/host/memory${top ? `?top=${top}` : ''}`);
  return r.memory;
}

/**
 * THE HOST'S MEMORY, ON THE CHROME.
 *
 * Two hairline bars — RAM in use above, swap in use below — that sit in the
 * dim chrome colour until memory is actually tight, then turn amber, then red.
 * The point is to be seen BEFORE the OOM killer picks the server, which on
 * this machine it has, twice. Hover for the numbers; tap (phones have no
 * hover) for the numbers and the processes holding the most.
 *
 * `placement` says which way the popover opens: up from the rail's foot, down
 * from the phone's top bar.
 */
export function MemoryGauge({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const [mem, setMem] = useState<HostMemory | null>(null);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState<HostMemoryProcess[] | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      fetchMemory()
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
  }, []);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTop(null);
    fetchMemory(TOP_N)
      .then((m) => {
        if (!alive) return;
        setMem(m);
        setTop(m.top);
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
  }, [open]);

  if (!mem) return null;
  const r = readMemory(mem);
  const label = `Memory — ${r.ramLine} · ${r.swapLine}`;

  return (
    <div className="memgauge" ref={wrap} data-pressure={r.pressure}>
      <button
        type="button"
        className="icon-btn memgauge-btn"
        title={label}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="memgauge-bars" aria-hidden="true">
          <span className="memgauge-bar">
            <span style={{ width: `${Math.round(r.ramUsed * 100)}%` }} />
          </span>
          <span className="memgauge-bar" data-empty={!r.hasSwap || undefined}>
            <span style={{ width: `${Math.round(r.swapUsed * 100)}%` }} />
          </span>
        </span>
      </button>
      {open && (
        <div className="memgauge-pop" data-placement={placement} aria-label="Memory">
          <div className="memgauge-head">
            Memory
            {r.pressure !== 'ok' && (
              <span className="memgauge-chip">
                {r.pressure === 'critical' ? 'critical' : 'tight'}
              </span>
            )}
          </div>
          <div className="memgauge-line">{r.ramLine}</div>
          <div className="memgauge-line">{r.swapLine}</div>
          {top === null ? (
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
