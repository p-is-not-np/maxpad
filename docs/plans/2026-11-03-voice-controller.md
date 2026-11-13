# Voice mode: voice is the UI, the agent is the controller, sub-agents execute

Status: proposal · 2026-11-03

## What exists today

Voice mode already has two of the three layers. They are not yet split along
the right line.

```
gpt-live-1 (browser, WebRTC)  ──delegation──▶  the Chat pane's agent  ──agent new──▶  sub-agent panes
   web/src/lib/voice/session.ts                   one serial turn queue                 (sometimes)
```

- The **voice layer** is gpt-live-1. It talks, says "on it", queues work, and
  answers "how's it going?" from `describePipeline()` (session.ts). That method
  is a list of the voice layer's own request strings, each with a status.
- The **Chat pane** gets each delegation as a normal `send`. It may do the work
  itself, or it may spawn sub-agents. Nothing makes it choose one or the other.
- **Sub-agent** results come back to the Chat pane as a delivery, and voice
  adopts it (`adoptDelivery`).

## The problem: the controller and the executor are one agent

When the Chat pane does the work itself, its turn takes minutes. The server
runs one turn at a time, so everything the user says during that turn
**queues behind it**. This includes "actually, use postgres", "stop the second
one" and "what did it find?". The voice layer can only answer from a list of
request strings. It does not know what is actually happening, so its progress
answers are thin: "it's working on the migration".

The fix is a rule, not a new component: **the controller never executes**.

## The three layers

| Layer | Runs as | Job | Turn length | Must never |
|---|---|---|---|---|
| **Voice (UI)** | gpt-live-1 (unchanged) | Render only: speak what the controller marked spoken, read the board back, pass every utterance down. No judgement about work. | ms | Decide anything, do work, or say more than the controller marked spoken |
| **Controller** | The Chat pane, in a new `controller` mode | Split each request into tasks, spawn executors, steer them, merge their results, keep the board up to date | **seconds** | Edit files, run builds or tests, or do anything long |
| **Executors** | `muxpad agent new` panes (Claude, Codex, …) | Get the work done | minutes | Talk to the user |

The controller's turns stay short, so it is **always available**. A steer is
one turn: the voice layer delegates "use postgres" → the controller runs
`muxpad agent send <exec> "…"` → the turn ends. It is never stuck in a queue
behind an hour of work.

## What changes

1. **A `controller` mode contract** (agent-modes.ts, next to chat-mode.md).
   A voice call puts its pane in this mode. The contract says:
   - Every request that is real work becomes one or more `agent new` executors,
     each with a specific name and a self-contained brief. The controller may
     only do reads that take seconds (`pane summarize`, `transcript --tail`,
     `git status`) itself.
   - End the turn right after you dispatch. Do not wait for executors.
   - When executor reports arrive (batched already), merge them into ONE
     result and decide if it is worth saying aloud.
   - Questions from executors: answer them yourself when you can. Send a
     question up to the user only when it needs the user (an irreversible
     step, taste, scope).
   - Enforcement, not only prompting: in this mode, refuse Edit/Write and Bash
     calls that run long. This is the same approach Chat mode uses for its
     blocked Task tools (a tool that is not offered beats a tool described as
     "do not use").

2. **The board: one card the controller owns** (`muxpad card set work`). It
   has one row per executor: name, state, one line of what it is doing now,
   and any blocker. The controller rewrites it on every turn. Executors do
   not write to it.
   - The voice layer reads the board instead of `describePipeline()`'s request
     strings. The board is pushed as silent context whenever it changes, so
     "how's it going?" gets the controller's real answer with **no turn**.
   - The user sees the same board on screen. Voice and screen show one source
     of truth.

3. **Two levels in every controller reply.** `reply` gets a `spoken` field:
   one sentence, the most the voice layer may say unprompted. The full text is
   for the screen. The voice layer speaks `spoken`. It reads the full text
   only when the user asks "tell me more". This puts the "no 3-minute
   monologue" rule in the data, not only in the prompt.
   (Agent-mode `spokenAnswerFrom` stays as the fallback.)

4. **Interrupt levels for the voice layer**, chosen by the controller and
   carried on the frame:
   - `now`: a blocker that needs the user. This is the current
     `input_required` path.
   - `next-pause`: a task finished or the plan changed.
   - `board-only`: progress. Never spoken unless the user asks.
   Today delivery.ts holds everything until the floor is free. This adds a
   "worth saying at all?" check before that.

5. **Routing steers.** "Use postgres", "kill the tests one", and "what's the
   API agent doing?" all go to the controller as normal delegations. The
   controller resolves which executor the user means, using the board. This
   gives the "which task do you mean" problem (left open in delegation.ts) a
   home: the controller, which has the context, not a heuristic in the
   browser.

## What stays as it is

- gpt-live-1 transport, cost controls, the fence, cancellation, and the
  question flow.
- Sub-agent delivery batching and the pill and chip UI.
- Chat mode itself. `controller` is a separate mode, so typed chats do not
  lose the option of doing small things inline.

## Model choice

- Controller: a strong model (Opus). Its turns are short, so the cost is
  low, and it is the layer where judgement matters most.
- Executors: chosen per task. Codex and Claude are both fine.
- Voice: unchanged.

## Order of work

1. Controller mode contract + tool gate. On its own this fixes the queueing.
2. The board card, and voice reading the board instead of request strings.
3. The `spoken` field on `reply`, and interrupt levels.
4. Steer routing and resolving which task the user means.

## Open questions

- Should a call always open a **fresh** controller pane, or turn the current
  chat into one? The mode-switch note in agent-instructions says a new pane
  is more reliable.
- How many executors at once before the controller asks the user first?
  (Cost guard. Suggest 4.)
- Does the board survive the end of the call? (Suggest yes. Clear it when
  the last executor retires.)
