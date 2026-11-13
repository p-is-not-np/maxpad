import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROKER_ROOTS, readRoutingMetadata, slackBrokerURL } from './slack-broker.js';

describe('protected broker discovery', () => {
  let dir: string;
  let root: string;
  // Not root in a test, so the trusted owner is this process's own UID.
  const me = process.getuid?.() ?? 0;
  const publish = (body: unknown = { version: 1, brokerURL: 'https://secure.tail.ts.net' }) => {
    writeFileSync(join(root, 'setup-public.json'), JSON.stringify(body));
    chmodSync(join(root, 'setup-public.json'), 0o644);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'broker-discovery-'));
    root = join(dir, 'muxpad-broker');
    mkdirSync(root, { mode: 0o755 });
    chmodSync(root, 0o755);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('uses the same per-platform roots as the broker itself', () => {
    const paths = readFileSync(new URL('../../broker/broker-paths.mjs', import.meta.url), 'utf8');
    const roots = /const ROOTS = (\{[^}]*\})/.exec(paths)?.[1];
    expect(roots).toBeTruthy();
    expect(BROKER_ROOTS).toEqual(
      Object.fromEntries([...roots!.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]])),
    );
    expect(BROKER_ROOTS.linux).toBe('/opt/muxpad-broker');
  });

  it('reads the published broker URL from a protected tree', () => {
    publish();
    expect(readRoutingMetadata(root, me)).toBe('https://secure.tail.ts.net');
  });

  it('refuses a tree or file owned by anyone else', () => {
    publish();
    expect(readRoutingMetadata(root, me + 1)).toBeNull();
  });

  it('refuses group- or world-writable metadata and roots', () => {
    publish();
    chmodSync(join(root, 'setup-public.json'), 0o664);
    expect(readRoutingMetadata(root, me)).toBeNull();
    chmodSync(join(root, 'setup-public.json'), 0o644);
    chmodSync(root, 0o757);
    expect(readRoutingMetadata(root, me)).toBeNull();
  });

  it('refuses a symlinked file or root, and a hardlinked file', () => {
    const elsewhere = join(dir, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify({ version: 1, brokerURL: 'https://evil.test' }));
    chmodSync(elsewhere, 0o644);
    symlinkSync(elsewhere, join(root, 'setup-public.json'));
    expect(readRoutingMetadata(root, me)).toBeNull();
    rmSync(join(root, 'setup-public.json'));
    linkSync(elsewhere, join(root, 'setup-public.json'));
    expect(readRoutingMetadata(root, me)).toBeNull();
    rmSync(join(root, 'setup-public.json'));
    publish();
    symlinkSync(root, join(dir, 'linked-root'));
    expect(readRoutingMetadata(join(dir, 'linked-root'), me)).toBeNull();
  });

  it('treats missing, malformed or other-version metadata as not installed', () => {
    expect(readRoutingMetadata(root, me)).toBeNull();
    writeFileSync(join(root, 'setup-public.json'), '{');
    expect(readRoutingMetadata(root, me)).toBeNull();
    publish({ version: 2, brokerURL: 'https://secure.tail.ts.net' });
    expect(readRoutingMetadata(root, me)).toBeNull();
  });

  it('the environment wins and is still validated as a bare HTTPS origin', () => {
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'https://secure.tail.ts.net/');
    expect(slackBrokerURL()).toBe('https://secure.tail.ts.net');
    vi.stubEnv('MUXPAD_SLACK_BROKER_URL', 'http://secure.tail.ts.net');
    expect(() => slackBrokerURL()).toThrow(/protected HTTPS origin/);
  });
});
