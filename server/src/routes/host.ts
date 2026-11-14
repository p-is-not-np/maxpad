import type { HostMemory } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { readHostMemory } from '../host-memory.js';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';

/** One machine's reading, or why there is none. */
export type MemoryAnswer = { memory: HostMemory } | { error: string };

/**
 * `GET /api/host/memory[?node=ID|tab=ID][&top=N]` — one machine's RAM and
 * swap, for the rail's memory gauge (see shared/src/host-memory.ts).
 * `GET /api/host/memory/nodes` — every machine's, for Settings → Machines.
 *
 * ── WHICH MACHINE ────────────────────────────────────────────────────────
 * The gauge shows the machine of the chat you are IN, because that is the one
 * whose memory your next command spends. So the client names the tab and the
 * server resolves it to the machine that owns its pane — the client holds no
 * node list, and on a one-machine install has none to hold. `node` names one
 * directly; neither means this machine.
 *
 * ── A REMOTE THAT CANNOT SAY IS "UNKNOWN", NOT AN ERROR ──────────────────
 * Unreachable, or an older muxpad-node that predates the `host` channel:
 * `memory: null` with the reason, at 200. The gauge renders that as unknown
 * for that machine. An error status would read as "the gauge is broken".
 *
 * `top` is opt-in: the gauge polls the cheap totals, and asks for the process
 * list only when someone opens it.
 */
export function hostRoutes(
  deps: {
    read?: (o: { top?: number }) => Promise<HostMemory>;
    /** Absent in tests that only read this machine; every node is then local. */
    db?: Database.Database;
    /** Ask a remote machine over its host link. */
    remote?: (nodeId: string, top: number) => Promise<MemoryAnswer>;
  } = {},
) {
  const read = deps.read ?? readHostMemory;
  const nodes = () => (deps.db ? new NodeStore(deps.db) : null);
  const app = new Hono();

  /** Never throws: a failure is an answer, so one machine cannot sink a list. */
  const readNode = async (nodeId: string, top: number): Promise<MemoryAnswer> => {
    if (nodeId === LOCAL_NODE_ID) {
      try {
        return { memory: await read({ top }) };
      } catch (e) {
        return { error: `memory unreadable: ${(e as Error).message}` };
      }
    }
    return deps.remote ? deps.remote(nodeId, top) : { error: 'not connected' };
  };

  app.get('/memory', async (c) => {
    const n = Number(c.req.query('top') ?? 0);
    const top = Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), 20)) : 0;
    const store = nodes();
    let nodeId = c.req.query('node') || LOCAL_NODE_ID;
    const tab = c.req.query('tab');
    if (!c.req.query('node') && tab && store) nodeId = store.nodeForTab(tab);
    const row = store?.get(nodeId) ?? null;
    if (nodeId !== LOCAL_NODE_ID && !row)
      return c.json({ error: { code: 'not_found', message: 'no such machine' } }, 404);
    const node = { id: nodeId, name: row?.name ?? 'this machine' };
    const multiNode = store?.isMultiNode() ?? false;
    const r = await readNode(nodeId, top);
    c.header('Cache-Control', 'no-store');
    if ('memory' in r) return c.json({ memory: r.memory, node, multiNode });
    // This machine failing to read itself IS broken, and says so as before.
    if (nodeId === LOCAL_NODE_ID)
      return c.json({ error: { code: 'unavailable', message: r.error } }, 503);
    return c.json({ memory: null, reason: r.error, node, multiNode });
  });

  app.get('/memory/nodes', async (c) => {
    const store = nodes();
    const list = store?.list() ?? [];
    const rows = list.length ? list : [{ id: LOCAL_NODE_ID, name: 'this machine' }];
    const out = await Promise.all(
      rows.map(async (n) => {
        const r = await readNode(n.id, 0);
        return 'memory' in r
          ? { id: n.id, name: n.name, memory: r.memory }
          : { id: n.id, name: n.name, memory: null, reason: r.error };
      }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ nodes: out, multiNode: store?.isMultiNode() ?? false });
  });

  return app;
}
