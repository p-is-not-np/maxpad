import { describe, expect, it } from 'vitest';
import { composerKeyAction, composerPlaceholder, interruptModLabel } from './composer-keys';

const key = (
  k: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>,
) => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...k,
});
const desk = { mobile: false };

describe('composer keys: queue, or interrupt and send now', () => {
  it('idle: Enter sends, and so does Cmd/Ctrl+Enter — nothing to interrupt', () => {
    expect(composerKeyAction(key({}), { ...desk, busy: false })).toBe('send');
    expect(composerKeyAction(key({ metaKey: true }), { ...desk, busy: false })).toBe('send');
    expect(composerKeyAction(key({ ctrlKey: true }), { ...desk, busy: false })).toBe('send');
  });

  it('mid-turn: plain Enter QUEUES (the safe default is unchanged)', () => {
    expect(composerKeyAction(key({}), { ...desk, busy: true })).toBe('queue');
  });

  it('mid-turn: Cmd+Enter and Ctrl+Enter INTERRUPT', () => {
    expect(composerKeyAction(key({ metaKey: true }), { ...desk, busy: true })).toBe('interrupt');
    expect(composerKeyAction(key({ ctrlKey: true }), { ...desk, busy: true })).toBe('interrupt');
  });

  it('Shift+Enter is a newline, with or without a modifier', () => {
    expect(composerKeyAction(key({ shiftKey: true }), { ...desk, busy: true })).toBeNull();
    expect(
      composerKeyAction(key({ shiftKey: true, metaKey: true }), { ...desk, busy: true }),
    ).toBeNull();
  });

  it('a phone never sends from a key — Return is a newline there', () => {
    expect(composerKeyAction(key({}), { mobile: true, busy: false })).toBeNull();
    expect(composerKeyAction(key({ metaKey: true }), { mobile: true, busy: true })).toBeNull();
  });

  it('other keys do nothing', () => {
    expect(composerKeyAction(key({ key: 'a', metaKey: true }), { ...desk, busy: true })).toBeNull();
  });
});

describe('the placeholder names the keys that actually do something', () => {
  const base = { question: false, touch: false, target: 'Claude' };

  it('D: "↵ to send" idle, "↵ to queue, ⌘↵ to interrupt" mid-turn', () => {
    expect(composerPlaceholder({ ...base, composer: 'd', busy: false, mac: true })).toBe(
      '↵ to send, ⇧↵ for new line',
    );
    expect(composerPlaceholder({ ...base, composer: 'd', busy: true, mac: true })).toBe(
      '↵ to queue, ⌘↵ to interrupt',
    );
  });

  it('says Ctrl, not ⌘, off a Mac', () => {
    expect(composerPlaceholder({ ...base, composer: 'd', busy: true, mac: false })).toBe(
      '↵ to queue, Ctrl+↵ to interrupt',
    );
    expect(interruptModLabel(false)).toBe('Ctrl+');
    expect(interruptModLabel(true)).toBe('⌘');
  });

  it('Default, A, B and C keep "Message …" and add the chords only mid-turn', () => {
    for (const composer of ['default', 'a', 'b', 'c']) {
      expect(composerPlaceholder({ ...base, composer, busy: false, mac: true })).toBe(
        'Message Claude…',
      );
      expect(composerPlaceholder({ ...base, composer, busy: true, mac: true })).toBe(
        'Message Claude… ↵ queues, ⌘↵ interrupts',
      );
      expect(composerPlaceholder({ ...base, composer, busy: true, mac: false })).toBe(
        'Message Claude… ↵ queues, Ctrl+↵ interrupts',
      );
    }
  });

  it('touch names no key in any option', () => {
    for (const composer of ['default', 'a', 'b', 'c', 'd']) {
      for (const busy of [false, true]) {
        const p = composerPlaceholder({ ...base, composer, busy, touch: true, mac: true });
        expect(p).toBe('Message Claude…');
      }
    }
  });

  it('a question card wins over everything', () => {
    expect(
      composerPlaceholder({ ...base, question: true, composer: 'd', busy: true, mac: true }),
    ).toBe('Type an answer, or tap an option…');
  });
});
