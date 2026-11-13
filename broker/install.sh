#!/bin/bash
# Run ONLY from an independently verified root-controlled staging artifact.
# Never sudo a script in an agent-writable checkout, even after source review.
# See broker/README.md for the external digest verification/bootstrap procedure.
# Enter using /usr/bin/env -i as documented: BASH_ENV can execute before a
# script starts, so sanitizing inside the script is not a substitute for that.
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
# END PLATFORM
[[ $(/usr/bin/id -u) == 0 ]] || { echo 'Run this installer with sudo in your own terminal.' >&2; exit 1; }
[[ $# == 6 ]] || { echo 'Expected NODE ORIGIN TEAM CERT KEY MUXPAD_URL; use the verified-stage clean-environment command in README.md'; exit 1; }
RUNTIME=$1 ORIGIN=$2 TEAM=$3 CERT=$4 KEY=$5 MUXPAD_UI=$6
SOURCE=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
[[ ! -e $DEST && ! -L $DEST ]] || { echo 'Existing broker installation path; refusing to overwrite it'; exit 1; }
[[ ! -e $SERVICE_FILE && ! -L $SERVICE_FILE ]] || { echo 'Existing broker service definition; refusing to overwrite it'; exit 1; }

# The runtime and every non-system linked library must be protected, including
# ancestor directories. Homebrew's user-owned paths deliberately fail this check.
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
check_path "$SOURCE/install.sh"
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
check_path "$CERT"; check_path "$KEY"
# Reject a bad hostname configuration before creating an account or writing secrets.
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module - "$ORIGIN" "$MUXPAD_UI" <<'JS'
const [origin, muxpadURL] = process.argv.slice(2); const broker = new URL(origin); const ui = new URL(muxpadURL);
if (broker.protocol !== 'https:' || broker.origin !== origin || broker.username || broker.password || ui.protocol !== 'https:' || ui.hostname === broker.hostname || ui.username || ui.password || ui.hash) throw Error('Use two different HTTPS hostnames; the broker origin must have no path');
JS
[[ -d $SOURCE/node_modules/@simplewebauthn/server ]] || { echo 'First run npm ci --ignore-scripts --prefix broker as your normal user'; exit 1; }
if account_exists; then
  echo 'Broker account already exists. Refusing to overwrite an installed trust boundary.'; exit 1
fi
create_account
/usr/bin/install -d -o root -g "$ROOT_GROUP" -m 755 "$DEST" "$DEST/code"
/usr/bin/install -d -o "$ACCOUNT" -g "$BROKER_GROUP" -m 700 "$DEST/state"
for file in broker-paths.mjs capabilities.mjs client.js core.mjs device-auth.mjs device-client.mjs http.mjs human-session.mjs main.mjs msgvault-argv.mjs msgvault-runner.mjs msgvault.mjs node-policy.mjs node-session.mjs origins.mjs page.html passkey-admin-socket.mjs passkey-approval.mjs passkey-http.mjs policy.mjs protected-path.mjs shell.css shell.html shell.js slack.mjs socket-listener.mjs state-store.mjs; do /usr/bin/install -o root -g "$ROOT_GROUP" -m 644 "$SOURCE/$file" "$DEST/code/$file"; done
# Refuse dependency symlinks before copying code into the protected boundary.
[[ -z $(/usr/bin/find "$SOURCE/node_modules" -type l -print -quit) ]] || { echo 'Unexpected dependency symlink'; exit 1; }
/bin/cp -R "$SOURCE/node_modules" "$DEST/code/node_modules"
"$CHOWN" -R "root:$ROOT_GROUP" "$DEST/code"
strip_acls -R "$DEST"
/usr/bin/find "$DEST/code" -type d -exec /bin/chmod 755 {} +
/usr/bin/find "$DEST/code" -type f -exec /bin/chmod 644 {} +
check_path "$DEST/code"
# Prove the dedicated UID can traverse dependencies and load the actual module
# before asking for any credential or attempting daemon activation.
(cd "$DEST/code" && /usr/bin/sudo -u "$ACCOUNT" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module -e 'await Promise.all(["broker-paths.mjs","capabilities.mjs","core.mjs","device-auth.mjs","device-client.mjs","http.mjs","human-session.mjs","msgvault-argv.mjs","msgvault-runner.mjs","msgvault.mjs","node-policy.mjs","node-session.mjs","origins.mjs","passkey-admin-socket.mjs","passkey-approval.mjs","passkey-http.mjs","policy.mjs","protected-path.mjs","slack.mjs","socket-listener.mjs","state-store.mjs"].map(name=>import("./"+name)))')
umask 077
read -r -s -p 'New Slack user OAuth token (input hidden): ' TOKEN; echo
[[ $TOKEN == xoxp-* ]] || { echo 'Expected xoxp user token'; exit 1; }
printf '%s' "$TOKEN" > "$DEST/state/slack-token"; unset TOKEN
read -r -s -p 'Choose a random one-use device pairing secret (input hidden): ' BOOTSTRAP; echo
[[ ${#BOOTSTRAP} -ge 32 ]] || { echo 'Use at least 32 characters'; exit 1; }
BOOTSTRAP_HASH=$(printf '%s' "$BOOTSTRAP" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module -e 'import{createHash}from"node:crypto";let s="";for await(const c of process.stdin)s+=c;console.log(createHash("sha256").update(s).digest("base64url"))'); unset BOOTSTRAP
printf '{}' > "$DEST/state/state.json"
"$CHOWN" "$ACCOUNT:$BROKER_GROUP" "$DEST/state/"*
# Copy the TLS material into a directory agents cannot traverse.
/usr/bin/install -o "$ACCOUNT" -g "$BROKER_GROUP" -m 600 "$KEY" "$DEST/state/tls.key"
/usr/bin/install -o "$ACCOUNT" -g "$BROKER_GROUP" -m 600 "$CERT" "$DEST/state/tls.crt"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module - "$ORIGIN" "$TEAM" "$BOOTSTRAP_HASH" "$MUXPAD_UI" "$DEST" > "$DEST/config.json" <<'JS'
const [origin, teamID, bootstrapHash, muxpadURL, base] = process.argv.slice(2); const u = new URL(origin); const ui = new URL(muxpadURL);
if (u.protocol !== 'https:' || origin !== u.origin || ui.protocol !== 'https:' || ui.hostname === u.hostname || ui.username || ui.password || ui.hash) throw Error('Use an HTTPS origin without a path');
console.log(JSON.stringify({ origin, rpID:u.hostname, teamID, bootstrapHash, approvalMode:'session', muxpadURL, port:9443, autoRead:false, channels:[], tokenPath:base+'/state/slack-token', statePath:base+'/state/state.json', tlsKeyPath:base+'/state/tls.key', tlsCertPath:base+'/state/tls.crt' }, null, 2));
JS
strip_acls -R "$DEST"
/bin/chmod 644 "$DEST/config.json"
if [[ $OS == darwin ]]; then
/bin/cat > "$SERVICE_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>org.muxpad.broker</string>
<key>UserName</key><string>$ACCOUNT</string>
<key>ProgramArguments</key><array><string>$RUNTIME</string><string>$DEST/code/main.mjs</string><string>$DEST/config.json</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DEST/state/broker.log</string>
<key>StandardErrorPath</key><string>$DEST/state/broker.err</string>
</dict></plist>
PLIST
else
systemd_unit "$RUNTIME" "$DEST/code/main.mjs" "$DEST/config.json" > "$SERVICE_FILE"
fi
strip_acls "$SERVICE_FILE"
/bin/chmod 644 "$SERVICE_FILE"
check_path "$SERVICE_FILE"
# Check effective access as the actual agent UID, not just numeric mode bits.
for private_file in "$DEST/state/slack-token" "$DEST/state/state.json" "$DEST/state/tls.key"; do
  if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -r "$private_file"; then echo 'Agent account can read protected state; refusing activation'; exit 1; fi
done
for protected_path in "$DEST" "$DEST/code" "$DEST/code/main.mjs" "$DEST/config.json" "$RUNTIME"; do
  if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -w "$protected_path"; then echo 'Agent account can change the protected installation; refusing activation'; exit 1; fi
done
service_start
echo "Installed. Configure protected forwarding to loopback 9443; then open $ORIGIN yourself in your own device browser."
echo 'Pair once there. That muxpad screen then opens a one-click approval modal automatically.'
echo 'Never pair an agent browser or a browser/profile agents can read or drive.'
