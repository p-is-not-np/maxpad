import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { PtydCache, decorateTab, oneLineHint } from './ptyd-cache.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { runMigrations } from './store/migrations.js';

/**
 * THE ROW HINT — one line of what the agent last said, for the phone's Home
 * screen. The open question while blocked, else a snippet of the last reply.
 */
describe('pane hint', () => {
  it('prefers the open question, and drops it with the block', () => {
    const cache = new PtydCache();
    cache.setReplyHint('p1', 'Fixed the build.');
    expect(cache.getHint('p1')).toBe('Fixed the build.');

    cache.setQuestionHint('p1', 'Which branch should I use?');
    cache.setBlocked('p1', true);
    expect(cache.getHint('p1')).toBe('Which branch should I use?');

    // Answered (or the turn ended, or the runner went) — whichever path
    // clears the block takes the question with it.
    cache.setBlocked('p1', false);
    expect(cache.getHint('p1')).toBe('Fixed the build.');
  });

  it('is one line, capped', () => {
    expect(oneLineHint('  a\n\n  b\tc ')).toBe('a b c');
    const long = oneLineHint('x'.repeat(500));
    expect(long.length).toBe(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is forgotten with the pane', () => {
    const cache = new PtydCache();
    cache.setReplyHint('p1', 'done');
    cache.forget('p1');
    expect(cache.getHint('p1')).toBeNull();
  });
});

describe('decorateTab hint', () => {
  let db: Database.Database;
  let tabs: TabStore;
  let panes: PaneStore;
  let workspaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    tabs = new TabStore(db);
    panes = new PaneStore(db);
    workspaceId = new WorkspaceStore(db).create({ name: 'W' }).id;
  });

  it('publishes the pane hint on the row, and null when there is none', () => {
    const cache = new PtydCache();
    const t = tabs.create({ name: 'chat', layout: '', workspace_id: workspaceId });
    const p = panes.create({ tab_id: t.id, startup_cmd: 'muxpad agent', face: 'chat' });

    // Unconditional null, so a client coalescing rows can clear a stale one.
    expect(decorateTab(cache, db, t).hint).toBeNull();

    cache.setQuestionHint(p.id, 'Ship it?');
    cache.setBlocked(p.id, true);
    const row = decorateTab(cache, db, t);
    expect(row.status).toBe('blocked');
    expect(row.hint).toBe('Ship it?');
  });
});
