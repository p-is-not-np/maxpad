import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefStore } from '../store/PrefStore.js';
import { openDb } from '../store/db.js';
import { MAX_AGENT_NOTES_BYTES, installRoutes } from './install.js';
import { defaultLifespanDays } from './publish.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-install-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const put = (app: ReturnType<typeof installRoutes>, body: unknown) =>
  app.request('/agent-notes', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Settings → Agents: standing instructions', () => {
  it('reads an absent notes file as empty, and writes the file agents read', async () => {
    const app = installRoutes({ dataDir: dir });
    expect(((await (await app.request('/agent-notes')).json()) as { text: string }).text).toBe('');
    const res = await put(app, { text: 'projects live in ~/src' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, 'agent-notes.md'), 'utf8')).toBe('projects live in ~/src');
  });

  it('refuses a body that is not text, or is too large to inject', async () => {
    const app = installRoutes({ dataDir: dir });
    expect((await put(app, { text: 1 })).status).toBe(400);
    expect((await put(app, { text: 'x'.repeat(MAX_AGENT_NOTES_BYTES + 1) })).status).toBe(400);
  });
});

describe('Settings → Data: storage', () => {
  it('sums the data dir, largest entry first', async () => {
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', 'a'), 'x'.repeat(300));
    writeFileSync(join(dir, 'db.sqlite'), 'x'.repeat(100));
    const body = (await (await installRoutes({ dataDir: dir }).request('/usage')).json()) as {
      total: number;
      entries: Array<{ name: string; bytes: number }>;
    };
    expect(body.total).toBe(400);
    expect(body.entries.map((e) => e.name)).toEqual(['archive', 'db.sqlite']);
  });
});

describe('Settings → Data: publish lifetime', () => {
  it('defaults to seven days, follows the pref, and ignores garbage', () => {
    const db = openDb(':memory:');
    const prefs = new PrefStore(db);
    expect(defaultLifespanDays(db)).toBe(7);
    prefs.set('publish_days', '30');
    expect(defaultLifespanDays(db)).toBe(30);
    prefs.set('publish_days', '0');
    expect(defaultLifespanDays(db)).toBe(0);
    prefs.set('publish_days', 'soon');
    expect(defaultLifespanDays(db)).toBe(7);
  });
});
