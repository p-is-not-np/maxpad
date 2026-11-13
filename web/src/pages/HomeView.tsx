import { fallbackTabIcon } from '@muxpad/shared';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { ChatChip } from '../components/ChatChip';
import { StatusMark } from '../components/StatusMark';
import { loadAllTabs } from '../lib/all-tabs';
import { HOME_GROUPS, HOME_GROUP_LABEL, type HomeRow, homeLists } from '../lib/home-rows';
import { activeAge } from '../lib/short-age';
import { useAllChats } from '../lib/use-all-chats';
import { useDocumentTitle } from '../use-document-title';
import './HomeView.css';

/**
 * HOME — what needs you, on a phone.
 *
 * Where a cold launch of the installed app lands (RootRedirect sends a phone
 * here instead of into whichever chat happened to be open last), and where the
 * mobile chrome's brand mark leads afterwards. Three groups — needs you, ready,
 * working — one compact row per chat, everything quiet behind "more".
 *
 * LIVE through the navigator's own corpus (`useAllChats`): pane status edges
 * already refetch it (tabs.ts → all-tabs), so a question arriving moves its row
 * within a beat. The slow poll below only covers what no push carries while no
 * workspace is mounted, and coming back to the app — the commonest way this
 * screen is looked at.
 */
const HOME_POLL_MS = 10_000;

export function HomeView() {
  const groups = useAllChats();
  const lists = useMemo(() => homeLists(groups), [groups]);
  const [moreOpen, setMoreOpen] = useState(false);
  const now = useNow(30_000);

  const needs = lists.blocked.length;
  useDocumentTitle(needs > 0 ? `(${needs}) muxpad` : 'muxpad');

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadAllTabs();
    };
    const timer = window.setInterval(refresh, HOME_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const multiWorkspace = groups.length > 1;
  const firstWorkspace = groups[0]?.workspace;
  const quiet = HOME_GROUPS.every((g) => lists[g].length === 0);
  const summary = HOME_GROUPS.filter((g) => lists[g].length > 0)
    .map((g) => `${lists[g].length} ${HOME_GROUP_LABEL[g].toLowerCase()}`)
    .join(' · ');

  const renderRow = (row: HomeRow) => (
    <li key={row.tab.id}>
      <Link
        to="/w/$wsSlug/t/$tabSlug"
        params={{ wsSlug: row.workspace.slug, tabSlug: row.tab.slug }}
        className="home-row"
        data-status={row.status}
        data-unread={row.tab.unread ? 'true' : undefined}
      >
        <ChatChip
          density="row"
          shape="tile"
          className="home-row-icon"
          chat={{ ...row.tab, icon: row.tab.icon ?? fallbackTabIcon(row.tab.id) }}
        />
        <span className="home-row-main">
          <span className="home-row-name" dir="auto">
            {row.tab.name}
          </span>
          {row.hint && (
            <span className="home-row-hint" dir="auto">
              {row.hint}
            </span>
          )}
        </span>
        <span className="home-row-side">
          {row.at !== null && (
            <time className="home-row-age" dateTime={new Date(row.at).toISOString()}>
              {activeAge(now - row.at)}
            </time>
          )}
          {multiWorkspace && <span className="home-row-ws">{row.workspace.name}</span>}
        </span>
        <StatusMark status={row.status} className="home-row-mark" />
      </Link>
    </li>
  );

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1 className="home-title">Home</h1>
          {!quiet && <p className="home-sub">{summary}</p>}
        </header>

        {quiet ? (
          <output className="home-empty">
            <StatusMark status="ready" className="home-empty-mark" />
            <span className="home-empty-title">Nothing needs you</span>
            <span className="home-empty-sub">
              No questions waiting, no unread replies, nothing running.
            </span>
          </output>
        ) : (
          HOME_GROUPS.map((g) =>
            lists[g].length === 0 ? null : (
              <section key={g} className="home-section" data-group={g}>
                <h2 className="home-section-label">
                  {HOME_GROUP_LABEL[g]}
                  <span className="home-section-count">{lists[g].length}</span>
                </h2>
                <ul className="home-list">{lists[g].map(renderRow)}</ul>
              </section>
            ),
          )
        )}

        {lists.rest.length > 0 && (
          <section className="home-section home-more" data-group="rest">
            <button
              type="button"
              className="home-more-toggle"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
            >
              {moreOpen ? 'Fewer' : 'More'}
              <span className="home-more-hint">recent quiet chats</span>
            </button>
            {moreOpen && <ul className="home-list">{lists.rest.map(renderRow)}</ul>}
          </section>
        )}

        {firstWorkspace && (
          <Link to="/w/$wsSlug" params={{ wsSlug: firstWorkspace.slug }} className="home-all">
            All chats →
          </Link>
        )}
      </div>
    </div>
  );
}

/** A clock that ticks every `ms` — the ages are minutes and hours, so a
 *  half-minute tick is the coarsest one that never reads wrong. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
