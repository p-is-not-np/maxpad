/**
 * A chat's TUNING — the three dials a person may set on a session besides its
 * mode: which model, how hard it reasons, and (Codex only) fast mode.
 *
 * One definition for the whole pipeline (CLI → API → startup_cmd → runner →
 * status frame → picker), because each hop validates against it and a level
 * one hop accepts and the next refuses is a dial that silently does nothing.
 *
 * WHAT EACH HARNESS ACTUALLY TAKES, read off the installed tools rather than
 * remembered:
 *
 *   claude  effort  low | medium | high | xhigh | max
 *                   SDK `Options.effort` at launch, `applyFlagSettings(
 *                   { effortLevel })` on a live session. Per-model support is
 *                   reported by `supportedModels()` (`supportedEffortLevels`).
 *           fast    not offered here (Claude's own fast mode is a different
 *                   product decision; the picker is asked for Codex only).
 *   codex   effort  `-c model_reasoning_effort="<level>"`. The CLI accepts
 *                   minimal…ultra; each model lists its own subset in
 *                   `models_cache.json` (`supported_reasoning_levels`).
 *           fast    `-c service_tier="priority"` — the catalog's service tier
 *                   whose name is "Fast". OFF is `service_tier="default"`,
 *                   which has to be explicit because a user's config.toml may
 *                   already set priority.
 *   cursor  neither. `cursor-agent` has no effort or tier flag.
 *
 * Every value here ends up in a shell-typed startup command, which is why the
 * levels are a closed allowlist and fast is a boolean, never free text.
 */

import { coerceAgentMode } from './types.js';

export type TuningBackend = 'claude' | 'codex' | 'cursor';

/** Every effort word any backend accepts — the shape check for the wire. */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What each backend accepts, before a model narrows it further. */
export const BACKEND_EFFORTS: Readonly<Record<TuningBackend, readonly EffortLevel[]>> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  cursor: [],
};

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** Does `backend` take this effort word at all? */
export function backendSupportsEffort(backend: TuningBackend, effort: string): boolean {
  return (BACKEND_EFFORTS[backend] as readonly string[]).includes(effort);
}

/** Only Codex has a fast tier the picker offers. */
export function backendSupportsFast(backend: TuningBackend): boolean {
  return backend === 'codex';
}

/**
 * A pane's pinned tuning. `null` everywhere means "not pinned — the harness's
 * own default", which is NOT the same as any particular level: a Codex user's
 * config.toml may already say `service_tier = "priority"`, and an unpinned
 * pane must keep meaning exactly that.
 */
export interface AgentTuning {
  model: string | null;
  effort: EffortLevel | null;
  fast: boolean | null;
}

export const NO_TUNING: AgentTuning = { model: null, effort: null, fast: null };

/** Short label for a level, for a chip at phone width. */
export const EFFORT_LABELS: Readonly<Record<EffortLevel, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultra: 'Ultra',
};

// ── The startup command ────────────────────────────────────────────────────
//
// A pane's tuning lives in its STARTUP COMMAND, the same place the model pin
// always lived: `muxpad agent --model 'x' --effort high --fast on`. That is the
// one record that survives every respawn, resume and reboot without a schema
// change, and the runner already parses it. The web reads it back from the
// pane row (pane.startup_cmd) to draw the picker before any session exists.
//
// The cost is that several writers compose that command, and the server's
// self-heal compares the stored command to the one it would write to tell a
// reconnect from a new runner — so the flag ORDER is load-bearing. Every
// writer therefore goes through `tuningFlags`, and nothing hand-builds the
// tuning part of a command.

/**
 * A model id that is safe to put in a shell-typed startup command. Ids like
 * 'claude-opus-4-8[1m]' pass; quotes, spaces, `$` and backticks cannot. The
 * leading-dash refusal matters: `--dangerously-skip-permissions` passes the
 * charset and would reach the runner as the model VALUE.
 */
