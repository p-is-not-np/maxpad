import { useEffect, useState } from 'react';

export type Theme =
  | 'tokyo-night'
  | 'dracula'
  | 'alucard'
  | 'github-light'
  | 'acme'
  | 'acme-dark'
  | 'demoscene'
  | 'blueprint'
  | 'riso'
  | 'memphis';

/** What the picker offers: a theme, or "whatever the OS is doing". */
export type ThemeChoice = Theme | 'system';

/**
 * The pair "System" resolves to. Fixed rather than configurable: two extra
 * pickers to express a preference almost nobody holds is a worse trade than
 * one obvious entry in one list, and Dracula is the only theme here that has a
 * real light counterpart built to match it.
 */
export const SYSTEM_PAIR = { light: 'alucard', dark: 'dracula' } as const;

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'tokyo-night', label: 'Tokyo Night' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'alucard', label: 'Alucard' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'acme', label: 'Acme' },
  { value: 'acme-dark', label: 'Acme Dark' },
  { value: 'demoscene', label: 'Demoscene' },
  { value: 'blueprint', label: 'Blueprint' },
  { value: 'riso', label: 'Riso' },
  { value: 'memphis', label: 'Memphis' },
];

const VALID_THEMES = new Set<Theme>(THEMES.map((t) => t.value));

/**
 * The picker's options: System first, because it is the recommended default.
 *
 * The labels are SHORT — "Alucard", not "Alucard (Dracula Light)"; "System",
 * not "System (Dracula / Alucard)". They were long because a <select> had to
 * say in words what a theme looks like. The picker now paints each one, and
 * System's tile is literally the two halves cut on the diagonal, so the
 * parenthetical was describing the thing directly above it — and was the only
 * reason two of the tiles ellipsised their own names.
 */
export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  ...THEMES,
];

/** The media query the OS answers. One string, so the listener and the read
 *  can never drift apart. */
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * The theme actually painted, given the choice and what the OS reports.
 * Pure, so the resolution rule is testable without a DOM.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice !== 'system') return choice;
  return prefersDark ? SYSTEM_PAIR.dark : SYSTEM_PAIR.light;
}

// Old theme ids that no longer exist — migrate to the closest replacement.
const THEME_ALIASES: Record<string, Theme> = {
  dark: 'tokyo-night',
  'one-dark': 'tokyo-night',
  'soft-dark': 'tokyo-night',
  nord: 'tokyo-night',
  light: 'github-light',
  // Thrown out, not renamed — but anyone sitting on it gets the loud light
  // theme that replaced it rather than a silent reset to the default.
  thermal: 'riso',
  hazard: 'memphis',
  abyss: 'dracula',
  'solarized-light': 'github-light',
  'solarized-dark': 'tokyo-night',
  latte: 'github-light',
};

/**
 * THE STYLE — how the chrome is BUILT, independent of what colour it is.
 *
 * A theme is a palette (and, since demoscene, a typeface). A style is the
 * structure that palette is poured into: whether the rail is its own surface
 * or the page's, whether the composer floats, whether the rail and the content
 * are cards on a canvas. The two are orthogonal, so they are two settings and
 * two root attributes — `data-theme` and `data-style` — and every style rule
 * in the stylesheets is scoped under `:where([data-style="…"])` so Default is
 * exactly the stylesheet with no style rules at all.
 */
export type UiStyle = 'default' | 'minimal' | 'floating' | 'combo';

export const STYLES: { value: UiStyle; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'floating', label: 'Floating' },
  { value: 'combo', label: 'Minimal + Floating' },
];

const VALID_STYLES = new Set<UiStyle>(STYLES.map((s) => s.value));

/** A stored style, or null for anything this build does not know — the same
 *  "an unknown name is nothing chosen" rule the theme follows. */
export function readStyle(raw: unknown): UiStyle | null {
  return typeof raw === 'string' && VALID_STYLES.has(raw as UiStyle) ? (raw as UiStyle) : null;
}

