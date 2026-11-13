// TEST-ONLY temporary directories. Not part of any release.
import { chmodSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A short directory for Unix sockets. Socket paths are capped at 104 bytes
 * on macOS, and macOS's per-user TMPDIR is long, so tests there use
 * /private/tmp. Elsewhere the ordinary temporary directory is short enough.
 */
export function shortTempRoot() {
  return process.platform === 'darwin' ? '/private/tmp' : realpathSync(tmpdir());
}

// Every ancestor owned by root or this UID, with no group/other write: what
// assertProtectedPath demands of a test-owned tree.
function protectedChain(path) {
  for (let p = path; ; p = dirname(p)) {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || (st.uid !== 0 && st.uid !== process.getuid()) || st.mode & 0o022)
      return false;
    if (p === dirname(p)) return true;
  }
}

export const NO_PROTECTED_TEMP =
  'no temporary directory with protected ancestors (/tmp is world-writable); set TMPDIR to a private directory';

/**
 * A 0700 directory whose ancestors pass the protected-path checks, or null.
 * macOS's per-user TMPDIR already qualifies. Linux's /tmp is sticky but
 * world-writable, which the checks rightly refuse, so the home directory is
 * the fallback.
 */
export function protectedTempDir(prefix) {
  for (const base of [realpathSync(tmpdir()), realpathSync(homedir())]) {
    if (!protectedChain(base)) continue;
    const dir = mkdtempSync(
      join(base, base === realpathSync(tmpdir()) ? prefix : `.muxpad-test-${prefix}`),
    );
    chmodSync(dir, 0o700);
    return dir;
  }
  return null;
}

/** For `test(name, { skip }, …)`: a reason, or false when a directory exists. */
export const protectedTempSkip = (() => {
  for (const base of [realpathSync(tmpdir()), realpathSync(homedir())])
    if (protectedChain(base)) return false;
  return NO_PROTECTED_TEMP;
})();
