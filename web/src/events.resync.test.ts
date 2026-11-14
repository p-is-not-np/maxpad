import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /ws/events does not replay. Recovery is idempotent resync on reconnect —
 * and that resync used to skip the first successful open after a failed
 * handshake, wait out a 5s backoff after a hidden outage, and trust an
 * OPEN socket that iOS had already killed without firing close.
 */

class FakeWS {
  static instances: FakeWS[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  close = vi.fn(() => {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  });
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  /** Opens, then says hello the way the server does: by default, no replay. */
  open(hello: { epoch?: string; seq?: number; replayed?: boolean } = {}) {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
    this.hello(hello);
  }
  hello({ epoch = 'e1', seq = 0, replayed = false } = {}) {
    this.send({ _hello: { epoch, seq, replayed } });
  }
  send(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let vis: 'visible' | 'hidden' = 'visible';
const visListeners: EventListener[] = [];

function setVisibility(next: 'visible' | 'hidden') {
  vis = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function loadEvents() {
  return import('./events');
}

beforeEach(() => {
  vi.resetModules();
  FakeWS.instances = [];
  vis = 'visible';
  visListeners.length = 0;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => vis,
  });
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, opts) => {
    if (type === 'visibilitychange') visListeners.push(listener as EventListener);
    add(type, listener, opts as AddEventListenerOptions);
  });
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  for (const h of visListeners) document.removeEventListener('visibilitychange', h);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event stream: first successful open after a failed handshake', () => {
  it('is a reconnect — boot fetches already landed in the gap', async () => {
    const { startEvents, subscribeReconnect } = await loadEvents();
    const handler = vi.fn();
    subscribeReconnect(handler);
    startEvents();
    expect(FakeWS.instances).toHaveLength(1);
    // First socket dies before onopen (mobile, proxy, server bounce).
    FakeWS.instances[0]?.onclose?.();
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1]?.open();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('still does not treat a clean first open as a reconnect', async () => {
    const { startEvents, subscribeReconnect } = await loadEvents();
    const handler = vi.fn();
    subscribeReconnect(handler);
    startEvents();
    FakeWS.instances[0]?.open();
    expect(handler).not.toHaveBeenCalled();
    FakeWS.instances[0]?.close();
    await vi.advanceTimersByTimeAsync(250);
    FakeWS.instances[1]?.open();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('event stream: return from hidden skips leftover backoff', () => {
  it('connects immediately when the socket is already gone', async () => {
    const { startEvents } = await loadEvents();
    startEvents();
    setVisibility('hidden');
    // Fail enough handshakes to arm the 5s cap.
    const fail = async (waitMs: number) => {
      FakeWS.instances[FakeWS.instances.length - 1]?.onclose?.();
      await vi.advanceTimersByTimeAsync(waitMs);
    };
    await fail(250);
    await fail(500);
    await fail(1000);
    await fail(2000);
    await fail(4000);
    FakeWS.instances[FakeWS.instances.length - 1]?.onclose?.();
    const socketsWhenArmed = FakeWS.instances.length;
    // Visible 1ms later: must not wait the remaining ~5s.
    await vi.advanceTimersByTimeAsync(1);
    setVisibility('visible');
    expect(FakeWS.instances.length).toBe(socketsWhenArmed + 1);
    await vi.advanceTimersByTimeAsync(4998);
    expect(FakeWS.instances.length).toBe(socketsWhenArmed + 1);
  });
});

describe('event stream: iOS background kill without close', () => {
  it('force-closes an OPEN socket after a real hide so reconnect handlers run', async () => {
    const { startEvents, subscribeReconnect } = await loadEvents();
    const handler = vi.fn();
    subscribeReconnect(handler);
    startEvents();
    FakeWS.instances[0]?.open();
    expect(handler).not.toHaveBeenCalled();

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(2000);
    setVisibility('visible');

    expect(FakeWS.instances[0]?.close).toHaveBeenCalled();
    expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2);
    FakeWS.instances[FakeWS.instances.length - 1]?.open();
    expect(handler).toHaveBeenCalled();
  });

  it('leaves a healthy OPEN socket alone across a short hide', async () => {
    const { startEvents } = await loadEvents();
    startEvents();
    FakeWS.instances[0]?.open();
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(1999);
    setVisibility('visible');
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]?.close).not.toHaveBeenCalled();
  });
});

describe('subscribeResync', () => {
  it('runs the handler when the document becomes visible, not only on socket reconnect', async () => {
    const { startEvents, subscribeResync } = await loadEvents();
    startEvents();
    FakeWS.instances[0]?.open();
    const handler = vi.fn();
    subscribeResync(handler);
    setVisibility('hidden');
    expect(handler).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('TabView mosaic recovery', () => {
  it('refetches tab detail on visibility, not only on events reconnect', () => {
    const src = readFileSync(join(process.cwd(), 'src/pages/TabView.tsx'), 'utf8');
    expect(src).toMatch(/subscribeResync\(\(\) => \{/);
    expect(src).not.toMatch(/return subscribeReconnect\(/);
  });
});

describe('event stream: resume instead of refetch', () => {
  const ev = (seq: number, epoch = 'e1') => ({
    type: 'working_set.changed',
    _epoch: epoch,
    _seq: seq,
  });

  async function connected() {
    const mod = await loadEvents();
    const reconnect = vi.fn();
    const events = vi.fn();
    mod.subscribeReconnect(reconnect);
    mod.subscribe(events);
    mod.startEvents();
    FakeWS.instances[0]?.open({ epoch: 'e1', seq: 4 });
    return { reconnect, events };
  }

  it('asks to resume from the last event it saw', async () => {
    await connected();
    FakeWS.instances[0]?.send(ev(5));
    FakeWS.instances[0]?.send(ev(6));
    FakeWS.instances[0]?.close();
    vi.advanceTimersByTime(300);
    expect(FakeWS.instances[1]?.url).toContain('?epoch=e1&seq=6');
  });

  it('does not refetch when the server replayed the gap', async () => {
    const { reconnect, events } = await connected();
    FakeWS.instances[0]?.close();
    vi.advanceTimersByTime(300);
    const next = FakeWS.instances[1];
    next?.send(ev(5));
    next?.open({ epoch: 'e1', seq: 5, replayed: true });
    expect(events).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('refetches when the server could not replay (it restarted)', async () => {
    const { reconnect } = await connected();
    FakeWS.instances[0]?.close();
    vi.advanceTimersByTime(300);
    FakeWS.instances[1]?.open({ epoch: 'e2', seq: 0, replayed: false });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('drops a repeated event and resyncs on a hole in the sequence', async () => {
    const { reconnect, events } = await connected();
    const sock = FakeWS.instances[0];
    sock?.send(ev(5));
    sock?.send(ev(5));
    expect(events).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
    sock?.send(ev(7));
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(2);
  });

  it('reconnects a socket that has gone silent while still OPEN', async () => {
    await connected();
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    FakeWS.instances[0]?.send({ _hb: 1 });
    vi.advanceTimersByTime(40_000);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(FakeWS.instances.length).toBeGreaterThan(1);
  });
});