/**
 * THE PROMPT BOX — which composer design the chat pane draws.
 *
 * A third look setting beside theme and style, narrower than both: it changes
 * only the composer, so it can be tried against any palette and any chrome.
 * It lands as `data-composer` on `<html>`; every rule for an option is scoped
 * under `:where([data-composer="…"])`, so Default is the stylesheet with none
 * of them. Where an option moves controls (A's icon row, B's `+` bar, C's
 * pill) ChatPane asks `composerInForce` and places them — the same actions,
 * reachable in every option.
 */
export type ComposerDesign = 'default' | 'a' | 'b' | 'c';

export const COMPOSERS: { value: ComposerDesign; label: string; hint: string }[] = [
  { value: 'default', label: 'Default', hint: 'The current composer' },
  { value: 'a', label: 'A · Box', hint: 'One rounded box, an icon row and a round send' },
  { value: 'b', label: 'B · Bar', hint: 'A slim bar, every command behind +' },
  { value: 'c', label: 'C · Pill', hint: 'A floating blurred pill' },
];

const VALID_COMPOSERS = new Set<ComposerDesign>(COMPOSERS.map((c) => c.value));

/** A stored prompt box, or null for anything this build does not know. */
export function readComposer(raw: unknown): ComposerDesign | null {
  return typeof raw === 'string' && VALID_COMPOSERS.has(raw as ComposerDesign)
    ? (raw as ComposerDesign)
    : null;
}

export interface Settings {
  theme: ThemeChoice;
  /** This browser's style — the fallback when the install has none stored,
   *  exactly as `theme` is. */
  style: UiStyle;
  /** This browser's prompt box — the fallback, exactly as `style` is. */
  composer: ComposerDesign;
  // Persisted width of the desktop sidebar. The upper bound is enforced live
  // while dragging (never wider than the longest tab name + its status/close
  // icon needs); this stored value is only sanity-clamped on read.
  //
  // The DEFAULT is 280, raised from 240 when the rail gained a second line and
  // a meta column. Measured on the worst-case row (one carrying a schedule):
  // icon 30 + meta 79 + rail 30 leaves the name 74px at 240px, and a
  // 14-character name needs 96px in the nav font — which is why "Reading List"
  // rendered as "Reading …". At 280 the same row gives the name 114px, and a
  // row without a schedule gets 193px. Still narrower than the 330px rail the
  // design was approved against. Users who dragged their own width keep it;
  // this only moves the starting point.
  sidebarWidth: number;
}

// Hard floor/ceiling for the stored sidebar width. The *useful* max while
// dragging is computed from content; these just keep a corrupt localStorage
// value from producing an unusable rail.
export const SIDENAV_MIN_WIDTH = 160;
export const SIDENAV_MAX_WIDTH = 640;

const DEFAULTS: Settings = {
  // System by default: it is the option most people want, and it is the one
  // pair in this list built to be flipped between.
  theme: 'system',
  style: 'default',
  composer: 'default',
  sidebarWidth: 280,
};

const KEY = 'muxpad.settings.v1';
const LEGACY_KEY = 'webagents.settings.v1';

/**
 * Resolve the stored theme choice, migrating the two shapes that came before.
 *
 * The system preference briefly shipped as a `followSystem` flag plus a chosen
 * theme per side. That is gone — it was two extra controls for a preference
 * almost nobody holds — so an install carrying the flag becomes plain
 * 'system', and its per-side picks are dropped rather than honoured: keeping
 * them would mean keeping the machinery that read them.
 */
function readChoice(parsed: Partial<Settings> & { followSystem?: unknown }): ThemeChoice {
  if (parsed.followSystem === true) return 'system';
  const raw = parsed.theme;
  if (raw === 'system') return 'system';
  if (typeof raw !== 'string') return DEFAULTS.theme;
  if (VALID_THEMES.has(raw as Theme)) return raw as Theme;
  if (raw in THEME_ALIASES) return THEME_ALIASES[raw] as Theme;
  // Unknown id — the default, which is 'system'.
  return DEFAULTS.theme;
}

