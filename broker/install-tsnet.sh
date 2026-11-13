#!/bin/bash
# Execute only from a frozen, independently approved root-owned release.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
set -euo pipefail
# BEGIN PLATFORM
# ── WHAT DIFFERS BETWEEN macOS AND LINUX, AND NOTHING ELSE ───────────────
# Byte-identical in install.sh, install-tsnet.sh and update-code.sh (a test
# holds them equal). Copied rather than sourced: each script runs alone from a
# frozen release, and a sourced helper would have to be validated before it
# could be trusted to validate anything. The roots match broker-paths.mjs and
# the tsnet helper's paths_<os>.go; main.mjs refuses any other.
case $(/usr/bin/uname -s) in
 Darwin)
  OS=darwin DEST=/Library/muxpad-broker ACCOUNT=_muxbroker ROOT_GROUP=wheel BROKER_GROUP=staff
  SERVICE_FILE=/Library/LaunchDaemons/org.muxpad.broker.plist EMPTY_HOME=/var/empty CHOWN=/usr/sbin/chown ;;
 Linux)
  OS=linux DEST=/opt/muxpad-broker ACCOUNT=muxbroker ROOT_GROUP=root BROKER_GROUP=muxbroker
  SERVICE_FILE=/etc/systemd/system/muxpad-broker.service EMPTY_HOME=/nonexistent CHOWN=/bin/chown ;;
 *) echo 'The protected broker supports macOS and Linux only'; exit 1 ;;
