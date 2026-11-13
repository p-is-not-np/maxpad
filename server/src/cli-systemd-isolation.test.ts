import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'muxpad',
);

/**
 * A SYSTEMD UNIT IS LAUNCHD'S KEEPALIVE UNDER ANOTHER NAME.
 *
 * On Linux the daemons run as `systemd --user` units with Restart=always and no
 * pid files. Before the CLI knew about them, `start` saw "not running" and
 * spawned a second server and ptyd to fight the units over the port and the
 * socket, and `stop` signalled nothing — or something systemd restarted.
 *
 * Ownership is the data dir, read from the unit's own environment: a systemd
 * install rarely lives at ~/.muxpad, and an isolated instance must still never
 * reach the live units. The stub below answers the four `systemctl --user show`
 * questions the CLI asks and logs every other call, so `stop` can be asserted
 * without stopping anything.
 */
function withFakeSystemd(unitDataDir: string): {
  env: NodeJS.ProcessEnv;
  home: string;
  calls: () => string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'muxpad-systemd-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const envFile = join(root, 'environment');
  writeFileSync(envFile, `NODE_ENV=production\nMUXPAD_DATA_DIR=${unitDataDir}\n`);
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const systemctl = join(bin, 'systemctl');
  writeFileSync(
    systemctl,
    `#!/bin/sh
echo "$*" >> '${log}'
[ "$1" = "--user" ] || exit 1
case "$2" in
  show)
    unit=""; for a in "$@"; do unit="$a"; done
    case "$unit" in maxpad.service|maxpad-ptyd.service) ;; *) echo not-found; exit 0 ;; esac
    case "$4" in
      LoadState) echo loaded ;;
      Environment) echo "SHELL=/bin/bash" ;;
      EnvironmentFiles) echo "${envFile} (ignore_errors=no)" ;;
      MainPID) [ "$unit" = maxpad.service ] && echo 4343 || echo 4344 ;;
    esac
    ;;
esac
exit 0
`,
  );
  chmodSync(systemctl, 0o755);
  // No launchd on this "host", whatever the real one has.
  const launchctl = join(bin, 'launchctl');
  writeFileSync(launchctl, '#!/bin/sh\nexit 1\n');
  chmodSync(launchctl, 0o755);
  return {
    home: root,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      MUXPAD_PTYD_SOCKET: '',
      MUXPAD_DATA_DIR: '',
      MUXPAD_SYSTEMD_UNIT: '',
      MUXPAD_SYSTEMD_PTYD_UNIT: '',
    },
  };
}

async function run(env: NodeJS.ProcessEnv, args: string[], dataDir: string): Promise<string> {
  const { stdout } = await execFileAsync(MUXPAD_BIN, args, {
    env: { ...env, MUXPAD_DATA_DIR: dataDir },
  });
  return stdout;
}

describe('scripts/muxpad and systemd user units', () => {
  it('finds the unit that runs this data dir', async () => {
    const data = join(tmpdir(), 'muxpad-systemd-live-data');
    const { env } = withFakeSystemd(data);
    const out = await run(env, ['status'], data);
    expect(out).toContain('owner: systemd --user (maxpad.service');
    expect(out).toContain('owner:  systemd --user (maxpad-ptyd.service');
    expect(out).toContain('4343');
    expect(out).toContain('journalctl --user -u maxpad.service');
  });

  it('says "already running" instead of spawning a rival', async () => {
    const data = join(tmpdir(), 'muxpad-systemd-live-data');
    const { env } = withFakeSystemd(data);
    const out = await run(env, ['start'], data);
    expect(out).toContain('already running (PID 4343)');
  });

  it('stops through systemctl, main only unless --all', async () => {
    const data = join(tmpdir(), 'muxpad-systemd-live-data');
    const { env, calls } = withFakeSystemd(data);
    await run(env, ['stop'], data);
    const acted = calls().filter((c) => !c.startsWith('--user show'));
    expect(acted).toEqual(['--user stop maxpad.service']);
  });

  it('never touches a unit that runs a different data dir', async () => {
    const { env, home, calls } = withFakeSystemd(join(tmpdir(), 'muxpad-systemd-live-data'));
    const dev = join(home, 'dev-instance');
    const out = await run(env, ['status'], dev);
    expect(out).not.toContain('owner:');
    expect(out).not.toContain('journalctl');
    expect(out).not.toContain('4343');
    expect(out).toContain('muxpad: not running');
    await run(env, ['stop'], dev);
    expect(calls().filter((c) => !c.startsWith('--user show'))).toEqual([]);
  });
});
