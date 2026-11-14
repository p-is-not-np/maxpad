import { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { agentNotesPath } from '../agent-files.js';

/** Bounded: the notes are injected into every agent session's context. */
export const MAX_AGENT_NOTES_BYTES = 64 * 1024;

/** The data dir's entries worth naming in Settings → Data, largest first. */
const USAGE_LIMIT = 12;

/**
 * `/api/install` — the Settings dialog's view of the install itself.
 *
 *   GET/PUT /agent-notes   the user's standing notes (agent-notes.md), the one
 *                          instruction file muxpad never writes on its own.
 *   GET     /usage         where the data lives and what it weighs.
 *
 * The notes are read at session start (see agent-instructions), so a save
 * applies to the NEXT session, not to the ones already running — the dialog
 * says so rather than implying a live edit.
 */
export function installRoutes(deps: { dataDir: string }): Hono {
  const app = new Hono();

  app.get('/agent-notes', (c) => {
    c.header('Cache-Control', 'no-store');
    let text = '';
    try {
      text = readFileSync(agentNotesPath(deps.dataDir), 'utf8');
    } catch {
      // Absent is an empty notes file, not an error.
    }
    return c.json({ text, path: agentNotesPath(deps.dataDir) });
  });

  app.put('/agent-notes', async (c) => {
    const parsed = z
      .object({ text: z.string() })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_request', message: 'text is required' } }, 400);
    const { text } = parsed.data;
    if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_NOTES_BYTES)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: `notes exceed ${MAX_AGENT_NOTES_BYTES / 1024} KB`,
          },
        },
        400,
      );
    // Write-then-rename, so a session starting mid-save reads the old notes or
    // the new ones, never half of either.
    const path = agentNotesPath(deps.dataDir);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return c.json({ text, path });
  });

  app.get('/usage', (c) => {
    c.header('Cache-Control', 'no-store');
    const entries: Array<{ name: string; bytes: number }> = [];
    let total = 0;
    let names: string[] = [];
    try {
      names = readdirSync(deps.dataDir);
    } catch {
      // An unreadable data dir reports as empty.
    }
    for (const name of names) {
      const bytes = sizeOf(join(deps.dataDir, name));
      total += bytes;
      entries.push({ name, bytes });
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    return c.json({ dataDir: deps.dataDir, total, entries: entries.slice(0, USAGE_LIMIT) });
  });

  return app;
}

/** Bytes under `path`, without following symlinks (a link out of the data dir
 *  is not the data dir's weight). Unreadable parts count as zero. */
function sizeOf(path: string): number {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let sum = 0;
  let children: string[] = [];
  try {
    children = readdirSync(path);
  } catch {
    return 0;
  }
  for (const child of children) sum += sizeOf(join(path, child));
  return sum;
}
