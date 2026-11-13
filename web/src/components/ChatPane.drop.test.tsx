import type { PaneSpec } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { ShellPaneBody } from './ShellPaneBody';
// Real ChatPane, face hook and approval components; only external boundaries
// are substituted. These tests verify placement/lifecycle, not browser geometry.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useNavigate: () => () => {},
}));
vi.mock('./XtermPane', () => ({ XtermPane: () => null }));
class Socket {
  static instances: Socket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(mobile: boolean) {
  Socket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', () => ({
    matches: mobile,
    addEventListener() {},
    removeEventListener() {},
  }));
  const measurements: Array<{ target: Element; notify: () => void }> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        measurements.push({ target, notify: this.callback });
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url === '/api/tabs/all' ? { workspaces: [] } : []),
  }));
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  return {
    fetchMock,
    measurements,
  };
}
const pane = (pick = false) =>
  ({
    id: 'chat-approval-pane',
    tab_id: 'chat-tab',
    kind: 'shell',
    face: 'chat',
    mode: 'chat',
    startup_cmd: `muxpad agent --mode chat${pick ? ' --pick' : ''}`,
  }) as PaneSpec;
const render = async (active: boolean, pick = false) =>
  act(async () =>
    root.render(<ShellPaneBody pane={pane(pick)} onExit={() => {}} paneActive={active} />),
  );

async function openChat() {
  await render(true);
  const socket = Socket.instances.find((s) => s.url.endsWith('/ws/chat/chat-approval-pane'));
  await act(async () => {
    socket!.readyState = 1;
    socket!.onopen?.();
    socket!.onmessage?.({
      data: JSON.stringify({
        t: 'session',
        mode: 'chat',
        hasMessages: true,
        turnRunning: false,
        session: {
          current_sid: 'chat-session',
          writer: 'runner',
          view_mode: 'chat',
          assistant: 'claude',
        },
      }),
    });
  });
}

/**
 * A FILE DROPPED ON THE COMPOSER IS AN ATTACHMENT.
 *
 * Reported from an iPhone: dragging a photo out of Photos into the composer did
 * nothing. There was no drop handler, and iOS hands a dragged photo over as a
 * `DataTransferItem` of kind `file` with `files` EMPTY — so even a handler that
 * read `files` would have taken nothing. These drive the real ChatPane.
 */
function dataTransfer(opts: { items?: File[]; files?: File[]; types?: string[] }) {
  const items = (opts.items ?? []).map((f) => ({
    kind: 'file',
    type: f.type,
    getAsFile: () => f,
  }));
  return {
    types: opts.types ?? [],
    items,
    files: opts.files ?? [],
    dropEffect: 'none',
  };
}
function fire(el: Element, type: string, dt: unknown) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  el.dispatchEvent(ev);
  return ev;
}

it.each([
  ['iOS: item only, files empty', { items: true, files: false, types: [] as string[] }],
  ['desktop: files + Files type', { items: false, files: true, types: ['Files'] }],
])('a dropped photo uploads through the attach path (%s)', async (_label, shape) => {
  setup(true);
  const upload = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({ path: '/tmp/a.jpg' });
  await openChat();
  const composer = host.querySelector('.chat-composer');
  expect(composer).not.toBeNull();
  const photo = new File([new Uint8Array([1, 2, 3])], 'IMG_0001.jpeg', { type: 'image/jpeg' });
  const dt = dataTransfer({
    items: shape.items ? [photo] : [],
    files: shape.files ? [photo] : [],
    types: shape.types,
  });
  let over!: Event;
  await act(async () => {
    over = fire(composer!, 'dragover', dt);
  });
  // A drop is only delivered where `dragover` was cancelled.
  expect(over.defaultPrevented).toBe(true);
  expect(composer!.classList.contains('-dropping')).toBe(true);
  let drop!: Event;
  await act(async () => {
    drop = fire(composer!, 'drop', dt);
  });
  expect(drop.defaultPrevented).toBe(true);
  expect(composer!.classList.contains('-dropping')).toBe(false);
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(upload.mock.calls[0]?.[1]).toBe(photo);
  expect(upload.mock.calls[0]?.[2]).toBe('IMG_0001.jpeg');
});

it('leaves a text drag to the browser', async () => {
  setup(true);
  const upload = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({ path: '/tmp/a.jpg' });
  await openChat();
  const composer = host.querySelector('.chat-composer')!;
  const dt = { types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain' }], files: [] };
  let over!: Event;
  await act(async () => {
    over = fire(composer, 'dragover', dt);
    fire(composer, 'drop', dt);
  });
  expect(over.defaultPrevented).toBe(false);
  expect(upload).not.toHaveBeenCalled();
});
