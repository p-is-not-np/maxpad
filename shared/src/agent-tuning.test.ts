import { describe, expect, it } from 'vitest';
import { tuningFlags, tuningFromStartupCmd, tuningRefusal, withTuning } from './agent-tuning.js';

describe('agent tuning in the startup command', () => {
  it('reads model, effort and fast back out, in either flag spelling', () => {
    expect(
      tuningFromStartupCmd("muxpad agent --backend codex --model 'gpt-6' --effort high --fast off"),
    ).toEqual({ model: 'gpt-6', effort: 'high', fast: false });
    expect(tuningFromStartupCmd('muxpad agent --model=opus --effort=max --fast=on')).toEqual({
      model: 'opus',
      effort: 'max',
      fast: true,
    });
    expect(tuningFromStartupCmd('muxpad agent')).toEqual({
      model: null,
      effort: null,
      fast: null,
    });
    // A non-agent command has no tuning, whatever its text says.
    expect(tuningFromStartupCmd('/bin/zsh --effort high').effort).toBeNull();
  });

  it('drops words that are no effort and model ids that are not plain', () => {
    const t = tuningFromStartupCmd(
      "muxpad agent --model '--dangerous' --effort turbo --fast maybe",
    );
    expect(t).toEqual({ model: null, effort: null, fast: null });
  });

  it('writes one canonical order, so the self-heal reads a reconnect as a reconnect', () => {
    expect(tuningFlags({ fast: true, effort: 'low', model: 'claude-opus-4-8[1m]' })).toBe(
      " --model 'claude-opus-4-8[1m]' --effort low --fast on",
    );
    expect(tuningFlags({})).toBe('');
  });

  it('rewrites a resumed command in place, keeping backend, mode and session', () => {
    const cmd = "muxpad agent --backend codex --model 'gpt-6' --resume thr-1";
    expect(withTuning(cmd, { effort: 'xhigh', fast: true })).toBe(
      "muxpad agent --backend codex --model 'gpt-6' --effort xhigh --fast on --resume thr-1",
    );
    // null unpins; an absent key keeps its value.
    expect(
      withTuning("muxpad agent --mode chat --model 'opus' --effort high", { effort: null }),
    ).toBe("muxpad agent --mode chat --model 'opus'");
  });

  it('leaves a pending harness pick and a terminal untouched', () => {
    expect(withTuning('muxpad agent --pick', { effort: 'high' })).toBe('muxpad agent --pick');
    expect(withTuning('/bin/zsh', { effort: 'high' })).toBe('/bin/zsh');
    expect(withTuning(null, { effort: 'high' })).toBeNull();
  });

  it('refuses a dial the harness does not have, naming what it does take', () => {
    expect(tuningRefusal('claude', { effort: 'max' })).toBeNull();
    expect(tuningRefusal('claude', { effort: 'minimal' })).toMatch(/low\|medium/);
    expect(tuningRefusal(undefined, { fast: true })).toMatch(/Codex-only/);
    expect(tuningRefusal('codex', { effort: 'minimal', fast: false })).toBeNull();
    expect(tuningRefusal('cursor', { effort: 'low' })).toMatch(/no reasoning-effort/);
    // Unpinning is always fine.
    expect(tuningRefusal('cursor', { effort: null, fast: null })).toBeNull();
  });
});
