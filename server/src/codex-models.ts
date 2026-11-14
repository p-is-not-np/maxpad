import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type EffortLevel, isEffortLevel } from '@muxpad/shared';

/**
 * Codex's own model list, read straight off disk.
 *
 * WHY THIS IS NOT THE SHARED CATALOG. `agent-model-catalog` remembers what each
 * backend last REPORTED, because a model list normally comes from a live
 * session — Claude's from `session.supportedModels()`, Cursor's from
 * `cursor-agent --list-models`. Asking those at pick time would mean spawning a
 * process just to draw a menu, so the catalog exists to avoid that.
 *
 * That reasoning does not apply to Codex. Its list is a JSON file the CLI
 * maintains at `$CODEX_HOME/models_cache.json`; reading it costs one stat and
 * one parse, with no subprocess and no session. Going through the catalog for
 * Codex bought nothing and cost the FIRST launch: on a machine where no Codex
 * pane had ever run, the picker offered only "Default" while the real list sat
 * in a file the server could have read. Observed live the day GPT-6 Astra
 * shipped — the model was present in the cache and unpickable in the UI.
 *
 * Best-effort by construction: a missing, truncated or hand-edited cache
 * degrades to an empty list (the picker then shows "Default", which is the
 * honest answer), never to a throw at the route that reads it.
 */
export interface CodexModel {
  value: string;
  displayName: string;
  /** `supported_reasoning_levels` — what the effort picker may offer. */
  efforts?: EffortLevel[];
  /** The model offers the "Fast" service tier (`service_tiers`). */
  fast?: boolean;
}

/** The service tier Codex calls "Fast". Its catalog lists it as
 *  `{ id: 'priority', name: 'Fast' }`; config takes the id. */
export const CODEX_FAST_TIER = 'priority';

/**
 * The two flags Codex itself uses to decide what a user may pick:
 *  - `visibility: 'list'` — everything else is internal plumbing. `gpt-reserve`
 *    and `codex-auto-review` are both `hide`, and offering either would be
 *    offering a model the product deliberately does not surface.
 *  - `supported_in_api !== false` — a model the CLI cannot actually be pointed
 *    at is worse than absent: it is a chip that fails at spawn time.
 */
function pickable(m: {
  slug?: string;
  visibility?: string;
  supported_in_api?: boolean;
}): boolean {
  return m.visibility === 'list' && m.supported_in_api !== false && typeof m.slug === 'string';
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Parse a models_cache.json body. Exported so tests need no filesystem. */
export function parseCodexModels(raw: string): CodexModel[] {
  try {
    const cache = JSON.parse(raw) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        visibility?: string;
        supported_in_api?: boolean;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
        service_tiers?: Array<{ id?: unknown; name?: unknown }>;
      }>;
    };
    return (cache.models ?? []).filter(pickable).map((m) => {
      const efforts = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((r) => r?.effort).filter(isEffortLevel)
        : undefined;
      const fast =
        Array.isArray(m.service_tiers) &&
        m.service_tiers.some((t) => t?.id === CODEX_FAST_TIER || t?.name === 'Fast');
      return {
        value: m.slug as string,
        displayName: m.display_name || (m.slug as string),
        ...(efforts ? { efforts } : {}),
        ...(fast ? { fast: true } : {}),
      };
    });
  } catch {
    return [];
  }
}

/** The models Codex would offer, or [] if we cannot tell. Never throws. */
export function readCodexModels(home: string = codexHome()): CodexModel[] {
  try {
    return parseCodexModels(readFileSync(join(home, 'models_cache.json'), 'utf8'));
  } catch {
    return [];
  }
}

/** The `model = "..."` line from Codex's config, or null. Never throws. */
export function readCodexDefaultModel(home: string = codexHome()): string | null {
  try {
    const match = readFileSync(join(home, 'config.toml'), 'utf8').match(
      /^\s*model\s*=\s*"([^"]+)"/m,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A TOP-LEVEL string key from Codex's config.toml (`key = "value"` before the
 * first `[table]`), or null. Not a TOML parser — the three keys read here are
 * flat strings, and a miss degrades to "unknown", never to a throw.
 */
export function readCodexConfigString(key: string, home: string = codexHome()): string | null {
  try {
    const top = readFileSync(join(home, 'config.toml'), 'utf8').split(/^\s*\[/m)[0] ?? '';
    const match = top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** What a Codex turn runs at when the pane pins nothing: the config's
 *  `model_reasoning_effort` and whether its `service_tier` is the fast one. */
export function readCodexDefaults(home: string = codexHome()): {
  effort: EffortLevel | null;
  fast: boolean;
} {
  const effort = readCodexConfigString('model_reasoning_effort', home);
  const tier = readCodexConfigString('service_tier', home);
  return {
    effort: isEffortLevel(effort) ? effort : null,
    fast: tier === CODEX_FAST_TIER || tier === 'fast',
  };
}
