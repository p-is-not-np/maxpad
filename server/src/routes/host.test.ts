import type { HostMemory } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeStore } from '../store/NodeStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type MemoryAnswer, hostRoutes } from './host.js';

const sample: HostMemory = {
  platform: 'linux',
  ramTotalBytes: 100,
  ramAvailableBytes: 40,
  swapTotalBytes: 10,
  swapUsedBytes: 2,
  top: [],
};
const remoteSample: HostMemory = { ...sample, platform: 'darwin', ramAvailableBytes: 5 };

describe('GET /api/host/memory — this machine', () => {
  it('answers the reading, and asks for no processes unless told to', async () => {
    const asked: Array<{ top?: number }> = [];
    const app = hostRoutes({
      read: async (o) => {
        asked.push(o);
        return sample;
      },
    });
    const res = await app.request('/memory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      memory: sample,
      node: { id: 'local', name: 'this machine' },
      multiNode: false,
    });
    expect(asked).toEqual([{ top: 0 }]);
  });

  it('clamps ?top= to 0..20', async () => {
    const asked: Array<{ top?: number }> = [];
    const app = hostRoutes({
      read: async (o) => {
        asked.push(o);
        return sample;
      },
    });
    await app.request('/memory?top=999');
    await app.request('/memory?top=nope');
    await app.request('/memory?top=5');
    expect(asked.map((o) => o.top)).toEqual([20, 0, 5]);
  });

  it('says 503 in the error envelope when this machine cannot read itself', async () => {
    const app = hostRoutes({
      read: async () => {
        throw new Error('ENOENT /proc/meminfo');
      },
    });
    const res = await app.request('/memory');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unavailable');
  });

  it('reads the real host when no reader is injected', async () => {
    const res = await hostRoutes().request('/memory');
    const { memory } = (await res.json()) as { memory: HostMemory };
    expect(memory.ramTotalBytes).toBeGreaterThan(0);
    expect(memory.ramAvailableBytes).toBeLessThanOrEqual(memory.ramTotalBytes);
  });
});

describe('per machine', () => {
  let db: Database.Database;
  let localTab: string;
  let remoteTab: string;
  let asked: Array<{ nodeId: string; top: number }>;
  let remote: (nodeId: string, top: number) => Promise<MemoryAnswer>;

  beforeEach(() => {
    db = openDb(':memory:');
    const ws = new WorkspaceStore(db).create({ name: 'W' }).id;
    const tabs = new TabStore(db);
    const panes = new PaneStore(db);
    new NodeStore(db).add({ id: 'trayo', name: 'Trayo VM', endpoint: 'ws://trayo:7797' });
    new NodeStore(db).add({ id: 'oldbox', name: 'Old box', endpoint: 'ws://old:7797' });
    localTab = tabs.create({ name: 'L', layout: '', workspace_id: ws }).id;
    panes.create({ tab_id: localTab, shell: '/bin/zsh', cwd: '/tmp' });
    remoteTab = tabs.create({ name: 'R', layout: '', workspace_id: ws }).id;
    panes.create({ tab_id: remoteTab, shell: '/bin/zsh', cwd: '/tmp', node_id: 'trayo' });
    asked = [];
    remote = async (nodeId, top) => {
      asked.push({ nodeId, top });
      // `oldbox` runs a muxpad-node from before the `host` channel: the link
      // reader times out and says so.
      return nodeId === 'trayo'
        ? { memory: remoteSample }
        : { error: 'did not answer — that machine may run an older muxpad' };
    };
  });

  const app = () => hostRoutes({ db, read: async () => sample, remote });

  it('resolves a tab to the machine that owns its pane', async () => {
    const r = (await (await app().request(`/memory?tab=${remoteTab}&top=5`)).json()) as {
      memory: HostMemory;
      node: { id: string; name: string };
      multiNode: boolean;
    };
    expect(r.node).toEqual({ id: 'trayo', name: 'Trayo VM' });
    expect(r.memory).toEqual(remoteSample);
    expect(r.multiNode).toBe(true);
    expect(asked).toEqual([{ nodeId: 'trayo', top: 5 }]);
  });

  it('a local tab, an unknown tab and no tab are all this machine', async () => {
    for (const q of [`?tab=${localTab}`, '?tab=nope', '']) {
      const r = (await (await app().request(`/memory${q}`)).json()) as {
        node: { id: string };
        memory: HostMemory;
      };
      expect(r.node.id, q).toBe('local');
      expect(r.memory, q).toEqual(sample);
    }
    expect(asked).toEqual([]);
  });

  it('DEGRADES an old or silent node to memory:null with the reason — 200, not an error', async () => {
    const res = await app().request('/memory?node=oldbox');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      memory: null,
      reason: 'did not answer — that machine may run an older muxpad',
      node: { id: 'oldbox', name: 'Old box' },
      multiNode: true,
    });
  });

  it('a remote with no link wired at all is unknown too, never a crash', async () => {
    const r = (await (await hostRoutes({ db }).request('/memory?node=trayo')).json()) as {
      memory: null;
      reason: string;
    };
    expect(r).toMatchObject({ memory: null, reason: 'not connected' });
  });

  it('404s a machine that does not exist', async () => {
    expect((await app().request('/memory?node=ghost')).status).toBe(404);
  });

  it('lists every machine for Settings, one failure not sinking the rest', async () => {
    const r = (await (await app().request('/memory/nodes')).json()) as {
      multiNode: boolean;
      nodes: Array<{ id: string; memory: HostMemory | null; reason?: string }>;
    };
    expect(r.multiNode).toBe(true);
    expect(r.nodes.map((n) => [n.id, n.memory?.platform ?? null, n.reason ?? null])).toEqual([
      ['local', 'linux', null],
      ['oldbox', null, 'did not answer — that machine may run an older muxpad'],
      ['trayo', 'darwin', null],
    ]);
  });
});
