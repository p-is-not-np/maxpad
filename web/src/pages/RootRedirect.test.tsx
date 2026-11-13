import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * WHERE A COLD LAUNCH LANDS. The installed app opens at `/`: a phone goes to
 * Home (what needs you), a desktop goes on into its first workspace exactly as
 * before. Deep links and notification taps never pass through here.
 */
const WENT: { to: string; params?: unknown }[] = [];
let MOBILE = false;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (opts: { to: string; params?: unknown }) => {
    WENT.push({ to: opts.to, params: opts.params });
  },
}));
vi.mock('../workspaces', () => ({
  refreshWorkspaces: async () => [{ id: 'w1', slug: 'acme', name: 'Acme' }],
  visibleWorkspaces: (w: unknown[]) => w,
}));
vi.mock('../lib/mobile-layout', () => ({ isMobileLayout: () => MOBILE }));
vi.mock('../api', () => ({ api: {} }));

const { RootRedirect } = await import('./RootRedirect');

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
async function land(): Promise<void> {
  WENT.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<RootRedirect />));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe('RootRedirect', () => {
  it('lands a phone on Home', async () => {
    MOBILE = true;
    await land();
    expect(WENT).toEqual([{ to: '/home', params: undefined }]);
  });

  it('leaves the desktop landing alone', async () => {
    MOBILE = false;
    await land();
    expect(WENT).toEqual([{ to: '/w/$wsSlug', params: { wsSlug: 'acme' } }]);
  });
});
