import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCodexModels, readCodexDefaults, readCodexModels } from './codex-models.js';

/** Shaped like the real ~/.codex/models_cache.json, trimmed to the fields read. */
const CACHE = JSON.stringify({
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      visibility: 'list',
      supported_in_api: true,
    },
    {
      slug: 'gpt-reserve',
      display_name: 'GPT-Reserve',
      visibility: 'hide',
      supported_in_api: true,
    },
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      visibility: 'list',
      supported_in_api: true,
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      supported_in_api: true,
    },
    { slug: 'legacy-thing', display_name: 'Legacy', visibility: 'list', supported_in_api: false },
  ],
});

describe('parseCodexModels', () => {
  it('offers what Codex itself lists, and nothing it hides', () => {
    // `gpt-reserve` and `codex-auto-review` are both visibility:hide — internal
    // plumbing. Offering either would surface a model the product deliberately
    // does not.
    expect(parseCodexModels(CACHE).map((m) => m.value)).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
  });

  it('drops a model the CLI cannot be pointed at', () => {
    // Worse than absent: a chip that fails at spawn time.
    expect(parseCodexModels(CACHE).some((m) => m.value === 'legacy-thing')).toBe(false);
  });

  it('falls back to the slug when there is no display name', () => {
    const raw = JSON.stringify({ models: [{ slug: 'gpt-x', visibility: 'list' }] });
    expect(parseCodexModels(raw)).toEqual([{ value: 'gpt-x', displayName: 'gpt-x' }]);
  });

  it('treats a missing supported_in_api as supported', () => {
    // Absent means "not stated", not "no" — an older cache omits the field.
    const raw = JSON.stringify({ models: [{ slug: 'gpt-y', visibility: 'list' }] });
    expect(parseCodexModels(raw).map((m) => m.value)).toEqual(['gpt-y']);
  });

  it('degrades to an empty list rather than throwing', () => {
    // The picker then shows "Default", which is the honest answer for a
    // harness we cannot read. A throw here would take down the whole route.
    for (const raw of ['{not json', '', '{}', '{"models":null}', '[]']) {
      expect(parseCodexModels(raw)).toEqual([]);
    }
  });

  it('ignores an entry with no slug', () => {
    const raw = JSON.stringify({ models: [{ display_name: 'Nameless', visibility: 'list' }] });
    expect(parseCodexModels(raw)).toEqual([]);
  });

  it('returns [] for a home with no cache file', () => {
    expect(readCodexModels('/nonexistent/codex/home')).toEqual([]);
  });
});

describe('codex tuning facts off disk', () => {
  it("carries each model's effort levels and whether it has the Fast tier", () => {
    const [m] = parseCodexModels(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6.1-sol',
            visibility: 'list',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'ultra' },
              { effort: 'warp' },
            ],
            service_tiers: [{ id: 'priority', name: 'Fast' }],
          },
        ],
      }),
    );
    // An effort word we do not know is dropped, never offered as a button.
    expect(m).toMatchObject({ value: 'gpt-6.1-sol', efforts: ['low', 'ultra'], fast: true });
  });

  it('reads the TOP-LEVEL effort and tier from config.toml, ignoring tables', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    try {
      writeFileSync(
        join(home, 'config.toml'),
        'model = "gpt-6"\nmodel_reasoning_effort = "max"\nservice_tier = "priority"\n\n[profiles.x]\nservice_tier = "flex"\n',
      );
      expect(readCodexDefaults(home)).toEqual({ effort: 'max', fast: true });
      writeFileSync(join(home, 'config.toml'), '[profiles.x]\nmodel_reasoning_effort = "low"\n');
      expect(readCodexDefaults(home)).toEqual({ effort: null, fast: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
