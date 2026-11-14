import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { HostLink } from './HostLink.js';

/**
 * A REMOTE MACHINE'S MEMORY, AND EVERY WAY IT CAN FAIL TO ARRIVE.
 *
 * The degrade path is the one that matters: an older muxpad-node does not
 * know the `host` channel, drops the ask as malformed and never answers. That
 * must resolve to "unknown" for that machine — not hang the gauge, not throw.
 */

const servers: Array<() => void> = [];
afterEach(() => {
  for (const stop of servers.splice(0)) stop();
});

/** A fake host that answers each `host/read` with `answer(frame)`, or not at all. */
async function linked(answer: (read: { id: string; top?: number }) => object | null) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/link' });
  let up!: (ws: WebSocket) => void;
  const socket = new Promise<WebSocket>((r) => {
    up = r;
  });
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as { ch: string; op: string; id: string; top?: number };
      if (m.ch !== 'host' || m.op !== 'read') return;
      const reply = answer(m);
      if (reply) ws.send(JSON.stringify(reply));
    });
    up(ws);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  const link = new HostLink({
    nodeId: 'trayo',
    endpoint: `ws://127.0.0.1:${port}`,
    token: 't'.repeat(64),
    selfUrl: 'http://127.0.0.1:1',
    apiKey: () => null,
    onTranscript: () => {},
    log: () => {},
  });
  servers.push(() => {
    link.close();
    wss.close();
    http.close();
  });
  const ws = await socket;
  // The server side's `open` can trail the host's `connection` by a tick.
  await new Promise((r) => setTimeout(r, 20));
  return { link, ws };
}

const READING = {
  platform: 'linux',
  ramTotalBytes: 16 * 1024 ** 3,
  ramAvailableBytes: 4 * 1024 ** 3,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  top: [{ pid: 7, name: 'node', cwd: 'app/server', rssBytes: 100, swapBytes: 0 }],
};

describe('HostLink.readMemory', () => {
  it('returns the host’s reading, passing top along', async () => {
    let top: number | undefined;
    const { link } = await linked((m) => {
      top = m.top;
      return { ch: 'host', op: 'memory', id: m.id, memory: READING };
    });
    expect(await link.readMemory(5)).toEqual({ memory: READING });
    expect(top).toBe(5);
  });

  it('DEGRADES an older node that never answers to an error after the timeout', async () => {
    const { link } = await linked(() => null);
    const r = await link.readMemory(0, 150);
    expect(r).toEqual({ error: 'did not answer — that machine may run an older muxpad' });
  });

  it('passes a host’s own "unavailable" through as the reason', async () => {
    const { link } = await linked((m) => ({
      ch: 'host',
      op: 'unavailable',
      id: m.id,
      reason: 'not supported on this machine',
    }));
    expect(await link.readMemory()).toEqual({ error: 'not supported on this machine' });
  });

  it('refuses a reading that does not parse rather than drawing nonsense', async () => {
    for (const memory of [
      null,
      'lots',
      { ...READING, ramTotalBytes: -1 },
      { ...READING, ramAvailableBytes: Number.NaN },
      { ...READING, swapUsedBytes: '3' },
    ]) {
      const { link } = await linked((m) => ({ ch: 'host', op: 'memory', id: m.id, memory }));
      expect(await link.readMemory(), JSON.stringify(memory)).toEqual({
        error: 'sent a reading that does not parse',
      });
    }
  });

  it('settles every read in flight when the link drops', async () => {
    const { link, ws } = await linked(() => null);
    const pending = link.readMemory(0, 10_000);
    ws.close();
    expect(await pending).toEqual({ error: 'the link dropped' });
  });

  it('says "not connected" without a socket, instead of waiting', async () => {
    const link = new HostLink({
      nodeId: 'gone',
      endpoint: 'ws://127.0.0.1:1',
      token: 't'.repeat(64),
      selfUrl: 'http://127.0.0.1:1',
      apiKey: () => null,
      onTranscript: () => {},
      log: () => {},
    });
    servers.push(() => link.close());
    expect(await link.readMemory()).toEqual({ error: 'not connected' });
  });
});
