import type { HostMemory } from '@muxpad/shared';
import { Hono } from 'hono';
import { readHostMemory } from '../host-memory.js';

/**
 * `GET /api/host/memory[?top=N]` — this machine's RAM and swap, for the rail's
 * memory gauge (see shared/src/host-memory.ts for why it exists).
 *
 * `top` is opt-in: the gauge polls the cheap totals, and asks for the process
 * list only when someone opens it.
 */
export function hostRoutes(deps: { read?: (o: { top?: number }) => Promise<HostMemory> } = {}) {
  const read = deps.read ?? readHostMemory;
  const app = new Hono();
  app.get('/memory', async (c) => {
    const n = Number(c.req.query('top') ?? 0);
    const top = Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), 20)) : 0;
    try {
      const memory = await read({ top });
      c.header('Cache-Control', 'no-store');
      return c.json({ memory });
    } catch (e) {
      return c.json(
        { error: { code: 'unavailable', message: `memory unreadable: ${(e as Error).message}` } },
        503,
      );
    }
  });
  return app;
}