export function isSafeModelId(m: string): boolean {
  return /^[A-Za-z0-9._[\]-]{1,64}$/.test(m) && !m.startsWith('-');
}

/** Read the pinned tuning back out of a startup command. Never throws. */
export function tuningFromStartupCmd(cmd: string | null | undefined): AgentTuning {
  if (!cmd?.startsWith('muxpad agent')) return { ...NO_TUNING };
  const model = cmd.match(/\s--model[\s=]('[^']*'|[^\s']+)/)?.[1]?.replace(/^'|'$/g, '') ?? null;
  const effort = cmd.match(/\s--effort[\s=](\S+)/)?.[1];
  const fast = cmd.match(/\s--fast[\s=](on|off)\b/)?.[1];
  return {
    model: model && isSafeModelId(model) ? model : null,
    effort: isEffortLevel(effort) ? effort : null,
    fast: fast === 'on' ? true : fast === 'off' ? false : null,
  };
}

/**
 * The tuning part of a startup command, in its ONE canonical order. Model is
 * single-quoted so zsh's nomatch cannot glob-error on ids with brackets.
 */
export function tuningFlags(t: Partial<AgentTuning>): string {
  const model = t.model && isSafeModelId(t.model) ? ` --model '${t.model}'` : '';
  const effort = t.effort && isEffortLevel(t.effort) ? ` --effort ${t.effort}` : '';
  const fast = t.fast === true ? ' --fast on' : t.fast === false ? ' --fast off' : '';
  return `${model}${effort}${fast}`;
}

/**
 * Rewrite a startup command with `patch` applied to its tuning. Keys absent
 * from `patch` keep their current value; `null` unpins. Rebuilt in canonical
 * order — the same shape agentStartupCmd and the self-heal write — so the next
 * hello reads as a reconnect, not a new runner.
 *
 * Returns the command untouched when it is not a runnable agent command: a
 * pending `--pick` pane is compared verbatim in several places and has no
 * session to tune yet.
 */
export function withTuning(cmd: string | null, patch: Partial<AgentTuning>): string | null {
  if (!cmd?.startsWith('muxpad agent')) return cmd;
  if (/(^|\s)--pick(\s|$)/.test(cmd)) return cmd;
  const backend = cmd.match(/\s--backend[\s=](claude|codex|cursor)\b/)?.[1];
  const mode = coerceAgentMode(cmd.match(/\s--mode[\s=](\S+)/)?.[1]);
  const resume = cmd.match(/\s--resume[\s=](\S+)/)?.[1];
  const next: AgentTuning = { ...tuningFromStartupCmd(cmd), ...patch };
  return `muxpad agent${backend && backend !== 'claude' ? ` --backend ${backend}` : ''}${
    mode === 'chat' ? ' --mode chat' : ''
  }${tuningFlags(next)}${resume ? ` --resume ${resume}` : ''}`;
}

/**
 * Why `backend` cannot take this tuning, or null when it can. A dial the
 * harness would ignore is refused rather than stored: a pane that SAYS fast is
 * on while Cursor runs at its one speed is a lie the picker would then repeat.
 */
export function tuningRefusal(
  backend: string | undefined,
  t: { effort?: string | null | undefined; fast?: boolean | null | undefined },
): string | null {
  const b = backend === 'codex' || backend === 'cursor' ? backend : 'claude';
  if (t.effort != null && !backendSupportsEffort(b, t.effort)) {
    const ok = BACKEND_EFFORTS[b];
    return ok.length === 0
      ? `${b} has no reasoning-effort setting`
      : `${b} effort must be one of ${ok.join('|')}`;
  }
  if (t.fast != null && !backendSupportsFast(b)) return `fast mode is Codex-only (this is ${b})`;
  return null;
}

/** `on` / `off` → boolean, anything else → undefined (not a fast value). */
export function parseFastWord(v: string | undefined): boolean | undefined {
  return v === 'on' ? true : v === 'off' ? false : undefined;
}
