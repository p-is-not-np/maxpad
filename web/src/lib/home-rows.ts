import type { PaneStatus, Tab, Workspace } from '@muxpad/shared';

/**
 * THE PHONE HOME SCREEN'S LIST — what needs you, in the order it needs you.
 *
 * Pure, so the grouping and the hint choice are tested without a router, a
 * fetch or a React tree. The data is the navigator's own: the cross-workspace
 * corpus (`useAllChats`) and the five server-computed pane states. Nothing here
 * re-derives a status — it only sorts what the server already decided.
 *
 *   blocked  a question or an approval is waiting on the user
 *   ready    a finished turn nobody has looked at yet
 *   working  the machine is on it
 *
 * Everything else (idle, dead) is `rest`, which Home keeps behind a "more"
 * disclosure — still reachable, never in the way.
 */

/** The three groups Home leads with, in the order they render. */
export const HOME_GROUPS = ['blocked', 'ready', 'working'] as const;
export type HomeGroup = (typeof HOME_GROUPS)[number];

export interface HomeRow {
  tab: Tab;
  workspace: Workspace;
  status: PaneStatus;
  /** One line under the name, or null when there is nothing worth saying. */
  hint: string | null;
  /** Epoch ms of the last thing that happened, or null if never recorded. */
  at: number | null;
}

export interface HomeLists {
  blocked: HomeRow[];
  ready: HomeRow[];
  working: HomeRow[];
  /** idle and dead, newest first, capped at {@link REST_LIMIT}. */
  rest: HomeRow[];
}

/** How many quiet chats the "more" disclosure lists. It is a way back to
 *  something recent, not the navigator; the sheet holds the full list. */
export const REST_LIMIT = 12;

/** The status a row SHOWS. `attention` is the raw BEL bit an older server
 *  sends without `status` — the same fold MobileNavSwitcher makes. */
export function rowStatus(tab: Pick<Tab, 'attention' | 'status'>): PaneStatus {
  return tab.attention === true ? 'blocked' : (tab.status ?? 'idle');
}

/**
 * The one line under a row's name.
 *
 * `hint` is what the agent last SAID (its open question, or a snippet of the
 * reply that ended its last turn); `headline` is what the chat is ABOUT. For a
 * row that wants you, what it said is the point. For a working row the last
 * reply is history — the turn in flight has moved past it — so the headline
 * leads there.
 */
export function rowHint(
  tab: Pick<Tab, 'hint' | 'headline' | 'spawn_task'>,
  status: PaneStatus,
): string | null {
  const said = tab.hint?.trim() || null;
  const about = tab.headline?.trim() || tab.spawn_task?.trim() || null;
  return status === 'working' || status === 'idle' ? (about ?? said) : (said ?? about);
}

/**
 * Group every live chat by what it needs.
 *
 * LEFT OUT: chats in the done group (archived, decayed, delivered) and
 * SUB-CHATS whose parent is still listed. A sub-chat is not a row anywhere
 * else in muxpad — its parent's row already rolls its `blocked`/`working` up
 * (decorateTab) — so listing both would show one piece of work twice. A child
 * whose parent is gone has nothing to speak for it and is listed in its own
 * right, the same rule the server's clock resolver applies.
 */
export function homeLists(
  groups: readonly { workspace: Workspace; tabs: readonly Tab[] }[],
): HomeLists {
  const live = groups.flatMap(({ workspace, tabs }) =>
    tabs.filter((t) => t.done !== true).map((tab) => ({ tab, workspace })),
  );
  const liveIds = new Set(live.map((r) => r.tab.id));
  const out: HomeLists = { blocked: [], ready: [], working: [], rest: [] };
  for (const { tab, workspace } of live) {
    if (tab.spawned_by && liveIds.has(tab.spawned_by)) continue;
    const status = rowStatus(tab);
    const row: HomeRow = {
      tab,
      workspace,
      status,
      hint: rowHint(tab, status),
      at: tab.last_activity_at ?? null,
    };
    if (status === 'blocked' || status === 'ready' || status === 'working') out[status].push(row);
    else out.rest.push(row);
  }
  const newest = (a: HomeRow, b: HomeRow) => (b.at ?? 0) - (a.at ?? 0);
  out.blocked.sort(newest);
  out.ready.sort(newest);
  out.working.sort(newest);
  out.rest = out.rest.sort(newest).slice(0, REST_LIMIT);
  return out;
}

/** Group header words. `ready` reads as what it means to the reader. */
export const HOME_GROUP_LABEL: Record<HomeGroup, string> = {
  blocked: 'Needs you',
  ready: 'Ready',
  working: 'Working',
};
