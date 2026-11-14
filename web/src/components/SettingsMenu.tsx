import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';

import { type PushState, disablePush, enablePush, getPushState, sendTestPush } from '../lib/push';
import {
  COMPOSERS,
  type ComposerDesign,
  STYLES,
  SYSTEM_PAIR,
  THEME_CHOICES,
  type ThemeChoice,
  type UiStyle,
  composerInForce,
  getServerComposer,
  getServerStyle,
  getServerTheme,
  setServerComposer,
  setServerStyle,
  setServerTheme,
  styleInForce,
  themeInForce,
  updateSettings,
  useSettings,
} from '../settings';
import { MachinesSettings } from './MachinesSettings';
import { SlackPasskeySettings } from './SlackPasskeySettings';
import './SettingsMenu.css';

export function SettingsMenu() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const [openedOnce, setOpenedOnce] = useState(false);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  // ── NOTIFICATIONS IS ITS OWN SECTION ──────────────────────────────────
  // It was the last row of General, directly under the theme grid, and that
  // is where it read as part of the grid: "move the notifications thing to
  // another tab/place, they feel like the action button for picking a theme."
  // A lone "Enable" button on the right of a row, six pixels under a row of
  // theme tiles, is a button a reader will reasonably attach to the thing
  // above it — the proximity says so louder than the label does.
  //
  // It is not a General setting anyway: General is what this app LOOKS like,
  // and this is a permission the browser grants to a device. Its own section
  // also gives the push state somewhere to explain itself (see PushSection),
  // which a one-line row never had room for.
  const [section, setSection] = useState<
    'appearance' | 'notifications' | 'integrations' | 'machines'
  >('appearance');
  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    el?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      el?.close();
      document.body.style.overflow = previousOverflow;
      trigger.current?.focus();
    };
  }, [open]);

  return (
    <div className="settings-wrap">
      <button
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        type="button"
        className="icon-btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => {
          setOpenedOnce(true);
          setOpen((v) => !v);
        }}
      >
        <SvgGear />
      </button>
      {openedOnce &&
        createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog provides Escape; this click only dismisses its backdrop.
          <dialog
            ref={dialog}
            className="settings-dialog"
            aria-labelledby="settings-title"
            onCancel={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                const bounds = event.currentTarget.getBoundingClientRect();
                if (
                  event.clientX < bounds.left ||
                  event.clientX > bounds.right ||
                  event.clientY < bounds.top ||
                  event.clientY > bounds.bottom
                )
                  setOpen(false);
              }
            }}
          >
            <header className="settings-chrome">
              <h2 id="settings-title">Settings</h2>
              {/* TWO LABELS, ONE CONTROL. On a pointer device the × is obvious
                  and Escape works. On a phone there is no Escape key, and the
                  dialog covers the screen to within 8px — so the backdrop tap
                  that dismisses it on desktop has no target worth aiming at,
                  and a muted 1.5rem glyph in the corner was the only way out.
                  Reported as "I can't close it". The word is the affordance;
                  the glyph stays for the pointer case. */}
              <button
                type="button"
                className="settings-close"
                aria-label="Close settings"
                onClick={() => setOpen(false)}
              >
                <span className="settings-close-word" aria-hidden="true">
                  Done
                </span>
                <span className="settings-close-x" aria-hidden="true">
                  ×
                </span>
              </button>
            </header>
            <div className="settings-layout">
              <aside className="settings-sidebar">
                <nav aria-label="Settings sections">
                  {(['appearance', 'notifications', 'integrations', 'machines'] as const).map(
                    (item) => (
                      <button
                        key={item}
                        type="button"
                        aria-current={section === item ? 'page' : undefined}
                        onClick={() => setSection(item)}
                      >
                        {item.charAt(0).toUpperCase() + item.slice(1)}
                      </button>
                    ),
                  )}
                </nav>
              </aside>
              {/* NO SECTION HEADING. It printed the selected nav item back at
                  you — "Appearance" in the list, "Appearance" again as an h2 three
                  centimetres to its right — which is a title for a page that
                  already has one. The nav IS the heading. */}
              <div className="settings-body">
                <section hidden={section !== 'machines'} aria-label="Machines">
                  <MachinesSettings />
                </section>
                <section hidden={section !== 'appearance'} aria-label="Appearance settings">
                  <ThemePicker chosen={themeInForce(settings)} />
                  <StylePicker chosen={styleInForce(settings)} />
                  <ComposerPicker chosen={composerInForce(settings)} />
                </section>
                <section hidden={section !== 'notifications'} aria-label="Notification settings">
                  <PushSection />
                </section>
                <SlackPasskeySettings active={open} section={section} />
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </div>
  );
}

