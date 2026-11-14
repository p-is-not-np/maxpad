import { describe, expect, it } from 'vitest';
import { readModelCatalog, recordModelCatalog } from './agent-model-catalog.js';
import { GlobalsStore } from './store/GlobalsStore.js';
import { openDb } from './store/db.js';

describe('agent model catalog', () => {
  const db = () => openDb(':memory:');

  it('remembers what a backend reported, per backend', () => {
    const d = db();
    recordModelCatalog(d, 'cursor', [{ value: 'opus', displayName: 'Opus' }]);
    recordModelCatalog(d, 'codex', [{ value: 'gpt-5-codex', displayName: 'GPT-5 Codex' }]);
    expect(readModelCatalog(d)).toEqual({
      cursor: [{ value: 'opus', displayName: 'Opus' }],
      codex: [{ value: 'gpt-5-codex', displayName: 'GPT-5 Codex' }],
    });
  });

  it('keeps resolvedModel when the runner sends one', () => {
    const d = db();
    recordModelCatalog(d, 'claude', [
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' },
    ]);
    expect(readModelCatalog(d).claude?.[0]?.resolvedModel).toBe('claude-opus-5-5');
  });

  it('an EMPTY list does not erase what we knew', () => {
    // A failed supportedModels() reports []. Forgetting the real list because
    // one fetch failed would empty the launch picker for no reason.
    const d = db();
    recordModelCatalog(d, 'cursor', [{ value: 'opus', displayName: 'Opus' }]);
    recordModelCatalog(d, 'cursor', []);
    recordModelCatalog(d, 'cursor', undefined);
    expect(readModelCatalog(d).cursor).toHaveLength(1);
  });

  it('drops entries that are not model shapes, and never throws on junk', () => {
    const d = db();
    recordModelCatalog(d, 'cursor', [
      null,
      { displayName: 'no value' },
      { value: 'sonnet-4-5' },
      'nope',
    ]);
    // A value with no displayName falls back to the value — never blank.
    expect(readModelCatalog(d).cursor).toEqual([
      { value: 'sonnet-4-5', displayName: 'sonnet-4-5' },
    ]);
  });

  it('caps a runaway list', () => {
    const d = db();
    recordModelCatalog(
      d,
      'cursor',
      Array.from({ length: 200 }, (_, i) => ({ value: `m${i}`, displayName: `M${i}` })),
    );
    expect(readModelCatalog(d).cursor).toHaveLength(32);
  });

  it('a corrupt row reads as "we know nothing" rather than throwing', () => {
    const d = db();
    new GlobalsStore(d).set('agent_model_catalog', '{not json');
    expect(readModelCatalog(d)).toEqual({});
    // …and the next real report repairs it.
    recordModelCatalog(d, 'cursor', [{ value: 'opus', displayName: 'Opus' }]);
    expect(readModelCatalog(d).cursor).toHaveLength(1);
  });

  it('offers only the allowed Claude models, even from an older stored list', () => {
    const d = db();
    recordModelCatalog(d, 'claude', [
      { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5' },
      { value: 'haiku', displayName: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001' },
      { value: 'fable', displayName: 'Fable 5.2', resolvedModel: 'claude-fable-5-2' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    ]);
    expect(readModelCatalog(d).claude?.map((m) => m.value)).toEqual(['default', 'fable']);
  });
});
