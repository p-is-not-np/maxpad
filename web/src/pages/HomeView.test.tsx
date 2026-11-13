import type { Tab, Workspace } from '@muxpad/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();
const W = { id: 'w1', slug: 'acme', name: 'Acme', created_at: 0, updated_at: 0 } as Workspace;
function tab(id: string, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    slug: `${id}-slug`,
    name: id,
    layout: { type: 'pane', id: `${id}-p` },
    created_at: 0,
    updated_at: 0,
    done: false,
    last_activity_at: NOW - 5 * 60_000,
    ...extra,
  } as Tab;
}

let GROUPS: { workspace: Workspace; tabs: Tab[] }[] = [];
const loadAllTabs = vi.fn(async () => []);

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    params,
    to,
    ...rest
  }: {
    children?: ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v);
    return (
      <a href={href} className={className} {...rest}>
        {children}
      </a>
    );
  },
}));
vi.mock('../lib/use-all-chats', () => ({ useAllChats: () => GROUPS }));
vi.mock('../lib/all-tabs', () => ({ loadAllTabs }));

const { HomeView } = await import('./HomeView');

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
function mount(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<HomeView />));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('HomeView', () => {
  it('lists what needs you first, one row per chat, each linking to its chat', () => {
    GROUPS = [
      {
        workspace: W,
        tabs: [
          tab('busy', { status: 'working', headline: 'Refactoring the cron store' }),
          tab('asks', { status: 'blocked', hint: 'Merge into main?' }),
          tab('done', { status: 'ready', unread: true, hint: 'All tests pass.' }),
          tab('quiet', { status: 'idle' }),
        ],
      },
    ];
    const el = mount();
    const sections = [...el.querySelectorAll('.home-section:not(.home-more)')];
    expect(sections.map((s) => s.getAttribute('data-group'))).toEqual([
      'blocked',
      'ready',
      'working',
    ]);
    const ask = el.querySelector('.home-row[data-status="blocked"]');
    expect(ask?.getAttribute('href')).toBe('/w/acme/t/asks-slug');
    expect(ask?.querySelector('.home-row-hint')?.textContent).toBe('Merge into main?');
    expect(ask?.querySelector('.home-row-age')?.textContent).toBe('5m');
    expect(el.querySelector('.home-row[data-status="working"] .home-row-hint')?.textContent).toBe(
      'Refactoring the cron store',
    );
    // Quiet chats stay behind "more" until asked for.
    expect(el.querySelector('a[href="/w/acme/t/quiet-slug"]')).toBeNull();
    const more = el.querySelector<HTMLButtonElement>('.home-more-toggle');
    act(() => more?.click());
    expect(el.querySelector('.home-more .home-row')?.getAttribute('href')).toBe(
      '/w/acme/t/quiet-slug',
    );
    expect(el.querySelector('.home-empty')).toBeNull();
  });

  it('says so plainly when nothing needs you', () => {
    GROUPS = [{ workspace: W, tabs: [tab('quiet', { status: 'idle' })] }];
    const el = mount();
    expect(el.querySelector('.home-empty')?.textContent).toContain('Nothing needs you');
    expect(el.querySelector('.home-section[data-group="blocked"]')).toBeNull();
    expect(el.querySelector('.home-all')?.getAttribute('href')).toBe('/w/acme');
  });

  it('refreshes the corpus when the app comes back to the foreground', () => {
    GROUPS = [];
    mount();
    loadAllTabs.mockClear();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(loadAllTabs).toHaveBeenCalled();
  });
});