/**
 * THE PICKER HAS TO SHOW THE THEME, NOT NAME IT.
 *
 * It was a <select>. "System (Dracula / Alucard)" in a dropdown tells you
 * nothing about what any of them look like, and since demoscene a theme may
 * own the TYPEFACE and draw its own structure — so the thing the list was
 * hiding had grown to be most of what a theme is.
 *
 * Each tile paints itself with the real tokens. `[data-theme="x"]` is an
 * attribute selector, not a :root rule, so setting the attribute on a 96px
 * div inside the dialog gives that div the whole palette AND --ui-font. The
 * preview therefore cannot drift from the theme: there is no second copy of
 * the colours here, and a theme added later gets a correct tile for free.
 *
 * Real radio inputs rather than buttons with aria-checked: a radiogroup is one
 * tab stop with arrow keys inside it, which is the behaviour a grid of
 * mutually exclusive choices should have and the behaviour nobody writes
 * correctly by hand.
 */
/**
 * THE GRID SETS THE WHOLE INSTALL'S THEME.
 *
 * It wrote the CHAT's for a while — a theme lived on the tab row so it would
 * follow you between devices — and because a theme defines the rail's palette
 * as well as the pane's, switching chats repainted the entire window. One
 * value now, stored server-side and pushed to every open window (see
 * lib/app-theme), so there is one control and no "and also everywhere" button
 * beside it.
 */
export function ThemePicker({ chosen, group = 'theme' }: { chosen: ThemeChoice; group?: string }) {
  const [failed, setFailed] = useState(false);
  /**
   * Optimistic, and it UNDOES ITSELF when the write fails.
   *
   * The repaint has to happen on the press — a theme that waited for a round
   * trip feels like a toggle that sticks. But an earlier version swallowed the
   * error, so a server that could not store the value produced the worst
   * possible shape: the window repainted, the next poll delivered the old
   * value, and the theme snapped back with no explanation. Reported as "tried
   * to change the theme and it just didn't work, flickered and returned".
   *
   * Reverting here makes the failure immediate and legible instead of
   * arriving seconds later as a flicker, and the line under the grid says
   * what to do about it.
   *
   * THE PUSH IS WHAT MAKES THE OTHER WINDOWS FOLLOW, not this call — the
   * server emits `prefs.updated` to everyone, including us, and
   * `setServerTheme` is a no-op for a value already in force. So the local
   * repaint is only ever about latency.
   */
  const pick = (value: ThemeChoice) => {
    const before = getServerTheme();
    setFailed(false);
    setServerTheme(value);
    void api.setPref('theme', value).catch((err) => {
      console.error('could not store the theme', err);
      setServerTheme(before);
      setFailed(true);
    });
  };
  return (
    <fieldset className="settings-row settings-themes">
      <legend>Theme</legend>
      <div className="theme-grid">
        {THEME_CHOICES.map((t) => (
          <label key={t.value} className="theme-tile" data-chosen={t.value === chosen}>
            <input
              type="radio"
              name={group}
              value={t.value}
              checked={t.value === chosen}
              onChange={() => pick(t.value)}
            />
            {/* System is the only choice that is two themes, so its tile is
                two previews cut on the diagonal — the light one over the dark
                one, which is the thing the label was trying to say in words. */}
            {t.value === 'system' ? (
              <span className="theme-tile-preview theme-tile-split">
                <ThemeMock theme={SYSTEM_PAIR.dark} />
                <ThemeMock theme={SYSTEM_PAIR.light} />
              </span>
            ) : (
              <span className="theme-tile-preview">
                <ThemeMock theme={t.value} />
              </span>
            )}
            <span className="theme-tile-name">{t.label}</span>
          </label>
        ))}
      </div>
      {/* THERE IS NO "USE FOR EVERY CHAT" ANY MORE, and no way back to a
          default, because there is nothing to come back FROM: one theme, for
          the install. The button existed to clear a chat's override and
          promote it to the device default — two concepts that are now one
          value, and a control whose label described a distinction nobody
          asked for. */}
      {failed ? (
        <p className="settings-note" role="alert">
          Couldn’t save the theme. The server may be running a build from before it moved off this
          browser — restart muxpad and try again.
        </p>
      ) : null}
    </fieldset>
  );
}

