import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * INTERRUPT & SEND NOW — the composer's wiring.
 *
 * The decision (which key does what) and the words are unit-tested in
 * lib/composer-keys; the server's ordering in agent-runner/relay.test. What is
 * left is that ChatPane routes each gesture to the ONE frame that does it
 * atomically, and a source assertion is the honest size for that (see the
 * sibling ChatPane.*.test.ts files for why these do not mount the pane).
 */
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const FLAT = SRC.replace(/\s+/g, ' ');

describe('interrupt and send now', () => {
  it('the composer keydown is decided by composerKeyAction, busy = a turn and no question', () => {
    expect(FLAT).toContain(
      'const action = composerKeyAction(e, { mobile: isMobileLayout(), busy: sending && !question, });',
    );
    expect(FLAT).toContain("if (action === 'interrupt') interruptAndSend(); else sendMessage();");
  });

  it('an interrupt is ONE `send` frame carrying `interrupt`, never stop-then-send', () => {
    expect(FLAT).toContain(
      "ws.send(JSON.stringify({ t: 'send', text: outgoing, ...(interrupt ? { interrupt } : {}) }));",
    );
    const submit = SRC.slice(SRC.indexOf('const submitDraft = '), SRC.indexOf('const stop = '));
    expect(submit).toContain('deliver(outgoing, interrupt)');
    expect(submit).not.toMatch(/t: 'stop'/);
  });

  it('a queued item’s send-now is ONE `queue-send-now` frame', () => {
    expect(FLAT).toContain("ws.send(JSON.stringify({ t: 'queue-send-now', id }));");
    expect(FLAT).toMatch(/className="chat-queued-now" onClick=\{\(\) => sendQueuedNow\(q\.id\)\}/);
  });

  it('the bolt beside Queue is desktop-only and not a second `.chat-send` circle', () => {
    const busy = SRC.slice(SRC.indexOf(') : sending && !question ? ('));
    const slot = busy.slice(0, busy.indexOf(') : micInsteadOfSend ? ('));
    expect(slot).toMatch(/\{touchLayout \? null : \(\s*<button[\s\S]*?className="chat-send-now"/);
    expect(slot).toContain('onClick={interruptAndSend}');
    expect(slot.match(/className="chat-send[ "]/g)).toHaveLength(1);
  });

  it('a phone gets it from a hold on Queue and from the `+` sheet', () => {
    expect(FLAT).toContain('const queueLongPress = useLongPress(() => interruptAndSend());');
    expect(FLAT).toContain('{...queueLongPress.handlers}');
    const sheet = SRC.slice(SRC.indexOf('<div className="chat-tools-sheet" role="menu">'));
    expect(sheet.slice(0, 900)).toMatch(
      /sending && !question && canSend \? \([\s\S]*interruptAndSend\(\);[\s\S]*Interrupt &amp; send/,
    );
  });

  it('every prompt box option takes its placeholder from composerPlaceholder', () => {
    expect(FLAT).toContain('placeholder={composerPlaceholder({');
    expect(SRC).not.toContain("'↵ to send, ⇧↵ for new line'");
  });
});
