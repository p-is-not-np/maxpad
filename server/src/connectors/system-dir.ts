/**
 * WHERE THE OPERATOR'S CONNECTOR CONFIG LIVES — connectors.json,
 * integrations.json, origins/ — per platform.
 *
 *   macOS   /Library/muxpad
 *   Linux   /etc/muxpad
 *
 * The broker reads the same files, and its copy of this table is
 * `SYSTEM_ROOT` in broker/broker-paths.mjs; system-dir.test.ts holds the two
 * together. Any other platform keeps the macOS path, which is what every
 * caller used before there was a choice.
 */
export function muxpadSystemDir(platform: NodeJS.Platform = process.platform): string {
  return platform === 'linux' ? '/etc/muxpad' : '/Library/muxpad';
}

export const MUXPAD_SYSTEM_DIR = muxpadSystemDir();

/** The group a root-owned config file is given: macOS has `wheel`, Linux does not. */
export function rootGroup(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'wheel' : 'root';
}
