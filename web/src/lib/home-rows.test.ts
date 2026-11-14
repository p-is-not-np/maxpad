import type { Tab, Workspace } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { REST_LIMIT, homeLists, rowHint, rowStatus } from './home-rows';

const W = { id: 'w', slug: 'w', name: 'W', created_at: 0, updated_at: 0 } as Workspace;
function tab(id: string, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    slug: id,
    name: id,
    layout: { type: 'pane', id: `${id}-p` },
    created_at: 0,
    updated_at: 0,
    done: false,
    ...extra,
  } as Tab;
}
const ids = (rows: { tab: Tab }[]) => rows.map((r) => r.tab.id);

describe('homeLists', () => {
  it('groups by status — blocked, ready, working — newest first, quiet ones in rest', () => {
    const lists = homeLists([
      {
        workspace: W,
        tabs: [
          tab('idle', { status: 'idle', last_activity_at: 9 }),
          tab('w-old', { status: 'working', last_activity_at: 1 }),
          tab('w-new', { status: 'working', last_activity_at: 5 }),
          tab('ready', { status: 'ready', last_activity_at: 3 }),
          tab('ask', { status: 'blocked', last_activity_at: 2 }),
          tab('dead', { status: 'dead', last_activity_at: 4 }),
        ],
      },
    ]);
    expect(ids(lists.blocked)).toEqual(['ask']);
    expect(ids(lists.ready)).toEqual(['ready']);
    expect(ids(lists.working)).toEqual(['w-new', 'w-old']);
    expect(ids(lists.rest)).toEqual(['idle', 'dead']);
  });

  it('reads the raw BEL bit as blocked, like every other surface', () => {
    expect(rowStatus({ attention: true, status: 'idle' })).toBe('blocked');
    expect(rowStatus({})).toBe('idle');
  });

  it('leaves out done chats and sub-chats whose parent is listed', () => {
    const lists = homeLists([
      {
        workspace: W,
        tabs: [
          tab('parent', { status: 'working' }),
          tab('child', { status: 'blocked', spawned_by: 'parent' }),
          tab('orphan', { status: 'ready', spawned_by: 'gone' }),
          tab('archived', { status: 'ready', done: true }),
        ],
      },
    ]);
    expect(ids(lists.working)).toEqual(['parent']);
    expect(ids(lists.blocked)).toEqual([]);
    expect(ids(lists.ready)).toEqual(['orphan']);
  });

  it('caps the quiet list', () => {
    const many = Array.from({ length: REST_LIMIT + 5 }, (_, i) => tab(`t${i}`));
    expect(homeLists([{ workspace: W, tabs: many }]).rest).toHaveLength(REST_LIMIT);
  });
});

describe('rowHint', () => {
  const t = { hint: 'Which branch?', headline: 'Release prep' };
  it('leads with what it said when it wants you', () => {
    expect(rowHint(t, 'blocked')).toBe('Which branch?');
    expect(rowHint(t, 'ready')).toBe('Which branch?');
  });
  it('leads with what it is about while it works — the last reply is history', () => {
    expect(rowHint(t, 'working')).toBe('Release prep');
  });
  it('falls back either way, and says nothing rather than something empty', () => {
    expect(rowHint({ hint: null, headline: 'About' }, 'ready')).toBe('About');
    expect(rowHint({ hint: 'Said' }, 'working')).toBe('Said');
    expect(rowHint({ hint: '  ', headline: null }, 'blocked')).toBeNull();
  });
});