/** A muxpad in miniature: the rail, a head, and three lines of a chat. */
function ThemeMock({ theme }: { theme: string }) {
  return (
    <span className="theme-mock" data-theme={theme} aria-hidden="true">
      <span className="theme-mock-rail">
        <i className="theme-mock-dot" />
        <i className="theme-mock-row" />
        <i className="theme-mock-row theme-mock-row--on" />
      </span>
      <span className="theme-mock-page">
        {/* "Aa" in the theme's own --ui-font: on half of these the typeface
            is the headline and the palette is the footnote. */}
        <b className="theme-mock-aa">Aa</b>
        <i className="theme-mock-line" />
        <i className="theme-mock-line theme-mock-line--short" />
      </span>
    </span>
  );
}

/**
 * THE STYLE PICKER — the theme picker's twin, for how the chrome is BUILT.
 *
 * Same contract as {@link ThemePicker}: one value for the install, stored
 * server-side and pushed to every window, applied optimistically on the press
 * and undone if the write fails. The tiles are drawn in the theme in force
 * (they inherit the dialog's tokens), so what changes between them is only
 * the structure — which is the only thing a style is.
 */
export function StylePicker({ chosen }: { chosen: UiStyle }) {
  const [failed, setFailed] = useState(false);
  const pick = (value: UiStyle) => {
    const before = getServerStyle();
    setFailed(false);
    setServerStyle(value);
    void api.setPref('style', value).catch((err) => {
      console.error('could not store the style', err);
      setServerStyle(before);
      setFailed(true);
    });
  };
  return (
    <fieldset className="settings-row settings-themes settings-styles">
      <legend>Style</legend>
      <div className="theme-grid style-grid">
        {STYLES.map((s) => (
          <label key={s.value} className="theme-tile" data-chosen={s.value === chosen}>
            <input
              type="radio"
              name="style"
              value={s.value}
              checked={s.value === chosen}
              onChange={() => pick(s.value)}
            />
            <span className="theme-tile-preview">
              <StyleMock look={s.value} />
            </span>
            <span className="theme-tile-name">{s.label}</span>
          </label>
        ))}
      </div>
      {failed ? (
        <p className="settings-note" role="alert">
          Couldn’t save the style. The server may be running a build from before styles existed —
          restart muxpad and try again.
        </p>
      ) : null}
    </fieldset>
  );
}

/** The frame of a muxpad in miniature: a rail, a page, and a composer — the
 *  three things whose construction a style changes. */
function StyleMock({ look }: { look: UiStyle }) {
  return (
    <span className="style-mock" data-look={look} aria-hidden="true">
      <span className="style-mock-rail">
        <i className="style-mock-row" />
        <i className="style-mock-row style-mock-row--on" />
        <i className="style-mock-row" />
      </span>
      <span className="style-mock-page">
        <i className="style-mock-line" />
        <i className="style-mock-line style-mock-line--short" />
        <i className="style-mock-composer" />
      </span>
    </span>
  );
}

/**
 * THE PROMPT BOX PICKER — which composer the chat draws, under the style.
 *
 * The style picker's contract again: one value for the install, applied on the
 * press so the composer under the dialog changes while you look at it, stored
 * server-side and pushed to every window, undone if the write fails. You pick
 * one by USING it, so the change has to be live.
 */
