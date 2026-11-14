import type { MuxpadEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from './events.js';

describe('EventBus', () => {
  it('broadcasts to all subscribers', () => {
    const bus = new EventBus();
    const received: MuxpadEvent[][] = [[], []];
    const u1 = bus.subscribe((e) => received[0]!.push(e));
    const u2 = bus.subscribe((e) => received[1]!.push(e));
    bus.emit({ type: 'tab.removed', workspace_id: 'w', tab_id: 't' });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(1);
    u1();
    bus.emit({ type: 'tab.removed', workspace_id: 'w', tab_id: 't2' });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(2);
    u2();
  });

  it('subscriber errors do not stop other subscribers', () => {
    const bus = new EventBus();
    let okCalls = 0;
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => {
      okCalls++;
    });
    bus.emit({ type: 'workspace.removed', workspace_id: 'w' });
    expect(okCalls).toBe(1);
  });

  it('numbers events and replays the ones after a given seq', () => {
    const bus = new EventBus();
    const wire: number[] = [];
    bus.subscribeWire((w) => wire.push(w.seq));
    for (let i = 0; i < 5; i++) bus.emit({ type: 'working_set.changed' });
    expect(wire).toEqual([1, 2, 3, 4, 5]);
    expect(bus.since(bus.epoch, 3)?.map((w) => w.seq)).toEqual([4, 5]);
    expect(bus.since(bus.epoch, 5)).toEqual([]);
    const sent = JSON.parse(bus.since(bus.epoch, 4)?.[0]?.json ?? '{}');
    expect(sent).toMatchObject({ type: 'working_set.changed', _epoch: bus.epoch, _seq: 5 });
  });

  it('refuses to replay across epochs, from the future, or past the ring', () => {
    const bus = new EventBus();
    bus.emit({ type: 'working_set.changed' });
    expect(bus.since('another-epoch', 0)).toBeNull();
    expect(bus.since(bus.epoch, 9)).toBeNull();
    expect(bus.since(bus.epoch, -1)).toBeNull();
    for (let i = 0; i < 3000; i++) bus.emit({ type: 'working_set.changed' });
    expect(bus.since(bus.epoch, 1)).toBeNull();
    const recent = bus.since(bus.epoch, bus.lastSeq - 10);
    expect(recent).toHaveLength(10);
  });
});
