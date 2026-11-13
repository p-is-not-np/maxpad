import { lstatSync, readFileSync } from 'node:fs';

/**
 * Where the protected broker tree lives, per platform. Must equal ROOTS in
 * broker/broker-paths.mjs (slack-broker.test.ts holds them together). A
 * platform with no root has no discovery: the env var is the only route.
 */
export const BROKER_ROOTS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/muxpad-broker',
  linux: '/opt/muxpad-broker',
};

/**
 * The installer publishes only routing metadata; never open its private
 * state/config. Both the tree root and the file must be root-owned (`owner`
 * is a parameter only for tests), not group/world writable and not symlinks,
 * and the file must have a single link. Anything else reads as "not installed".
 */
export function readRoutingMetadata(root: string, owner = 0): string | null {
  try {
    for (const path of [root, `${root}/setup-public.json`]) {
      const st = lstatSync(path);
      if (
        st.isSymbolicLink() ||
        st.uid !== owner ||
        st.mode & 0o022 ||
        (st.isFile() && st.nlink !== 1)
      )
        throw Error('Untrusted routing metadata');
    }
    const p = JSON.parse(readFileSync(`${root}/setup-public.json`, 'utf8'));
    if (p.version === 1 && typeof p.brokerURL === 'string') return p.brokerURL;
  } catch {
    /* No routing metadata: Settings will show installation instructions. */
  }
  return null;
}

/** The muxpad process holds no broker credential or approval key. */
export function slackBrokerURL(): string | null {
  let value = process.env.MUXPAD_SLACK_BROKER_URL;
  const root = BROKER_ROOTS[process.platform];
  if (!value && root) value = readRoutingMetadata(root) ?? undefined;
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('MUXPAD_SLACK_BROKER_URL must be a protected HTTPS origin');
  return url.origin;
}

export async function slackBrokerRequest(
  path: string,
  body?: unknown,
  timeoutMS = 35_000,
): Promise<Record<string, unknown>> {
  const base = slackBrokerURL();
  if (!base) throw new Error('Slack broker is not configured');
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMS),
    redirect: 'error',
  });
  if (!response.ok) {
    // ── KEEP THE BROKER'S OWN SENTENCE ──────────────────────────────────
    //
    // This used to throw the status and nothing else, so every refusal
    // reached the caller as "request failed; protected broker mode never
    // falls back to local credentials" — a line about CREDENTIALS, for a
    // review that had said something exact and useful: "search has no
    // --deep", "add-account administers the archive itself".
    //
    // That is the difference between an agent that corrects itself and one
    // that reports your mail as broken, which is a complaint this repo has
    // actually received. A 4xx is a DECISION and its reason is safe to
    // repeat; a 5xx is a fault and keeps the generic line.
    // THE BROKER ANSWERS `{error: "<sentence>"}`, a STRING — muxpad's own
    // routes answer `{error: {message}}`, an object. Reading only the object
    // shape is why the first cut of this changed nothing: the reason was
    // there, in the body, and the parser looked straight past it.
    const detail = await response
      .json()
      .then((b) => {
        const raw = b as { error?: unknown; detail?: unknown };
        const m =
          typeof raw?.error === 'string'
            ? raw.error
            : typeof (raw?.error as { message?: unknown })?.message === 'string'
              ? (raw.error as { message: string }).message
              : raw?.detail;
        return typeof m === 'string' && m.trim() ? m.trim().slice(0, 300) : null;
      })
      .catch(() => null);
    throw Object.assign(new Error(detail ?? 'Protected Slack broker refused the request'), {
      status: response.status,
      ...(detail ? { brokerReason: detail } : {}),
    });
  }
  return (await response.json()) as Record<string, unknown>;
}
