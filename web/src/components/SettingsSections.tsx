import { type AgentModelOption, BACKEND_EFFORTS, type EffortLevel } from '@muxpad/shared';
import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { readNewChatBackend } from '../lib/agent-backend';
import { storeAppPref, useAppPref, useAppToggle } from '../lib/app-prefs';
import { updateSettings } from '../settings';

/** Every section of the dialog, in the order the left column lists them. */
export const SETTINGS_SECTIONS = [
  'appearance',
  'agents',
  'chats',
  'notifications',
  'integrations',
  'machines',
  'data',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const BACKENDS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
] as const;

/**
 * One pref write with the picker's failure contract: optimistic, undone on
 * failure, and the section says so in a line rather than flickering back.
 */
function usePrefWriter(): [(key: string, value: string | null) => void, boolean] {
  const [failed, setFailed] = useState(false);
  const write = (key: string, value: string | null) => {
    setFailed(false);
    void storeAppPref(key, value).catch((err) => {
      console.error(`could not store ${key}`, err);
      setFailed(true);
    });
  };
  return [write, failed];
}

function SaveFailed() {
  return (
    <p className="settings-note" role="alert">
      Couldn’t save that. The server may be running an older build — restart muxpad and try again.
    </p>
  );
}

/** A row: what it is and what it does on the left, the control on the right. */
function SettingRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row settings-control">
      <div className="settings-control-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint ? <p>{hint}</p> : null}
      </div>
      <div className="settings-control-input">{children}</div>
    </div>
  );
}

function Switch({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      className="settings-switch"
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── AGENTS ────────────────────────────────────────────────────────────────

/**
 * What a new chat starts as, and the standing notes every agent reads.
 *
 * The defaults apply to the rail's "+", the empty-workspace start and a
 * branch — the doors that make "a new chat" (see houseChatCreate). A sub-agent
 * started with `muxpad agent new` names its own backend and is not affected.
 */
export function AgentsSection({ active }: { active: boolean }) {
  const [write, failed] = usePrefWriter();
  const backend = readNewChatBackend(useAppPref('new_chat_backend'));
  const mode = useAppPref('new_chat_mode') === 'agent' ? 'agent' : 'chat';
  const model = useAppPref('new_chat_model') ?? '';
  const effort = useAppPref('new_chat_effort') ?? '';
  const [models, setModels] = useState<Record<string, AgentModelOption[]> | null>(null);
  const modelId = useId();
  const effortId = useId();

  useEffect(() => {
    if (!active || models) return;
    void api
      .agentLaunchOptions()
      .then((o) => setModels(o.models))
      .catch(() => setModels({}));
  }, [active, models]);

  const backendModels = models?.[backend] ?? [];
  const chosenModel = backendModels.find((m) => m.value === model);
  const efforts: readonly EffortLevel[] = chosenModel?.efforts ?? BACKEND_EFFORTS[backend];

  return (
    <>
      <h3 className="settings-heading">New chats</h3>
      <p className="settings-blurb">
        What the “+” in the sidebar starts. Agents you start from the command line choose their own.
      </p>
      <SettingRow label="Backend">
        <Segmented
          label="Backend"
          value={backend}
          options={BACKENDS}
          onChange={(v) => {
            if (v === backend) return;
            // A model or effort chosen for one harness means nothing to another.
            write('new_chat_backend', v === 'claude' ? null : v);
            write('new_chat_model', null);
            write('new_chat_effort', null);
          }}
        />
      </SettingRow>
      <SettingRow
        label="Mode"
        hint={
          mode === 'chat'
            ? 'Chat: muxpad’s assistant — brief, decisive, delegates.'
            : 'Agent: the harness exactly as it ships.'
        }
      >
        <Segmented
          label="Mode"
          value={mode}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'agent', label: 'Agent' },
          ]}
          onChange={(v) => write('new_chat_mode', v === 'chat' ? null : v)}
        />
      </SettingRow>
      <SettingRow label="Model" htmlFor={modelId}>
        <select
          id={modelId}
          value={model}
          onChange={(e) => {
            write('new_chat_model', e.target.value || null);
            write('new_chat_effort', null);
          }}
        >
          <option value="">Harness default</option>
          {backendModels.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName}
            </option>
          ))}
          {model && !chosenModel ? <option value={model}>{model}</option> : null}
        </select>
      </SettingRow>
      {efforts.length > 0 ? (
        <SettingRow label="Reasoning effort" htmlFor={effortId}>
          <select
            id={effortId}
            value={effort}
            onChange={(e) => write('new_chat_effort', e.target.value || null)}
          >
            <option value="">Default</option>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </SettingRow>
      ) : null}
      {failed ? <SaveFailed /> : null}
      <AgentNotes active={active} />
    </>
  );
}

