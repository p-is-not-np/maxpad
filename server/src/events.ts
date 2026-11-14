import type { MuxpadEvent } from '@muxpad/shared';

type Listener = (event: MuxpadEvent) => void;

/**
 * In-process pub/sub for structural state-change events
 * (panes/tabs/workspaces add/remove/update). The /ws/events upgrade
 * handler subscribes one listener per connected browser; mutation routes
 * call emit() after a successful write. Decoration changes (a pane's
 * title / foreground_cmd / attention flag) flow in from ptyd's control
 * channel: `PtydCache` consumes the push events and emits its own
 * `paneChange`, which the main entry forwards onto this bus as a
 * `pane.updated` event.
 *
 * Synchronous broadcast — there's no event queue. Listeners that throw are
 * logged and swallowed so one bad subscriber can't poison the others.
 */
/**
 * One event as it goes over a socket: the event's own fields plus where it
 * sits in this server's stream. `_epoch` is random per process, so a restart
 * can never be mistaken for continuity; `_seq` counts up from 1 within it.
 * Clients that predate these fields ignore them (zod strips unknown keys).
 */
export interface WireEvent {
  seq: number;
  /** The JSON sent to every socket — serialized once, not once per client. */
  json: string;
}

/** How far back a reconnecting client can catch up without a refetch. */
const REPLAY_CAPACITY = 2000;

export class EventBus {
  private listeners = new Set<Listener>();
  private wireListeners = new Set<(w: WireEvent, e: MuxpadEvent) => void>();
  readonly epoch = Math.random().toString(36).slice(2, 10);
  private seq = 0;
  /** Ring of the last REPLAY_CAPACITY wire events, oldest first. */
  private ring: WireEvent[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** For sockets: the serialized, sequenced form of every event. */
  subscribeWire(listener: (w: WireEvent, e: MuxpadEvent) => void): () => void {
    this.wireListeners.add(listener);
    return () => {
      this.wireListeners.delete(listener);
    };
  }

  /** The newest sequence number handed out (0 before the first event). */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * The events after `seq` in `epoch`, or null when they can't all be
   * produced: another epoch (the server restarted) or older than the ring.
   * An empty array means the client is already current.
   */
  since(epoch: string, seq: number): WireEvent[] | null {
    if (epoch !== this.epoch || !Number.isInteger(seq) || seq < 0 || seq > this.seq) return null;
    if (seq === this.seq) return [];
    const first = this.ring[0];
    if (!first || seq < first.seq - 1) return null;
    return this.ring.slice(seq - first.seq + 1);
  }

  emit(event: MuxpadEvent): void {
    this.seq += 1;
    const wire: WireEvent = {
      seq: this.seq,
      json: JSON.stringify({ ...event, _epoch: this.epoch, _seq: this.seq }),
    };
    this.ring.push(wire);
    // Trimmed in slabs, not per event: a splice shifts the whole array.
    if (this.ring.length > REPLAY_CAPACITY + 500) {
      this.ring.splice(0, this.ring.length - REPLAY_CAPACITY);
    }
    for (const l of this.wireListeners) {
      try {
        l(wire, event);
      } catch (err) {
        console.error('EventBus wire listener threw', err);
      }
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('EventBus listener threw', err);
      }
    }
  }
}