esac
SERVICE=muxpad-broker.service
# BSD and GNU stat spell the same three questions differently.
file_owner() { if [[ $OS == darwin ]]; then /usr/bin/stat -f '%u' "$1"; else /usr/bin/stat -c '%u' -- "$1"; fi; }
file_mode() { if [[ $OS == darwin ]]; then /usr/bin/stat -f '%Lp' "$1"; else /usr/bin/stat -c '%a' -- "$1"; fi; }
link_count() { if [[ $OS == darwin ]]; then /usr/bin/stat -f '%l' "$1"; else /usr/bin/stat -c '%h' -- "$1"; fi; }
sha256() { if [[ $OS == darwin ]]; then /usr/bin/shasum -a 256 "$@"; else /usr/bin/sha256sum "$@"; fi; }
# getfacl lives in /usr/bin, getcap in /sbin on Debian and /usr/sbin elsewhere.
# An absent tool is not an absent risk: refuse, as protected-path.mjs does.
linux_tool() {
 local dir name=$1; shift
 for dir in /usr/bin /bin /usr/sbin /sbin; do
  if [[ -x $dir/$name ]]; then "$dir/$name" "$@"; return; fi
 done
 echo "Protected installation requires $name (install the acl and libcap2-bin packages)" >&2
 return 1
}
# Succeeds when the path carries ANY grant beyond its mode bits: an ACL entry
# on either platform, and on Linux a file capability too, which escalates
# without setuid. The same mechanisms protected-path.mjs refuses at runtime.
# A tool that cannot answer stops the script; it is never read as "none".
extra_grants() {
 local listing
 if [[ $OS == darwin ]]; then
  listing=$(/bin/ls -lde "$1") || exit 1
  printf '%s\n' "$listing" | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'
 else
  # --skip-base prints nothing for a path whose ACL only mirrors its mode.
  listing=$(linux_tool getfacl --absolute-names --omit-header --skip-base -- "$1") || exit 1
  [[ -z ${listing//[[:space:]]/} ]] || return 0
  listing=$(linux_tool getcap -- "$1" 2>/dev/null) || exit 1
  [[ -n ${listing//[[:space:]]/} ]]
 fi
}
# Remove every ACL entry: `strip_acls [-R] PATH`.
strip_acls() {
 if [[ $OS == darwin ]]; then
  if [[ $1 == -R ]]; then /bin/chmod -RN "$2"; else /bin/chmod -N "$1"; fi
 else
  if [[ $1 == -R ]]; then linux_tool setfacl -R -b -- "$2"; else linux_tool setfacl -b -- "$1"; fi
 fi
}
# Copy a tree into DEST, completing a partial earlier copy (ditto's semantics).
copy_tree() { if [[ $OS == darwin ]]; then /usr/bin/ditto "$1" "$2"; else /bin/cp -a -- "$1/." "$2"; fi; }
# Absolute paths of linked libraries outside the protected system locations,
# one per line, and any unresolved name as-is so the caller refuses it.
# On Linux, ldd asks the binary's own loader; that is acceptable only because
# every binary reaching here already passed check_path as a frozen release file.
system_library() {
 if [[ $OS == darwin ]]; then [[ $1 == /usr/lib/* || $1 == /System/* ]]
 else [[ $1 == /lib/* || $1 == /lib64/* || $1 == /usr/lib/* || $1 == /usr/lib64/* ]]; fi
}
linked_libraries() {
 local listing
 if [[ $OS == darwin ]]; then
  listing=$(/usr/bin/otool -L "$1") || return 1
  printf '%s\n' "$listing" | /usr/bin/tail -n +2 | /usr/bin/awk '{print $1}'
 else
  # A static binary (the Go helper) has nothing to inspect, and says so.
  if ! listing=$(/usr/bin/ldd -- "$1" 2>&1); then
   [[ $listing == *'not a dynamic executable'* ]] || return 1
   return 0
  fi
  # `name => /path (addr)` or `name => not found`; the loader itself is a bare
  # absolute path; linux-vdso has neither and is the kernel's own.
  printf '%s\n' "$listing" | /usr/bin/awk '/=>/{print $3; next} $1 ~ /^\//{print $1}'
 fi
}
account_exists() {
 if [[ $OS == darwin ]]; then /usr/bin/dscl . -read "/Users/$ACCOUNT" >/dev/null 2>&1
 else /usr/bin/getent passwd "$ACCOUNT" >/dev/null || /usr/bin/getent group "$ACCOUNT" >/dev/null; fi
}
# Creates the dedicated broker account and sets BROKER_UID.
create_account() {
 if [[ $OS == darwin ]]; then
  BROKER_UID=450
  while /usr/bin/dscl . -search /Users UniqueID "$BROKER_UID" | /usr/bin/grep -q .; do BROKER_UID=$((BROKER_UID + 1)); done
  /usr/bin/dscl . -create "/Users/$ACCOUNT"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" UniqueID "$BROKER_UID"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" PrimaryGroupID 20
  /usr/bin/dscl . -create "/Users/$ACCOUNT" UserShell /usr/bin/false
  /usr/bin/dscl . -create "/Users/$ACCOUNT" NFSHomeDirectory /var/empty
  /usr/bin/dscl . -create "/Users/$ACCOUNT" IsHidden 1
  /usr/bin/dscl . -create "/Users/$ACCOUNT" Password '*'
 else
  # A system UID with its own group, no home, no login shell, and a locked
  # password (useradd's default for a new account).
  /usr/sbin/useradd --system --user-group --no-create-home --home-dir "$EMPTY_HOME" --shell /usr/sbin/nologin --comment 'muxpad Slack approval broker' "$ACCOUNT"
  BROKER_UID=$(/usr/bin/id -u "$ACCOUNT")
 fi
}
# LOADED means "may be running or about to run". A systemd unit waiting out
# RestartSec reads "activating", so only inactive/failed count as stopped, and
# a leftover process of the broker UID counts as running whatever the unit says.
service_loaded() {
 if [[ $OS == darwin ]]; then
  /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1
 else
  local state
  state=$(/bin/systemctl show --property=ActiveState --value "$SERVICE") || return 0
  [[ $state != inactive && $state != failed ]] || /usr/bin/pgrep -u "$ACCOUNT" >/dev/null
 fi
}
# Persistent across reboot on both: launchctl disable, and systemctl disable.
service_disable() { if [[ $OS == darwin ]]; then /bin/launchctl disable system/org.muxpad.broker; else /bin/systemctl disable --quiet "$SERVICE"; fi; }
service_enable() { if [[ $OS == darwin ]]; then /bin/launchctl enable system/org.muxpad.broker; else /bin/systemctl enable --quiet "$SERVICE"; fi; }
service_stop() { if [[ $OS == darwin ]]; then /bin/launchctl bootout system/org.muxpad.broker; else /bin/systemctl stop "$SERVICE"; fi; }
service_start() {
 if [[ $OS == darwin ]]; then /bin/launchctl bootstrap system "$SERVICE_FILE"
 else /bin/systemctl daemon-reload && /bin/systemctl enable --quiet "$SERVICE" && /bin/systemctl start "$SERVICE"; fi
}
# The systemd SYSTEM unit, on stdout: `systemd_unit PROGRAM [ARG…]`. The same
# contract as the LaunchDaemon (dedicated UID, restart, private logs inside
# state), plus the confinement systemd can add: read-only system, no home,
# no privilege gain, no capabilities, writes only to the private state.
systemd_unit() {
 /bin/cat <<UNIT
[Unit]
Description=muxpad Slack approval broker
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$ACCOUNT
Group=$BROKER_GROUP
Environment=HOME=$EMPTY_HOME
ExecStart=$*
Restart=always
RestartSec=15
UMask=0077
StandardOutput=append:$DEST/state/broker.log
StandardError=append:$DEST/state/broker.err
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DEST/state
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
}
# Refuse BEFORE any change when a tool the checks depend on is missing.
# protected-path.mjs makes the running broker refuse without getfacl and
# getcap too, so an install that skipped this would only fail later, with
# the account and tree already created. `require_tools NAME…`; macOS ships
# its equivalents with the system.
require_tools() {
 local name dir missing='' packages=''
 [[ $OS == linux ]] || return 0
 for name in "$@"; do
  for dir in /usr/bin /bin /usr/sbin /sbin; do [[ -x $dir/$name ]] && continue 2; done
  missing="$missing $name"
  case $name in getfacl|setfacl) packages="$packages acl" ;; getcap) packages="$packages libcap2-bin" ;; *) packages="$packages $name" ;; esac
 done
 [[ -z $missing ]] && return 0
 packages=$(printf '%s\n' $packages | /usr/bin/sort -u | /usr/bin/tr '\n' ' ')
 echo "Missing required tools:$missing. Install them first: sudo apt install ${packages% }" >&2
 exit 1
}
# END PLATFORM
[[ $(/usr/bin/id -u) == 0 ]] || { echo 'Administrator authorization required'; exit 1; }
require_tools getfacl setfacl getcap
RESUME=false
if [[ ${1:-} == --resume ]]; then RESUME=true; shift; fi
[[ $# == 2 ]] || { echo 'Expected current muxpad HTTPS URL and agent account name'; exit 1; }
MUXPAD_UI=$1
SUDO_USER=$2
AGENT_UID=$(/usr/bin/id -u "$SUDO_USER")
[[ $AGENT_UID -ne 0 ]] || { echo 'Agent OS account must be unprivileged'; exit 1; }
SOURCE=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
RUNTIME="$SOURCE/runtime/node"
if [[ $RESUME == false ]]; then
 [[ ! -e $DEST && ! -L $DEST ]] || { echo 'Setup exists. Rerun this same verified installer with --resume before the two arguments.'; exit 1; }
 [[ ! -e $SERVICE_FILE && ! -L $SERVICE_FILE ]] || { echo 'Broker daemon already exists'; exit 1; }
fi
# On Linux the bundled binaries' architecture is proved by executing them below.
if [[ $OS == darwin ]]; then
 [[ $(/usr/bin/uname -m) == arm64 ]] || { echo 'This release supports Apple Silicon only'; exit 1; }
fi
check_path() {
  local path=$1 owner mode
  [[ $path == /* && -e $path && ! -L $path ]] || { echo "Not a protected absolute path: $path"; exit 1; }
  while [[ $path != / ]]; do
    [[ ! -L $path ]] || { echo "Symlink in protected path: $path"; exit 1; }
    owner=$(file_owner "$path"); mode=$(file_mode "$path")
    [[ $owner == 0 ]] && (( (8#$mode & 0022) == 0 )) || { echo "Root ownership and no group/world write required: $path"; exit 1; }
    if extra_grants "$path"; then
      echo "ACL or file capability on protected path; refusing: $path"; exit 1
    fi
    path=$(/usr/bin/dirname "$path")
  done
}
# These checks are defense in depth AFTER independent verification of the
# staged artifact. A mutable installer cannot authenticate its own source.
check_path "$SOURCE/install-tsnet.sh"
check_path "$SOURCE"
check_path "$(/usr/bin/dirname "$DEST")"
check_path "$(/usr/bin/dirname "$SERVICE_FILE")"
[[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] || { echo 'Install with sudo from the actual agent OS account so its effective access can be checked'; exit 1; }
while IFS= read -r -d '' staged; do
  [[ ! -L $staged && ( -f $staged || -d $staged ) ]] || { echo 'Non-regular staged artifact entry'; exit 1; }
  check_path "$staged"
  if [[ -f $staged && $(link_count "$staged") != 1 ]]; then echo 'Hardlinked staged artifact entry'; exit 1; fi
done < <(/usr/bin/find "$SOURCE" -print0)
SEEN=''
check_binary() {
  local bin=$1 dep libraries
  [[ "|$SEEN|" == *"|$bin|"* ]] && return
  SEEN="${SEEN}|${bin}"
  check_path "$bin"
  libraries=$(linked_libraries "$bin") || { echo "Cannot inspect runtime libraries: $bin"; exit 1; }
  while IFS= read -r dep; do
    if [[ -z $dep ]] || system_library "$dep"; then continue; fi
    [[ $dep == /* ]] || { echo "Unresolved dynamic library $dep; install a protected Node runtime"; exit 1; }
    check_binary "$dep"
  done < <(printf '%s\n' "$libraries")
}
check_binary "$RUNTIME"
check_binary "$SOURCE/muxpad-tsnet"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module - "$MUXPAD_UI" "$OS" <<'JS'
const u = new URL(process.argv[2]);
if(u.protocol !== 'https:' || u.username || u.password || u.hash) throw Error('Use your existing muxpad HTTPS URL');
const [major,minor] = process.versions.uv.split('.').map(Number);
if(process.platform !== process.argv[3] || major<1 || (major===1 && minor<52)) throw Error('Incompatible runtime');
JS
if [[ $RESUME == true ]]; then
 check_path "$DEST/setup.pending"
 [[ $(/bin/cat "$DEST/setup.pending") == $(sha256 "$SOURCE/install-tsnet.sh" | /usr/bin/awk '{print $1}') ]] || { echo 'Resume requires the exact original verified installer'; exit 1; }
 if service_loaded; then echo 'Broker is already running; refusing to reset setup'; exit 1; fi
 BROKER_UID=$(/usr/bin/id -u "$ACCOUNT")
 [[ "$(file_owner "$DEST/state"):$(file_mode "$DEST/state")" == "$BROKER_UID:700" ]] || { echo 'Unexpected broker state ownership or permissions'; exit 1; }
 check_binary "$DEST/runtime/node"
 check_binary "$DEST/muxpad-tsnet"
 check_path "$DEST/code/protected-path.mjs"
 # Preserve the enrolled tsnet identity and every existing private state file.
 # Refuse recovery of a paired deployment even if its daemon is stopped.
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$BROKER_UID" "$DEST" <<'JS'
const base=process.argv[3];
const {assertProtectedPath}=await import(base+"/code/protected-path.mjs");
assertProtectedPath(base+"/state",[0,Number(process.argv[2])],{mode:0o700});
import {existsSync,readFileSync} from 'node:fs';
const p=base+'/state/state.json';
if(existsSync(p)) assertProtectedPath(p,[0,Number(process.argv[2])],{mode:0o600});
if(existsSync(p) && JSON.parse(readFileSync(p,'utf8')).humanPaired) throw Error('Already paired; use administrative maintenance instead');
JS
else
if account_exists; then echo 'Broker account already exists; reconcile prior installation first'; exit 1; fi
create_account
/usr/bin/install -d -o root -g "$ROOT_GROUP" -m 755 "$DEST" "$DEST/code" "$DEST/runtime"
/usr/bin/install -d -o "$ACCOUNT" -g "$BROKER_GROUP" -m 700 "$DEST/state"
/usr/bin/install -o root -g "$ROOT_GROUP" -m 755 "$RUNTIME" "$DEST/runtime/node"
/usr/bin/install -o root -g "$ROOT_GROUP" -m 644 "$SOURCE/runtime/LICENSE" "$DEST/runtime/LICENSE"
/usr/bin/install -o root -g "$ROOT_GROUP" -m 755 "$SOURCE/muxpad-tsnet" "$DEST/muxpad-tsnet"
# The same manifest as update-code.sh (a test holds the three lists equal):
# main.mjs imports all of it, so a shorter list installs a broker that cannot start.
for file in broker-paths.mjs capabilities.mjs client.js core.mjs device-auth.mjs device-client.mjs http.mjs human-session.mjs main.mjs msgvault-argv.mjs msgvault-runner.mjs msgvault.mjs node-policy.mjs node-session.mjs origins.mjs page.html passkey-admin-socket.mjs passkey-approval.mjs passkey-http.mjs policy.mjs protected-path.mjs shell.css shell.html shell.js slack.mjs socket-listener.mjs state-store.mjs; do
 /usr/bin/install -o root -g "$ROOT_GROUP" -m 644 "$SOURCE/$file" "$DEST/code/$file"
done
/bin/cp -R "$SOURCE/node_modules" "$DEST/code/node_modules"
"$CHOWN" -R "root:$ROOT_GROUP" "$DEST/code"
strip_acls -R "$DEST"
/usr/bin/find "$DEST/code" -type d -exec /bin/chmod 755 {} +
/usr/bin/find "$DEST/code" -type f -exec /bin/chmod 644 {} +
(cd "$DEST/code" && /usr/bin/sudo -u "$ACCOUNT" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$EMPTY_HOME" "$DEST/runtime/node" --input-type=module -e 'await Promise.all(["broker-paths.mjs","capabilities.mjs","core.mjs","device-auth.mjs","device-client.mjs","http.mjs","human-session.mjs","msgvault-argv.mjs","msgvault-runner.mjs","msgvault.mjs","node-policy.mjs","node-session.mjs","origins.mjs","passkey-admin-socket.mjs","passkey-approval.mjs","passkey-http.mjs","policy.mjs","protected-path.mjs","slack.mjs","socket-listener.mjs","state-store.mjs"].map(name=>import("./"+name)))')
 sha256 "$SOURCE/install-tsnet.sh" | /usr/bin/awk '{print $1}' > "$DEST/setup.pending"
 /bin/chmod 600 "$DEST/setup.pending"
fi
# Enrollment is shown ONLY in this trusted setup terminal. The host's existing
# Tailscale identity is never read, reconfigured or logged out.
echo 'Authorize the new muxpad-secure Tailscale device using the link below on your private device.'
/usr/bin/sudo -u "$ACCOUNT" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$EMPTY_HOME" "$DEST/muxpad-tsnet" --enroll-only
# Read the assigned hostname from the helper-owned private output, not Host headers.
ORIGIN=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'import{readFileSync}from"node:fs";console.log(readFileSync(process.argv[1],"utf8"))' "$DEST/state/origin")
umask 077
read -r -s -p 'New Slack user OAuth token (input hidden): ' TOKEN; echo
[[ $TOKEN == xoxp-* ]] || { echo 'Expected a user OAuth token'; exit 1; }
printf '%s' "$TOKEN" > "$DEST/state/slack-token"; unset TOKEN
"$CHOWN" "$ACCOUNT:$BROKER_GROUP" "$DEST/state/slack-token"
# Ask Slack directly for the team ID; never ask the user to discover it.
TEAM=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$DEST/state/slack-token" <<'JS'
import {readFileSync} from 'node:fs';
const token = readFileSync(process.argv[2],'utf8').trim();
const response = await fetch('https://slack.com/api/auth.test', {method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
const data = await response.json();
if(!response.ok || !data.ok || !/^T[A-Z0-9]+$/.test(data.team_id)) throw Error('Slack credential validation failed');
console.log(data.team_id);
JS
)
PAIRING=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'import{randomBytes}from"node:crypto";console.log(randomBytes(32).toString("base64url"))')
BOOTSTRAP_HASH=$(printf '%s' "$PAIRING" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'import{createHash}from"node:crypto";let s="";for await(const c of process.stdin)s+=c;console.log(createHash("sha256").update(s).digest("base64url"))')
if [[ ! -e "$DEST/state/state.json" ]]; then printf '{}' > "$DEST/state/state.json"; fi
"$CHOWN" "$ACCOUNT:$BROKER_GROUP" "$DEST/state/state.json"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$ORIGIN" "$MUXPAD_UI" "$TEAM" "$BOOTSTRAP_HASH" "$DEST" > "$DEST/config.json" <<'JS'
const [origin,muxpadURL,teamID,bootstrapHash,base]=process.argv.slice(2);const u=new URL(origin);const ui=new URL(muxpadURL);
if(u.protocol!=='https:' || u.origin!==origin || !u.hostname.endsWith('.ts.net') || u.hostname===ui.hostname) throw Error('Invalid isolated hostname');
console.log(JSON.stringify({transport:'tsnet',originPath:base+'/state/origin',socketPath:base+'/state/broker.sock',origin,rpID:u.hostname,muxpadURL,teamID,bootstrapHash,approvalMode:'session',autoRead:false,channels:[],tokenPath:base+'/state/slack-token',statePath:base+'/state/state.json'},null,2));
JS
/bin/chmod 644 "$DEST/config.json"
strip_acls -R "$DEST"
for file in "$DEST/state/slack-token" "$DEST/state/state.json" "$DEST/state/origin" "$DEST/state/tailscale"; do
 if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -r "$file"; then echo 'Agent can read protected state; refusing activation'; exit 1; fi
done
for file in "$DEST" "$DEST/code" "$DEST/runtime/node" "$DEST/muxpad-tsnet" "$DEST/config.json"; do
 if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -w "$file"; then echo 'Agent can modify protected installation; refusing activation'; exit 1; fi
done
if [[ $OS == darwin ]]; then
/bin/cat > "$SERVICE_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>org.muxpad.broker</string>
<key>UserName</key><string>$ACCOUNT</string>
<key>ProgramArguments</key><array><string>$DEST/muxpad-tsnet</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>$DEST/state/broker.log</string>
<key>StandardErrorPath</key><string>$DEST/state/broker.err</string>
</dict></plist>
PLIST
else
systemd_unit "$DEST/muxpad-tsnet" > "$SERVICE_FILE"
fi
strip_acls "$SERVICE_FILE"
/bin/chmod 644 "$SERVICE_FILE"
check_path "$SERVICE_FILE"
service_start
/bin/rm "$DEST/setup.pending"
# Public routing metadata, the same file the macOS setup wizard writes, so the
# muxpad server finds the broker without MUXPAD_SLACK_BROKER_URL. Linux only:
# the macOS path keeps its existing, documented behaviour.
if [[ $OS == linux ]]; then
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$ORIGIN" "$MUXPAD_UI" > "$DEST/setup-public.json" <<'JS'
const [brokerURL,appOrigin]=process.argv.slice(2);
console.log(JSON.stringify({version:1,brokerURL,appOrigin}));
JS
 /bin/chmod 644 "$DEST/setup-public.json"
 check_path "$DEST/setup-public.json"
fi
echo
echo "Open this NEW protected muxpad address in your private browser: $ORIGIN"
echo "Pairing secret (one use, private): $PAIRING"
unset PAIRING
if [[ $OS == darwin ]]; then
 echo "Configure ordinary muxpad's MUXPAD_SLACK_BROKER_URL=$ORIGIN after its code is integrated."
else
 echo "Ordinary muxpad discovers $ORIGIN from $DEST/setup-public.json; restart only its server."
fi
echo 'Finish the private-browser and OS isolation acceptance checks before sending real messages.'