/** The user's standing notes, agent-notes.md — injected into every session. */
function AgentNotes({ active }: { active: boolean }) {
  const [loaded, setLoaded] = useState<{ text: string; path: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'load-error'>('idle');
  const id = useId();

  useEffect(() => {
    if (!active || loaded) return;
    void api
      .agentNotes()
      .then((n) => {
        setLoaded(n);
        setDraft(n.text);
      })
      .catch(() => setState('load-error'));
  }, [active, loaded]);

  const dirty = loaded !== null && draft !== loaded.text;
  const save = async () => {
    setState('saving');
    try {
      const n = await api.setAgentNotes(draft);
      setLoaded(n);
      setState('saved');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="settings-notes">
      <h3 className="settings-heading">
        <label htmlFor={id}>Standing instructions</label>
      </h3>
      <p className="settings-blurb">
        Added to every agent session on this machine, after muxpad’s own instructions. Sessions
        already running keep what they started with.
      </p>
      <textarea
        id={id}
        className="settings-textarea"
        spellCheck={false}
        value={draft}
        disabled={loaded === null}
        placeholder={
          loaded === null ? 'Loading…' : 'Where your projects live, conventions, people…'
        }
        onChange={(e) => {
          setDraft(e.target.value);
          if (state !== 'saving') setState('idle');
        }}
      />
      <div className="settings-notes-foot">
        <span className="settings-notes-path">{loaded?.path}</span>
        {state === 'saved' && !dirty ? <output>Saved</output> : null}
        {state === 'error' ? (
          <output className="settings-notes-error" role="alert">
            Couldn’t save
          </output>
        ) : null}
        {state === 'load-error' ? (
          <output className="settings-notes-error" role="alert">
            Couldn’t load the notes
          </output>
        ) : null}
        <button type="button" disabled={!dirty || state === 'saving'} onClick={() => void save()}>
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ─── CHATS ─────────────────────────────────────────────────────────────────

export function ChatsSection() {
  const [write, failed] = usePrefWriter();
  const recent = useAppToggle('rail_recent', true);
  const gauge = useAppToggle('memory_gauge', true);
  const recentId = useId();
  const gaugeId = useId();
  return (
    <>
      <h3 className="settings-heading">Sidebar</h3>
      <SettingRow
        label="Recently active"
        hint="The band at the top of the sidebar with the chats that moved in the last sixteen hours."
        htmlFor={recentId}
      >
        <Switch
          id={recentId}
          checked={recent}
          onChange={(on) => write('rail_recent', on ? null : 'off')}
        />
      </SettingRow>
      <SettingRow
        label="Memory gauge"
        hint="This machine’s memory, in the sidebar’s footer."
        htmlFor={gaugeId}
      >
        <Switch
          id={gaugeId}
          checked={gauge}
          onChange={(on) => write('memory_gauge', on ? null : 'off')}
        />
      </SettingRow>
      <SettingRow label="Sidebar width" hint="Drag its edge to resize; this puts it back.">
        <button type="button" onClick={() => updateSettings({ sidebarWidth: 280 })}>
          Reset
        </button>
      </SettingRow>
      {failed ? <SaveFailed /> : null}
    </>
  );
}

// ─── DATA ──────────────────────────────────────────────────────────────────

const LIFESPANS = [
  { value: '1', label: '1 day' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '0', label: 'Never expire' },
] as const;

export function DataSection({ active }: { active: boolean }) {
  const [write, failed] = usePrefWriter();
  const days = useAppPref('publish_days') ?? '7';
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof api.installUsage>> | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const lifespanId = useId();

  useEffect(() => {
    if (!active) return;
    setUsageFailed(false);
    void api
      .installUsage()
      .then(setUsage)
      .catch(() => setUsageFailed(true));
  }, [active]);

  return (
    <>
      <h3 className="settings-heading">Publishing</h3>
      <SettingRow
        label="Published links last"
        hint="How long a new public link works before it expires. The files are kept either way."
        htmlFor={lifespanId}
      >
        <select
          id={lifespanId}
          value={days}
          onChange={(e) => write('publish_days', e.target.value === '7' ? null : e.target.value)}
        >
          {LIFESPANS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
          {LIFESPANS.some((l) => l.value === days) ? null : (
            <option value={days}>{days} days</option>
          )}
        </select>
      </SettingRow>
      {failed ? <SaveFailed /> : null}
      <h3 className="settings-heading settings-heading--spaced">Storage</h3>
      {usageFailed ? (
        <p className="settings-note">Couldn’t read the data folder.</p>
      ) : usage === null ? (
        <p className="settings-note">Measuring…</p>
      ) : (
        <>
          <p className="settings-blurb">
            <code>{usage.dataDir}</code> · {formatBytes(usage.total)}
          </p>
          <ul className="settings-usage">
            {usage.entries.map((e) => (
              <li key={e.name}>
                <span>{e.name}</span>
                <span className="settings-usage-bar" aria-hidden="true">
                  <i style={{ width: `${usage.total ? (e.bytes / usage.total) * 100 : 0}%` }} />
                </span>
                <span>{formatBytes(e.bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
