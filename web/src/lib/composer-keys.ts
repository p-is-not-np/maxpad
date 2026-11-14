/**
 * THE COMPOSER'S KEYS — queue, or interrupt and send now.
 *
 * While a turn runs, Enter QUEUES the draft (unchanged, and the safe default:
 * nothing is lost and nothing is cut off). Cmd+Enter on a Mac, Ctrl+Enter
 * elsewhere, INTERRUPTS: the server stops the running turn and runs this
 * message next, ahead of anything already queued (ws.ts `interruptSend`).
 * Idle, both just send — there is nothing to interrupt.
 *
 * Kept pure and out of ChatPane so the decision and the words that describe it
 * are tested together: a hint naming a chord the handler ignores is worse than
 * no hint.
 */
import { isMacPlatform } from './command-palette';

export type ComposerKeyAction = 'send' | 'queue' | 'interrupt' | null;

export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/**
 * What a keydown in the composer asks for.
 *
 * `mobile`: a phone's Return is a newline and its send is the button, so no
 * key sends there. `busy`: a turn is running (and no question card is up —
 * the caller folds that in, since Enter answers a question).
 *
 * Either modifier interrupts on either platform: the labels name the native
 * one, but a Mac user reaching for Ctrl+Enter out of habit should not be
 * answered with a queued message they meant to send now.
 */
export function composerKeyAction(
  e: ComposerKey,
  { mobile, busy }: { mobile: boolean; busy: boolean },
): ComposerKeyAction {
  if (e.key !== 'Enter' || e.shiftKey || mobile) return null;
  if (!busy) return 'send';
  return e.metaKey || e.ctrlKey ? 'interrupt' : 'queue';
}

/** The interrupt chord's modifier as a hint shows it: ⌘ on a Mac, `Ctrl+`
 *  everywhere else (a bare `Ctrl↵` reads as one word). */
export function interruptModLabel(mac: boolean = isMacPlatform()): string {
  return mac ? '⌘' : 'Ctrl+';
}

/**
 * The composer's placeholder, for every prompt box option.
 *
 * D carries the keys in the placeholder, as the Claude app does. The others
 * keep "Message …" and add the two chords only while a turn is running, which
 * is the one moment Enter does something other than send. Touch never names a
 * key: there is none, and the interrupt lives on a long-press and in the `+`.
 */
export function composerPlaceholder({
  question,
  composer,
  touch,
  busy,
  target,
  mac = isMacPlatform(),
}: {
  question: boolean;
  composer: string;
  touch: boolean;
  busy: boolean;
  /** Who a message goes to — "Chat", "Claude", "Codex"… */
  target: string;
  mac?: boolean;
}): string {
  if (question) return 'Type an answer, or tap an option…';
  const mod = interruptModLabel(mac);
  if (composer === 'd' && !touch) {
    return busy ? `↵ to queue, ${mod}↵ to interrupt` : '↵ to send, ⇧↵ for new line';
  }
  if (busy && !touch) return `Message ${target}… ↵ queues, ${mod}↵ interrupts`;
  return `Message ${target}…`;
}
