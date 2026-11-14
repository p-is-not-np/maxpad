import { type MuxpadEvent, MuxpadEventSchema } from '@muxpad/shared';

/**
 * Singleton client for the server-pushed event stream at /ws/events.
 *
 * Auto-reconnects with exponential backoff (250ms → 5s). Every event carries
 * the server's `_epoch`/`_seq`, and a reconnect asks to resume from the last
 * one seen: the server replays what was missed and says so in its `_hello`.
 * Only when it can't (it restarted, or the gap outran its 2000-event buffer)
 * — or when a sequence hole shows an event was lost — do the reconnect
 * subscribers run, so each consumer refetches its own baseline. A socket
 * silent past two missed `_hb` heartbeats is treated as dead.
 *
 * Two subscription channels:
 *   - subscribe(handler)            — every validated MuxpadEvent
 *   - subscribeReconnect(handler)   — fires on every successful RE-connect
 *                                     (not on the first connect: nothing was
 *                                     missed yet, and boot already fetches)
 *   - subscribeResync(handler)      — reconnect PLUS document-visible, so a
 *                                     mosaic with no poll can recover even
 *                                     when iOS leaves the socket "OPEN"
 *
 * Bad event payloads are dropped with a warning, never thrown, so a
 * single broken event can't tear down the stream.
 */
type EventHandler = (e: MuxpadEvent) => void;
type ReconnectHandler = () => void;

let ws: WebSocket | null = null;
let started = false;
const eventHandlers = new Set<EventHandler>();
const reconnectHandlers = new Set<ReconnectHandler>();
let reconnectDelayMs = 250;
let reconnectTimer: number | undefined;
/**
 * The FIRST open is a connect, not a re-connect. Handlers exist to recover
 * events missed during a gap, and there is no gap before the first connect —
 * every consumer's mount-time fetch is already in flight or done. Firing them
 * anyway meant the socket handshake (a few ms after boot, same origin) kicked
 * off a duplicate `GET /api/workspaces?all=1` on every single cold load.
 *
 * A first socket that DIES before onopen is a different story: boot fetches
 * already landed while we were deaf, so the eventual successful open must
 * resync. `sawDisconnect` is that gap flag.
 */
let everConnected = false;
let sawDisconnect = false;
/**
 * Where this client is in the server's stream (see server/src/events.ts).
 * Sent back on reconnect so the server can replay what was missed instead of
 * every consumer refetching its baseline. Null until the first hello.
 */
let streamEpoch: string | null = null;
let streamSeq = 0;
/** Set by onopen: the next `_hello` decides whether this open was a gap. */
let awaitingHello = false;
let openWasReconnect = false;
/**
 * The server sends `_hb` every 20s. A socket silent for this long is dead
 * even if it still says OPEN — a phone that changed networks keeps one.
 */
const SILENCE_MS = 50_000;
let lastMessageAt = 0;
/** Wall-clock of the last hide, for the iOS zombie force-close. */
let hiddenAt = 0;
/** Same gate XtermPane uses: a quick flip is not a background kill. */
const HIDDEN_RESUME_MS = 2000;

function endpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const resume =
    streamEpoch !== null ? `?epoch=${encodeURIComponent(streamEpoch)}&seq=${streamSeq}` : '';
  return `${proto}//${window.location.host}/ws/events${resume}`;
}

function dropSocket(): void {
  if (!ws) return;
  const dying = ws;
  ws = null;
  dying.onclose = null;
  dying.onopen = null;
  dying.onmessage = null;
  dying.onerror = null;
  try {
    dying.close();
  } catch {
    // already closing
  }
}