function read(): Settings {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      // One-time migration from the pre-rename key. Copy then clear so old
      // installs don't fight a future schema bump.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(KEY, legacy);
        localStorage.removeItem(LEGACY_KEY);
        raw = legacy;
      }
    }
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      theme: readChoice(parsed),
      style: readStyle(parsed.style) ?? DEFAULTS.style,
      composer: readComposer(parsed.composer) ?? DEFAULTS.composer,
      sidebarWidth:
        typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
          ? Math.min(SIDENAV_MAX_WIDTH, Math.max(SIDENAV_MIN_WIDTH, parsed.sidebarWidth))
          : DEFAULTS.sidebarWidth,
    };
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<(s: Settings) => void>();

let current: Settings = typeof window === 'undefined' ? DEFAULTS : read();

/**
 * ── THE INSTALL'S THEME OVERRIDES THIS BROWSER'S ───────────────────────────
 *
 * A theme was one fact (this browser), then two (this browser, and the CHAT
 * you were standing in). It is one again, and it is not this one: the install
 * owns it, server-side, pushed to every open window — see lib/app-theme.
 *
 * `settings.theme` survives as the fallback for a server that has no value
 * stored, and as the thing a brand-new install starts from. `null` here means
 * "the install has not chosen", and the local default shows through.
 *
 * It lives in this module rather than in a React store because the theme is a
 * DOCUMENT-level fact: the `data-theme` attribute is on `<html>`, the OS
 * dark-mode listener below already writes it, and the terminal reads its
 * palette out of the cascade. A second owner would be a second answer to
 * "what theme is it right now".
 */
let serverTheme: ThemeChoice | null = null;

/**
 * The theme ACTUALLY IN FORCE — the install's if it has one, else this
 * browser's.
 *
 * Exported because the PICKER has to ask the same question the painter does.
 * It once read `settings.theme` while a pick wrote somewhere else, so the two
 * disagreed by construction: the window repainted and the selection ring
 * stayed put. Every theme looked unselectable ("memphis is not selectable").
 */
export function themeInForce(s: Settings): ThemeChoice {
  return serverTheme ?? s.theme;
}

/** The install's style, or null when none is stored — the twin of
 *  `serverTheme`, and for the same reasons. */
let serverStyle: UiStyle | null = null;

/** The style ACTUALLY IN FORCE — the install's if it has one, else this
 *  browser's. The picker asks this, for the reason `themeInForce` exists. */
export function styleInForce(s: Settings): UiStyle {
  return serverStyle ?? s.style;
}

/** The install's prompt box, or null when none is stored — the style's twin. */
let serverComposer: ComposerDesign | null = null;

/** The prompt box ACTUALLY IN FORCE — the install's if it has one, else this
 *  browser's. The picker and ChatPane both ask this. */
export function composerInForce(s: Settings): ComposerDesign {
  return serverComposer ?? s.composer;
}

function applyToDocument(s: Settings) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolveTheme(themeInForce(s), systemPrefersDark());
  document.documentElement.dataset.style = styleInForce(s);
  document.documentElement.dataset.composer = composerInForce(s);
}

/**
 * Point the document at the INSTALL's theme, or `null` for none stored.
 *
 * Called from the boot payload, from a `prefs.updated` push, and optimistically
 * by the picker. A no-op when nothing changes: a push arrives in every window
 * including the one that made the change, and a repaint of every themed
 * surface (the terminal rebuilds its palette) is not free.
 */
export function setServerTheme(choice: ThemeChoice | null): void {
  if (serverTheme === choice) return;
  serverTheme = choice;
  applyToDocument(current);
  for (const fn of listeners) fn({ ...current });
}

/** The install's theme, or null when nothing is stored for it. */
export function getServerTheme(): ThemeChoice | null {
  return serverTheme;
}

/** Point the document at the INSTALL's style, or `null` for none stored. Same
 *  callers and the same no-op rule as {@link setServerTheme}. */
