import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPOSERS } from '../settings';

/**
 * THE PROMPT BOX — one composer, drawn four ways by a setting.
 *
 * The designs are not forks of ChatPane: it asks `composerInForce` and places
 * the same pieces (the tools, the session strip, the send slot) where each
 * design wants them. What is pinned here is that no design loses an action,
 * and that Default is the composer exactly as it was — no rule of any option
 * reaches it.
 */
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

describe('the prompt box setting', () => {
  it('is read from the setting in force, not forked per design', () => {
    expect(SRC).toMatch(/const composer = composerInForce\(useSettings\(\)\);/);
    expect(COMPOSERS.map((c) => c.value)).toEqual(['default', 'a', 'b', 'c', 'd']);
  });

  it('renders the send slot exactly once in every design', () => {
    // A moves it to the end of the icon row; everywhere else it ends the field.
    expect(SRC).toMatch(
      /\{\(composer === 'a' && labelledTools\) \|\| \(barMic && micInsteadOfSend && !stopInSlot\)\s*\? null\s*: sendSlot\}/,
    );
    expect(SRC).toMatch(/\{composer === 'a' \? sendSlot : null\}/);
    // The row that carries A's slot is the one A has: labelled and not C.
    expect(SRC).toMatch(
      /\{labelledTools && composer !== 'c' \? \(\s*<div className="chat-composer-tools">\s*\{composerTools\}\s*\{sessionStrip\}\s*\{composer === 'a' \? sendSlot : null\}/,
    );
    expect(SRC.match(/\{sendSlot\}|\? sendSlot :|:\s*sendSlot\}/g)?.length).toBe(2);
  });

  it('keeps every action reachable in B, behind the `+`', () => {
    // B never labels a row, so the sheet is the idle tools on every layout —
    // and it holds attach, review, dictate and btw.
    const el = SRC.slice(SRC.indexOf('const composerTools = collapsedTools ? ('));
    const sheet = el.slice(0, el.indexOf(') : labelledTools ? ('));
    for (const item of ['Attach a file', 'Review a screen', 'Dictate', 'btw…']) {
      expect(sheet).toContain(item);
    }
    // The session: a chip in B's desktop bar, the sheet's row on touch.
    expect(SRC).toMatch(
      /\{composer === 'b' && !touchLayout \? \(\s*<div className="chat-composer-tools">\{sessionStrip\}<\/div>/,
    );
  });

  it('builds D as the Claude bar: `+` menu, mic on the bar, session under it', () => {
    // Every idle tool behind the `+`, on every layout, as in B.
    expect(SRC).toMatch(/const plusOnly = composer === 'b' \|\| composer === 'd';/);
    expect(SRC).toMatch(/const collapsedTools = toolsIdle && \(touchLayout \|\| plusOnly\);/);
    // The mic is on the bar, so the menu drops Dictate only when the bar has it.
    expect(SRC).toMatch(/voiceMic && voice\.supported && !barMic \? \(/);
    expect(SRC).toMatch(/\{barMic \? \(\s*<button[\s\S]{0,120}className="chat-mic chat-bar-mic"/);
    // The keys live in the placeholder on a desktop.
    // (composerPlaceholder; its words are pinned in lib/composer-keys.test.)
    expect(SRC).toMatch(
      /placeholder=\{composerPlaceholder\(\{[\s\S]{0,80}composer,\s*touch: touchLayout,/,
    );
    // The session: a meta row OUTSIDE the bar on a desktop, the sheet on touch.
    expect(SRC).toMatch(
      /\{composer === 'd' && !touchLayout \? \(\s*<div className="chat-composer-meta">\{sessionStrip\}<\/div>/,
    );
    expect(SRC).toMatch(
      /\{plusOnly && !touchLayout \? null : \(\s*<div className="chat-tools-session">/,
    );
    // The meta row is a sibling of the bar, not inside it.
    const bar = SRC.indexOf('className={`chat-composer${dropping');
    const meta = SRC.indexOf('<div className="chat-composer-meta">');
    expect(meta).toBeGreaterThan(bar);
    expect(SRC.slice(bar, meta)).toMatch(/<\/div>\s*\{\/\* D: the session as a quiet meta row/);
  });

  it('keeps C’s tools and session inside the pill', () => {
    expect(SRC).toMatch(
      /\{composer === 'c' && labelledTools \? \(\s*<div className="chat-composer-tools">\s*\{composerTools\}\s*\{sessionStrip\}/,
    );
  });

  it('names an icon-only tool for a screen reader, and only in A and C', () => {
    expect(SRC).toMatch(/const iconTools = composer === 'a' \|\| composer === 'c';/);
    expect(SRC).toMatch(/aria-label=\{iconTools \? 'Attach a file' : undefined\}/);
    expect(SRC).toMatch(/aria-label=\{iconTools \? 'Review a screen' : undefined\}/);
    expect(SRC).toMatch(/aria-label=\{iconTools \? 'btw…' : undefined\}/);
  });

  it('scopes every option rule under :where([data-composer]), so Default has none', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const tail = flat.slice(flat.indexOf(':where([data-composer='));
    expect(tail.length).toBeGreaterThan(1000);
    // Every selector in the options' block starts with the zero-specificity scope.
    const selectors = tail
      .split('}')
      .map((r) => r.slice(0, r.indexOf('{')).trim())
      .filter((h) => h && !h.startsWith('@'))
      .flatMap((h) => h.replace(/^@[^{]*\{/, '').split(/,\s*(?![^(]*\))/));
    for (const sel of selectors) {
      expect(sel.trim()).toMatch(/^:where\(\[data-composer="[abcd]"\]\) /);
    }
    expect(flat).not.toMatch(/data-composer="default"/);
  });
});
