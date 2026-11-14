import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ── THREE READERS OF ONE VALUE, AND WHICH ONE WINS ───────────────────────
 *
 * The install's theme reaches a window by three asynchronous routes — the boot
 * prefetch, a `prefs.updated` push, and a refetch after a reconnect — and both
 * of the ways that goes wrong were real:
 *
 *   · the boot request (1.5s wait budget) answers LATE and overwrites a theme
 *     somebody picked while it was in flight;
 *   · the push is fire-and-forget and replays nothing, so a window whose
 *     socket was down during the pick never learns the new theme at all.
 *
 * Both are ordering, not fetching, so they are tested here against the module
 * that owns the order rather than through a mounted app.
 */

const getPrefs = vi.fn<() => Promise<{ prefs: Record<string, string> }>>();
vi.mock('../api', () => ({ api: { prefs: () => getPrefs() } }));

let applied: (string | null)[] = [];
let styled: (string | null)[] = [];
let composed: (string | null)[] = [];
vi.mock('../settings', async (orig) => {
  const real = await orig<typeof import('../settings')>();
  return {
    ...real,
    setServerTheme: (c: string | null) => {
      applied.push(c);
      real.setServerTheme(c as never);
    },
    setServerStyle: (c: string | null) => {
      styled.push(c);
      real.setServerStyle(c as never);
    },
    setServerComposer: (c: string | null) => {
      composed.push(c);
      real.setServerComposer(c as never);
    },
  };
});

async function load() {
  vi.resetModules();
  applied = [];
  styled = [];
  composed = [];
  return await import('./app-theme');
}

beforeEach(() => {
  getPrefs.mockReset();
});

describe('the theme’s sources are applied in issue order', () => {
  it('takes the boot snapshot when it is the only thing that has arrived', async () => {
    const t = await load();
    t.applyBootPrefs({ theme: 'memphis' });
    expect(applied).toEqual(['memphis']);
  });

  it('DROPS a boot snapshot that answers after a live value', async () => {
    const t = await load();
    getPrefs.mockResolvedValue({ prefs: { theme: 'riso' } });
    await t.refreshAppTheme();
    // The prefetch finally answers — with what the server said before the pick.
    t.applyBootPrefs({ theme: 'memphis' });
    expect(applied).toEqual(['riso']);
  });

  it('DROPS a refetch that was issued before a push it raced', async () => {
    const t = await load();
    let answer!: (v: { prefs: Record<string, string> }) => void;
    getPrefs.mockReturnValue(
      new Promise((res) => {
        answer = res;
      }),
    );
    const inFlight = t.refreshAppTheme();
    // The pick lands while the refetch is still out.
    t.applyPushedPrefs({ theme: 'riso' });
    answer({ prefs: { theme: 'memphis' } });
    await inFlight;
    expect(applied).toEqual(['riso']);
  });

  it('lets a push win however many have come before it', async () => {
    const t = await load();
    t.applyBootPrefs({ theme: 'memphis' });
    t.applyPushedPrefs({ theme: 'riso' });
    t.applyPushedPrefs({ theme: 'tokyo-night' });
    t.applyPushedPrefs({ theme: 'memphis' });
    expect(applied).toEqual(['memphis', 'riso', 'tokyo-night', 'memphis']);
  });

  it('keeps the palette on screen when the refetch fails', async () => {
    const t = await load();
    t.applyBootPrefs({ theme: 'memphis' });
    getPrefs.mockRejectedValue(new Error('offline'));
    await t.refreshAppTheme();
    expect(applied).toEqual(['memphis']);
  });

  it('applies the refetch when nothing newer has landed — the recovery case', async () => {
    const t = await load();
    t.applyBootPrefs({ theme: 'memphis' });
    getPrefs.mockResolvedValue({ prefs: { theme: 'riso' } });
    await t.refreshAppTheme();
    expect(applied).toEqual(['memphis', 'riso']);
  });
});

describe('the style rides the same order', () => {
  it('is applied with the theme from the same prefs set', async () => {
    const t = await load();
    t.applyBootPrefs({ theme: 'memphis', style: 'minimal' });
    expect(applied).toEqual(['memphis']);
    expect(styled).toEqual(['minimal']);
  });

  it('reads an unknown or absent style as nothing chosen', async () => {
    const t = await load();
    t.applyPushedPrefs({ style: 'brutalist' });
    t.applyPushedPrefs({ theme: 'riso' });
    expect(styled).toEqual([null, null]);
  });

  it('DROPS a boot style that answers after a pushed one', async () => {
    const t = await load();
    t.applyPushedPrefs({ style: 'floating' });
    t.applyBootPrefs({ style: 'combo' });
    expect(styled).toEqual(['floating']);
  });
});

describe('the prompt box rides it too', () => {
  it('is applied from the same prefs set, unknown values as nothing chosen', async () => {
    const t = await load();
    t.applyBootPrefs({ theme: 'memphis', style: 'combo', composer: 'a' });
    t.applyPushedPrefs({ composer: 'nope' });
    expect(composed).toEqual(['a', null]);
  });

  it('DROPS a boot value that answers after a pushed one', async () => {
    const t = await load();
    t.applyPushedPrefs({ composer: 'c' });
    t.applyBootPrefs({ composer: 'b' });
    expect(composed).toEqual(['c']);
  });

  it('is recovered by the reconnect refetch', async () => {
    const t = await load();
    getPrefs.mockResolvedValue({ prefs: { composer: 'b' } });
    await t.refreshAppTheme();
    expect(composed).toEqual(['b']);
  });
});

describe('a reconnect recovers the theme it missed', () => {
  it('refetches alongside the workspaces, not only on a reload', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8');
    const reconnect = src.slice(src.indexOf('subscribeReconnect('));
    expect(reconnect.slice(0, 400)).toContain('refreshAppTheme');
  });

  it('applies the boot payload through the guard, never straight to the document', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dirname, '..', 'main.tsx'), 'utf8');
    expect(src).toContain('applyBootPrefs');
    // `setServerTheme` is the unguarded door: boot calling it directly is the
    // late-overwrite bug, whatever the ordering code says.
    expect(src).not.toMatch(/setServerTheme\(/);
  });
});