export function setServerStyle(choice: UiStyle | null): void {
  if (serverStyle === choice) return;
  serverStyle = choice;
  applyToDocument(current);
  for (const fn of listeners) fn({ ...current });
}

/** The install's style, or null when nothing is stored for it. */
export function getServerStyle(): UiStyle | null {
  return serverStyle;
}

/** Point the document at the INSTALL's prompt box, or `null` for none stored.
 *  Same callers and the same no-op rule as {@link setServerStyle}. */
export function setServerComposer(choice: ComposerDesign | null): void {
  if (serverComposer === choice) return;
  serverComposer = choice;
  applyToDocument(current);
  for (const fn of listeners) fn({ ...current });
}

/** The install's prompt box, or null when nothing is stored for it. */
export function getServerComposer(): ComposerDesign | null {
  return serverComposer;
}

/**
 * Repaint when the OS flips, without a reload. Registered once at module load
 * rather than per-component: the theme is a document-level fact, and a
 * component-scoped listener would stop working the moment that component
 * unmounted (the settings popover is mounted only while open).
 *
 * Listeners are notified too, so anything reading `useSettings` re-renders —
 * XtermPane rebuilds its terminal palette from the resolved theme.
 */
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia(DARK_QUERY);
  const onFlip = () => {
    // `themeInForce`, not `current.theme`: when the install has chosen
    // 'system' this browser's own default is irrelevant, and when it has
    // chosen a named theme an OS flip must not repaint anything.
    if (themeInForce(current) !== 'system') return;
    applyToDocument(current);
    for (const fn of listeners) fn({ ...current });
  };
  if (mq.addEventListener) mq.addEventListener('change', onFlip);
  else mq.addListener?.(onFlip); // Safari < 14
}

if (typeof window !== 'undefined') {
  applyToDocument(current);
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
  applyToDocument(current);
  for (const fn of listeners) fn(current);
}

/**
 * The terminal font. Not a setting.
 *
 * It was a five-way picker backed by three self-hosted webfont families —
 * ~25 KB of render-blocking CSS (36 faces x unicode-range) lazily imported,
 * plus a document.fonts round trip that terminal startup had to await before
 * xterm could measure a cell, or it would measure Menlo and re-measure
 * (garbled) when the real font swapped in. Menlo is a system font on every
 * platform muxpad runs on, so choosing it removes the chunk, the await and
 * the re-measure entirely.
 */
export const TERMINAL_FONT = 'Menlo, Monaco, monospace';

/**
 * …unless the THEME says otherwise.
 *
 * Fonts became a theme's business with the demoscene theme (styles.css): a
 * look built out of a typeface and hard edges cannot be expressed as a
 * palette. `--term-font` is the terminal's share of that, and it is read from
 * the cascade rather than passed down, for the same reason the palette is —
 * the theme is a document-level fact, and the terminal is rebuilt whenever it
 * changes.
 *
 * Falls back to {@link TERMINAL_FONT} whenever the variable is missing or
 * empty, which keeps the no-webfont, no-re-measure contract intact for every
 * theme that does not care.
 */
export function resolvedTerminalFont(): string {
  if (typeof window === 'undefined' || !document?.documentElement) return TERMINAL_FONT;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--term-font').trim();
  return v || TERMINAL_FONT;
}

export function useResolvedTheme(): Theme {
  const s = useSettings();
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(DARK_QUERY);
    const onFlip = () => setPrefersDark(mq.matches);
    onFlip(); // the OS may have flipped between first render and this effect
    if (mq.addEventListener) {
      mq.addEventListener('change', onFlip);
      return () => mq.removeEventListener('change', onFlip);
    }
    mq.addListener?.(onFlip);
    return () => mq.removeListener?.(onFlip);
  }, []);
  return resolveTheme(themeInForce(s), prefersDark);
}

export function useSettings(): Settings {
  const [state, setState] = useState<Settings>(current);
  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