function connect(): void {
  if (ws) return;
  ws = new WebSocket(endpoint());
  ws.onopen = () => {
    reconnectDelayMs = 250;
    openWasReconnect = everConnected || sawDisconnect;
    everConnected = true;
    awaitingHello = true;
    lastMessageAt = Date.now();
  };
  ws.onmessage = (m) => {
    lastMessageAt = Date.now();
    let raw: unknown;
    try {
      raw = JSON.parse(m.data);
    } catch (err) {
      console.warn('bad event payload', err);
      return;
    }
    const frame = raw as {
      _hb?: unknown;
      _hello?: { epoch: string; seq: number; replayed: boolean };
      _epoch?: unknown;
      _seq?: unknown;
    };
    if (frame._hb !== undefined) return;
    if (frame._hello) {
      const { epoch, seq, replayed } = frame._hello;
      streamEpoch = epoch;
      streamSeq = seq;
      const gap = awaitingHello && openWasReconnect && !replayed;
      awaitingHello = false;
      // replayed: everything missed has already arrived, in order, above
      // this frame — nothing to refetch. Otherwise (first contact with this
      // server process, or too far behind) consumers resync their baseline.
      if (gap) runReconnectHandlers();
      return;
    }
    if (typeof frame._seq === 'number' && typeof frame._epoch === 'string') {
      if (frame._epoch === streamEpoch) {
        // A replay can overlap what already arrived: drop the repeat.
        if (frame._seq <= streamSeq) return;
        // A hole in the sequence is a lost event. Rare, but it is exactly
        // the silent staleness the sequence exists to catch.
        const lost = frame._seq !== streamSeq + 1;
        streamSeq = frame._seq;
        if (lost) runReconnectHandlers();
      }
    } else if (awaitingHello) {
      // A server without sequencing (mid-deploy) never says hello: keep the
      // old contract and resync on the first event instead.
      awaitingHello = false;
      if (openWasReconnect) runReconnectHandlers();
    }
    let e: MuxpadEvent;
    try {
      e = MuxpadEventSchema.parse(raw);
    } catch (err) {
      console.warn('bad event payload', err);
      return;
    }
    // Isolate handlers: one throwing subscriber must not skip the rest
    // (handlers run in registration order; a throw used to drop every later
    // one, e.g. the active TabView's pane/layout sync).
    for (const h of eventHandlers) {
      try {
        h(e);
      } catch (err) {
        console.warn('event handler threw', err);
      }
    }
  };
  ws.onclose = () => {
    sawDisconnect = true;
    ws = null;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
  };
  ws.onerror = () => ws?.close();
}

function runReconnectHandlers(): void {
  for (const h of reconnectHandlers) {
    try {
      h();
    } catch (err) {
      console.warn('reconnect handler threw', err);
    }
  }
}

function checkSilence(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastMessageAt > SILENCE_MS) reconnectNow();
}

function reconnectNow(): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  reconnectDelayMs = 250;
  dropSocket();
  connect();
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // Known-closed: skip leftover backoff so pane detail does not sit 5s stale.
  if (ws === null) {
    reconnectNow();
    return;
  }
  // iOS routinely kills sockets of backgrounded pages without firing close.
  // Force-cycle after a real hide so subscribeReconnect actually runs.
  if (hiddenFor >= HIDDEN_RESUME_MS) reconnectNow();
}

/**
 * Open the singleton connection. Idempotent — safe to call from multiple
 * boot paths. The `started` flag (not `ws`) is the guard because `ws` is
 * briefly null in the reconnect window and we don't want a parallel boot
 * call to launch a second socket.
 */
export function startEvents(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.setInterval(checkSilence, 10_000);
  connect();
}

export function subscribe(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
}

export function subscribeReconnect(handler: ReconnectHandler): () => void {
  reconnectHandlers.add(handler);
  return () => {
    reconnectHandlers.delete(handler);
  };
}

/**
 * Reconnect handlers plus an immediate run when the document becomes
 * visible. TabView's mosaic has no poll; an OPEN zombie events socket never
 * fires reconnect, so visibility is the HTTP backstop.
 */
export function subscribeResync(handler: ReconnectHandler): () => void {
  const unsub = subscribeReconnect(handler);
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    try {
      handler();
    } catch (err) {
      console.warn('resync handler threw', err);
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    unsub();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
