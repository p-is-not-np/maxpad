import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MUXPAD_SYSTEM_DIR, muxpadSystemDir, rootGroup } from './system-dir.js';

// The broker is plain .mjs outside this package's rootDir, so it is loaded the
// way origin-proof.test.ts loads it.
const require = createRequire(import.meta.url);
const broker = await import(require.resolve('../../../broker/broker-paths.mjs'));

describe('the connector config directory', () => {
  it('is where the broker looks, on this platform', () => {
    // Two programs read connectors.json; a policy only one of them sees is a
    // policy that silently does not apply.
    expect(MUXPAD_SYSTEM_DIR).toBe(broker.SYSTEM_ROOT);
  });

  it('is /etc/muxpad on Linux and /Library/muxpad on macOS', () => {
    expect(muxpadSystemDir('linux')).toBe('/etc/muxpad');
    expect(muxpadSystemDir('darwin')).toBe('/Library/muxpad');
  });

  it('names a group that exists on each platform', () => {
    expect(rootGroup('darwin')).toBe('wheel');
    expect(rootGroup('linux')).toBe('root');
  });
});
