import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearControllerMarkers,
  controllerCallStamp,
  controllerRefusal,
  setControllerMarker,
} from './controller.js';

describe('controllerRefusal', () => {
  it('refuses the editing tools outright', () => {
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(controllerRefusal(t, {})).toMatch(/muxpad agent new/);
    }
  });

  it('lets the controller dispatch, steer and read', () => {
    for (const command of [
      'muxpad agent new --name="fix login" "brief"',
      'muxpad agent send 01ABC "use postgres"',
      'muxpad card set work --format=md "**fix login** · working"',
      'git status && git log --oneline | head -5',
      'cd ~/maxpad && ls',
      'grep -rn foo src | wc -l',
    ]) {
      expect(controllerRefusal('Bash', { command }), command).toBeNull();
    }
  });

  it('refuses execution in the shell, including behind an allowed prefix', () => {
    for (const command of [
      'pnpm test',
      'npm run build',
      'ls && rm -rf dist',
      'git push',
      'sed -i s/a/b/ x',
    ]) {
      expect(controllerRefusal('Bash', { command }), command).not.toBeNull();
    }
  });

  it('leaves every other tool alone', () => {
    expect(controllerRefusal('Read', { file_path: '/x' })).toBeNull();
    expect(controllerRefusal('mcp__muxpad__reply', { text: 'hi' })).toBeNull();
  });
});

describe('controller markers', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('a live call is visible to the runner, and gone once it ends or the server boots', () => {
    dir = mkdtempSync(join(tmpdir(), 'ctl-'));
    expect(controllerCallStamp(dir, 'p1')).toBeNull();
    setControllerMarker(dir, 'p1', true);
    expect(controllerCallStamp(dir, 'p1')).not.toBeNull();
    expect(controllerCallStamp(dir, 'p2')).toBeNull();
    setControllerMarker(dir, 'p1', false);
    expect(controllerCallStamp(dir, 'p1')).toBeNull();
    setControllerMarker(dir, 'p1', true);
    clearControllerMarkers(dir);
    expect(controllerCallStamp(dir, 'p1')).toBeNull();
  });
});
