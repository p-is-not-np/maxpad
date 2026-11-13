import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The three privileged scripts share one platform block. These tests run that
// block (never a script entrypoint) against disposable unprivileged files; no
// account, service, installed state or system tool with side effects is used.
const here = new URL('.', import.meta.url).pathname;
const SCRIPTS = ['install.sh', 'install-tsnet.sh', 'update-code.sh'];
const read = (name) => readFileSync(join(here, name), 'utf8');
const BEGIN = '# BEGIN PLATFORM\n';
const END = '# END PLATFORM\n';
const blockOf = (src) => src.slice(src.indexOf(BEGIN), src.indexOf(END) + END.length);
const block = blockOf(read('update-code.sh'));
const supported = process.platform === 'darwin' || process.platform === 'linux';

/** Run bash with the platform block loaded; `$1…` are `args`. */
function shell(body, args = []) {
  return spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', `set -euo pipefail\n${block}\n${body}`, 'bash', ...args],
    { encoding: 'utf8' },
  );
}

test('every privileged script carries the identical platform block', () => {
  assert.ok(block.length > 1000, 'platform block not found');
  for (const name of SCRIPTS) assert.equal(blockOf(read(name)), block, `${name} has drifted`);
});

test('outside the block, no script uses a macOS-only tool unguarded', () => {
  for (const name of SCRIPTS) {
    const src = read(name);
    const rest = src.replace(blockOf(src), '');
    const code = rest
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    for (const bad of [
      /\/usr\/bin\/stat -f/,
      /\bdscl\b/,
      /\bditto\b/,
      /\botool\b/,
      /\bshasum\b/,
      /chmod -R?N/,
      /\/usr\/sbin\/chown/,
      /\blaunchctl\b/,
      /\/Library\//,
      /-g wheel|root:wheel|-g staff|:staff/,
    ])
      assert.doesNotMatch(code, bad, `${name} uses ${bad} outside the platform block`);
    // lockf exists only on macOS; it may appear only inside a darwin branch.
    for (const m of code.matchAll(/^.*\blockf\b.*$/gm)) {
      const before = code.slice(0, m.index).trimEnd().split('\n').at(-1);
      assert.match(before, /if \[\[ \$OS == darwin \]\]; then/, `${name}: unguarded lockf`);
    }
  }
});

test(
  'the block names the protected tree broker-paths.mjs and main.mjs use',
  { skip: !supported },
  async () => {
    const { BROKER_ROOT } = await import('./broker-paths.mjs');
    const r = shell('printf "%s\\n" "$OS" "$DEST" "$ACCOUNT" "$SERVICE_FILE"');
    assert.equal(r.status, 0, r.stderr);
    const [os, dest, account, unit] = r.stdout.trim().split('\n');
    assert.equal(os, process.platform);
    assert.equal(dest, BROKER_ROOT);
    if (os === 'linux') {
      assert.equal(account, 'muxbroker');
      assert.equal(unit, '/etc/systemd/system/muxpad-broker.service');
    } else {
      assert.equal(account, '_muxbroker');
      assert.equal(unit, '/Library/LaunchDaemons/org.muxpad.broker.plist');
    }
  },
);