export function ComposerPicker({ chosen }: { chosen: ComposerDesign }) {
  const [failed, setFailed] = useState(false);
  const pick = (value: ComposerDesign) => {
    const before = getServerComposer();
    setFailed(false);
    setServerComposer(value);
    void api.setPref('composer', value).catch((err) => {
      console.error('could not store the prompt box', err);
      setServerComposer(before);
      setFailed(true);
    });
  };
  return (
    <fieldset className="settings-row settings-themes settings-composers">
      <legend>Prompt box</legend>
      <div className="theme-grid style-grid">
        {COMPOSERS.map((c) => (
          <label
            key={c.value}
            className="theme-tile"
            data-chosen={c.value === chosen}
            title={c.hint}
          >
            <input
              type="radio"
              name="composer"
              value={c.value}
              checked={c.value === chosen}
              onChange={() => pick(c.value)}
            />
            <span className="theme-tile-preview">
              <ComposerMock design={c.value} />
            </span>
            <span className="theme-tile-name">{c.label}</span>
          </label>
        ))}
      </div>
      {failed ? (
        <p className="settings-note" role="alert">
          Couldn’t save the prompt box. The server may be running a build from before it existed —
          restart muxpad and try again.
        </p>
      ) : null}
    </fieldset>
  );
}

/** The bottom of a chat in miniature: two lines of log and the prompt box,
 *  drawn the way each design builds it. */
function ComposerMock({ design }: { design: ComposerDesign }) {
  return (
    <span className="composer-mock" data-design={design} aria-hidden="true">
      <i className="style-mock-line" />
      <i className="style-mock-line style-mock-line--short" />
      <span className="composer-mock-box">
        <i className="composer-mock-plus" />
        <i className="composer-mock-field" />
        <i className="composer-mock-send" />
        <span className="composer-mock-row">
          <i />
          <i />
          <i />
        </span>
      </span>
      <i className="composer-mock-meta" />
    </span>
  );
}

/**
 * PUSH NOTIFICATIONS, as a section rather than a row.
 *
 * Web Push needs https and, on iOS, the installed PWA; where those do not
 * hold this says why instead of offering a button that cannot work. Enable
 * must run inside the click handler — iOS auto-denies a permission prompt
 * that does not come from a gesture.
 *
 * It was one row at the foot of General, under the theme grid, where its lone
 * Enable button read as an action on the tiles above it. With a section of
 * its own there is room to say what the thing actually does, which a row
 * never had: a reader deciding whether to grant a permission is the one
 * reader in this dialog who needs a sentence.
 */
function PushSection() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPushState().then(setState);
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      setState(state === 'enabled' ? await disablePush() : await enablePush());
    } catch (err) {
      console.error('push toggle failed', err);
      setState(await getPushState());
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 className="settings-heading">Notifications</h3>
      <p className="settings-blurb">
        A push on your phone and your desktop when a chat needs you — a question, a finished run, a
        watch you asked for. Nothing routine: a turn that ends while you are looking at it sends
        nothing.
      </p>
      {state === 'unsupported' ? (
        <p className="settings-note">
          Not available here — web push needs https, and on iOS it needs muxpad added to the home
          screen.
        </p>
      ) : state === 'denied' ? (
        <p className="settings-note">
          Blocked in your browser settings for this site. Allow notifications there and reopen this
          dialog.
        </p>
      ) : (
        <div className="settings-push-actions">
          <button
            id="push-toggle"
            type="button"
            disabled={busy || state === 'loading'}
            onClick={() => void toggle()}
          >
            {state === 'enabled' ? 'Disable notifications' : 'Enable notifications'}
          </button>
          {state === 'enabled' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendTestPush().catch((err) => console.error(err))}
            >
              Send a test
            </button>
          )}
        </div>
      )}
    </>
  );
}

function SvgGear() {
  // Lucide-style gear — clean, geometric, eight teeth.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
