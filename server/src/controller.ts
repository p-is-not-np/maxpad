// CONTROLLER MODE — the agent behind a voice call supervises, it does not work.
//
// See docs/plans/2026-11-03-voice-controller.md. Three layers:
//
//   voice (gpt-live-1)  the UI. Speaks what it is handed, reads the board back.
//   this pane's agent   the CONTROLLER. Splits, dispatches, steers, merges.
//   sub-agent panes     the EXECUTORS. Do the actual work.
//
// THE ONE RULE: the controller's turns take seconds. The server runs one turn
// per pane at a time, so a controller that edits files itself is a controller
// that cannot hear "actually, use postgres" until it is done — everything the
// user says queues behind it. Keeping execution out of the controller is what
// keeps it always available.
//
// HOW IT IS SWITCHED ON: not a third AgentMode. A live voice call IS the fact,
// and the server already knows it (VoiceSessionManager), so the server drops a
// marker file per pane while a call is live and the runner checks it — per
// tool call for the gate, per user message for the contract. No respawn, and
// a typed chat keeps doing small things inline the moment the call ends.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function controllerDir(dataDir: string): string {
  return join(dataDir, 'controller');
}

export function controllerMarkerPath(dataDir: string, paneId: string): string {
  return join(controllerDir(dataDir), paneId.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/** Server side: a voice call on `paneId` started (on) or ended (off). */
export function setControllerMarker(dataDir: string, paneId: string, on: boolean): void {
  const p = controllerMarkerPath(dataDir, paneId);
  try {
    if (on) {
      mkdirSync(controllerDir(dataDir), { recursive: true });
      writeFileSync(p, `${Date.now()}\n`);
    } else {
      rmSync(p, { force: true });
    }
  } catch {
    // Best effort: a missing marker degrades to an ordinary Chat pane.
  }
}

/** Server boot: no call survives a restart, so neither does any marker. */
export function clearControllerMarkers(dataDir: string): void {
  try {
    rmSync(controllerDir(dataDir), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Runner side: the marker's mtime while a call is live, else null. The mtime
 *  identifies the CALL, so a second call re-delivers the contract. */
export function controllerCallStamp(dataDir: string, paneId: string): number | null {
  const p = controllerMarkerPath(dataDir, paneId);
  if (!existsSync(p)) return null;
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Tools that ARE execution. Removed by refusal, not by `disallowedTools`,
 *  because the session outlives the call and a tool list is fixed at boot. */
const EXECUTION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Shell commands a controller may run itself: the `muxpad` CLI (dispatch,
 * steer, read, cards) and reads that answer in well under a second. Anything
 * else belongs in an executor. Deliberately a prefix allowlist on each piece of
 * a pipeline — a POC gate, not a sandbox.
 */
const ALLOWED_COMMANDS =
  /^(muxpad|ls|cat|head|tail|wc|pwd|echo|grep|rg|find|date|git (status|log|diff|show|branch|rev-parse))\b/;

function commandAllowed(command: string): boolean {
  const pieces = command
    .split(/\|\||&&|;|\||\n/)
    .map((s) => s.trim().replace(/^(cd\s+\S+\s*)$/, 'pwd'))
    .filter(Boolean);
  if (pieces.length === 0) return false;
  return pieces.every((p) => /^cd\s/.test(p) || ALLOWED_COMMANDS.test(p));
}

/**
 * Why a controller may not make this tool call, or null when it may.
 * The reason is what the model reads, so it names the alternative.
 */
export function controllerRefusal(toolName: string, input: unknown): string | null {
  const redirect =
    'You are the CONTROLLER of a live voice call: you do not execute work yourself. Dispatch it to an executor with `muxpad agent new --name="<task>" "<self-contained brief>"` (or steer an existing one with `muxpad agent send <paneId> "…"`), update the `work` card, and end your turn.';
  if (EXECUTION_TOOLS.has(toolName)) return `${toolName} is not available. ${redirect}`;
  if (toolName === 'Bash') {
    const command = (input as { command?: unknown } | null)?.command;
    if (typeof command !== 'string') return null;
    if (commandAllowed(command)) return null;
    return `That command is execution, which controllers do not run. Only \`muxpad …\` and quick reads (ls, cat, grep, git status/log/diff) are allowed here. ${redirect}`;
  }
  return null;
}

/** The contract, delivered in-conversation when a call starts. */
export const CONTROLLER_CONTRACT = `<muxpad-controller>
A VOICE CALL IS LIVE ON THIS PANE. Until it ends you are the CONTROLLER, not a worker.

- The user is talking to a voice UI that relays their words to you and speaks your answer aloud. Your answer is SPOKEN: one or two short sentences, no lists, no paths, no code. Detail goes on the board, never in the spoken answer.
- Real work (editing, building, testing, research, anything over a few seconds) goes to EXECUTORS: \`muxpad agent new --name="<two to four words>" "<self-contained brief with paths and the done-criterion>"\`. Split independent work across several. Never do it yourself — editing tools and long commands are refused while the call is live.
- Dispatch, then END YOUR TURN at once. Do not wait on executors; their reports are delivered back to you.
- Steering ("use postgres", "stop the tests one"): find the executor on the board and \`muxpad agent send <paneId> "…"\` it, or stop it. One short turn.
- Keep ONE board, the \`work\` card: \`muxpad card set work --format=md "…"\`, one line per executor — **name** · state · what it is doing now · blocker if any. Rewrite it every turn you change something. The voice UI reads it to answer "how's it going?" without asking you.
- When reports arrive, merge them into ONE result, update the board, and answer only with what the user needs to hear now. Executor questions: answer them yourself when you can; ask the user only for taste, scope, or anything irreversible.
</muxpad-controller>`;

export const CONTROLLER_ENDED = `<muxpad-controller>
The voice call has ended. You are no longer the controller: the restrictions above are lifted and your replies are read, not spoken.
</muxpad-controller>`;