test('stat, link count and digest helpers agree with node', { skip: !supported }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-platform-'));
  try {
    const file = join(dir, 'f');
    writeFileSync(file, 'payload');
    chmodSync(file, 0o640);
    linkSync(file, join(dir, 'g'));
    const r = shell('file_owner "$1"; file_mode "$1"; link_count "$1"; sha256 "$1"', [file]);
    assert.equal(r.status, 0, r.stderr);
    const [owner, mode, links, digest] = r.stdout.trim().split('\n');
    const st = lstatSync(file);
    assert.equal(Number(owner), st.uid);
    assert.equal(Number.parseInt(mode, 8), st.mode & 0o7777);
    assert.equal(Number(links), 2);
    // The same "HASH  PATH" shape on both platforms, so update-code.sh pins
    // the same release digest whichever tool computed it.
    assert.equal(digest, `${createHash('sha256').update('payload').digest('hex')}  ${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copy_tree completes an interrupted copy instead of nesting it', { skip: !supported }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'broker-platform-'));
  try {
    mkdirSync(join(dir, 'code/sub'), { recursive: true });
    writeFileSync(join(dir, 'code/a'), 'a');
    writeFileSync(join(dir, 'code/sub/b'), 'b');
    mkdirSync(join(dir, 'code.next'));
    writeFileSync(join(dir, 'code.next/a'), 'partial');
    const r = shell('copy_tree "$1/code" "$1/code.next"; copy_tree "$1/code" "$1/code.previous"', [
      dir,
    ]);
    assert.equal(r.status, 0, r.stderr);
    for (const target of ['code.next', 'code.previous']) {
      assert.equal(readFileSync(join(dir, target, 'a'), 'utf8'), 'a');
      assert.equal(readFileSync(join(dir, target, 'sub/b'), 'utf8'), 'b');
      assert.equal(existsSync(join(dir, target, 'code')), false, `${target} nested the source`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'linked_libraries lists only what the runtime links, and nothing for a static file',
  { skip: process.platform !== 'linux' },
  () => {
    const r = shell('linked_libraries "$1"', [process.execPath]);
    assert.equal(r.status, 0, r.stderr);
    const deps = r.stdout.split('\n').filter(Boolean);
    assert.ok(deps.length > 0, 'the official Node binary is dynamically linked');
    for (const dep of deps) {
      assert.ok(dep.startsWith('/'), `unresolved dependency ${dep}`);
      assert.equal(shell('system_library "$1"', [dep]).status, 0, `${dep} is not a system library`);
    }
    // A non-ELF file reports "not a dynamic executable": nothing to inspect.
    const s = shell('linked_libraries "$1"', [join(here, 'install.sh')]);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(s.stdout, '');
    for (const lib of ['/home/u/lib/libevil.so', '/tmp/libx.so', '/opt/muxpad-broker/runtime/x.so'])
      assert.notEqual(shell('system_library "$1"', [lib]).status, 0, lib);
  },
);

test(
  'the systemd unit is confined and runs as the broker account',
  { skip: process.platform !== 'linux' },
  () => {
    const r = shell('systemd_unit /opt/muxpad-broker/muxpad-tsnet');
    assert.equal(r.status, 0, r.stderr);
    const unit = r.stdout;
    for (const line of [
      'User=muxbroker',
      'Group=muxbroker',
      'ExecStart=/opt/muxpad-broker/muxpad-tsnet',
      'Restart=always',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ReadWritePaths=/opt/muxpad-broker/state',
      'ProtectHome=yes',
      'CapabilityBoundingSet=',
      'StandardOutput=append:/opt/muxpad-broker/state/broker.log',
      'WantedBy=multi-user.target',
    ])
      assert.ok(unit.split('\n').includes(line), `unit lacks ${line}`);
    // systemd's own parser, where available (unprivileged, reads only the file).
    if (existsSync('/usr/bin/systemd-analyze')) {
      const dir = mkdtempSync(join(tmpdir(), 'broker-unit-'));
      try {
        const path = join(dir, 'muxpad-broker.service');
        writeFileSync(path, shell('systemd_unit /bin/true').stdout);
        const v = spawnSync('/usr/bin/systemd-analyze', ['verify', path], { encoding: 'utf8' });
        assert.equal(v.status, 0, v.stderr);
        assert.equal(v.stderr.trim(), '', v.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

test(
  'extra_grants fails closed when the inspection tools are missing',
  { skip: process.platform !== 'linux' },
  () => {
    const tools = ['getfacl', 'getcap'].every((t) =>
      ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some((d) => existsSync(`${d}/${t}`)),
    );
    // `extra_grants` exits the shell when it cannot answer; reaching "none" or
    // "granted" without the tools would be a skipped check reading as a pass.
    const r = shell('if extra_grants "$1"; then echo granted; else echo none; fi', [here]);
    if (tools) assert.equal(r.stdout.trim(), 'none', r.stderr);
    else {
      assert.notEqual(r.status, 0);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /requires getfacl/);
    }
  },
);

test(
  "update-code.sh's single-process tree walk refuses the same things on Linux",
  { skip: process.platform !== 'linux' },
  () => {
    const src = read('update-code.sh');
    const program = src.slice(
      src.indexOf("<<'JS'\n", src.indexOf('check_tree() {')) + 7,
      src.indexOf('\nJS\n', src.indexOf('check_tree() {')),
    );
    const uid = String(process.getuid());
    const walk = (tree) =>
      spawnSync(process.execPath, ['--input-type=module', '-', uid, '--', tree], {
        input: program,
        encoding: 'utf8',
      });
    // Ancestors of a temp tree are root-owned, so the owner set is {me, root}.
    const walkAs = (tree) =>
      spawnSync(process.execPath, ['--input-type=module', '-', `0,${uid}`, '--', tree], {
        input: program,
        encoding: 'utf8',
      });
    // Not tmpdir(): /tmp is world-writable (sticky), which the walk rightly refuses.
    const dir = mkdtempSync(join(here, '.walk-'));
    try {
      chmodSync(dir, 0o755);
      writeFileSync(join(dir, 'f'), 'x');
      chmodSync(join(dir, 'f'), 0o644);
      assert.notEqual(
        walk(dir).status,
        0,
        'root-owned ancestors must not pass an owner set without 0',
      );
      const clean = walkAs(dir);
      const tools = ['getfacl', 'getcap'].every((t) =>
        ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some((d) => existsSync(`${d}/${t}`)),
      );
      // With the acl tools, a clean tree passes. Without them the walk refuses
      // rather than skipping the ACL half — never a silent pass.
      if (tools) assert.equal(clean.status, 0, clean.stderr);
      else assert.match(clean.stderr, /requires getfacl/);
      chmodSync(join(dir, 'f'), 0o664);
      assert.match(walkAs(dir).stderr, /Unprotected path/);
      chmodSync(join(dir, 'f'), 0o644);
      linkSync(join(dir, 'f'), join(dir, 'g'));
      assert.match(walkAs(dir).stderr, /Hardlink refused/);
      rmSync(join(dir, 'g'));
      symlinkSync(join(dir, 'f'), join(dir, 'g'));
      assert.match(walkAs(dir).stderr, /Symlink in protected path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('both installers ship, and import-check, the whole update manifest', () => {
  // install-tsnet.sh once copied 15 of the 27 files main.mjs reaches, so a
  // fresh install could not start; its own import check would have refused.
  const manifest = /FILES=\(([^)]*)\)/.exec(read('update-code.sh'))[1].trim().split(/\s+/).sort();
  const modules = manifest.filter((f) => f.endsWith('.mjs') && f !== 'main.mjs');
  for (const name of ['install.sh', 'install-tsnet.sh']) {
    const src = read(name);
    const shipped = /\nfor file in ([^;]*); do/.exec(src)[1].trim().split(/\s+/).sort();
    assert.deepEqual(shipped, manifest, `${name} ships a different file list`);
    // Importing main.mjs would RUN the broker; every other module is loaded.
    const checked = JSON.parse(/await Promise\.all\((\[[^\]]*\])/.exec(src)[1]).sort();
    assert.deepEqual(checked, modules, `${name} import-checks a different module list`);
  }
});

test('a missing ACL tool stops the installers before any change, naming the package', () => {
  // Called right after the root check (update-code.sh: right after the block)
  // and before anything is created or stopped.
  for (const name of SCRIPTS) {
    const src = read(name);
    const call = src.indexOf('\nrequire_tools getfacl setfacl getcap');
    assert.ok(call > src.indexOf(END), `${name} checks its tools before defining the check`);
    for (const later of ['\ncreate_account', '\nservice_disable', ' copy_tree "$DEST']) {
      const used = src.indexOf(later, src.indexOf(END));
      if (used !== -1) assert.ok(call < used, `${name} acts before checking tools`);
    }
  }
  if (process.platform !== 'linux') return;
  const r = shell('require_tools definitely-not-a-tool getcap');
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /Missing required tools: definitely-not-a-tool\. .*apt install definitely-not-a-tool/,
  );
  const acl = shell('require_tools getfacl setfacl');
  if (acl.status !== 0) assert.match(acl.stderr, /sudo apt install acl$/m);
});
