#!/bin/bash
# Run only from a reviewed release frozen in a root-owned directory.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
set -euo pipefail
[[ $(/usr/bin/id -u) == 0 ]] || { echo 'Administrator authorization required'; exit 1; }
[[ $# == 0 || ( $# == 1 && $1 == --locked ) ]] || { echo 'Invalid arguments'; exit 1; }
umask 077
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
SOURCE=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
check_path() {
 local path=$1 owner mode
 [[ $path == /* && -e $path && ! -L $path ]] || { echo "Not a protected path: $path"; exit 1; }
 while [[ $path != / ]]; do
  [[ ! -L $path ]] || { echo 'Symlink in protected path'; exit 1; }
  owner=$(file_owner "$path"); mode=$(file_mode "$path")
  [[ $owner == 0 ]] && (( (8#$mode & 0022) == 0 )) || { echo "Unprotected path: $path"; exit 1; }
  if extra_grants "$path"; then echo 'ACL on protected path'; exit 1; fi
  path=$(/usr/bin/dirname "$path")
 done
}
# ── THE TREE WALK, IN ONE PROCESS ────────────────────────────────────────
# `check_path` above forks `stat` twice, `ls -lde` once and `dirname` once for
# EVERY ANCESTOR of EVERY FILE. Over the installed tree — ~1,450 files, up to
# twelve deep — that is ~28,000 processes and 10–12 minutes per pass, which is
# how two updates came to be abandoned halfway and left the broker disabled.
#
# This does the identical walk in a single node process: one lstat per path
# (no fork), ancestors memoised because they are shared, and ONE batched
# `ls -lde` per 160 paths for the ACL check. Measured: 1,453 paths in 0.12s.
#
# IT IS NOT WEAKER. Same five refusals — symlink, wrong owner, group/other
# write, hardlinked regular file, ACL — plus the same "unexpected file type".
# Proved against the original on a matrix of clean/symlink/group-writable/
# other-writable/hardlink/ACL-on-file/ACL-on-dir/fifo: both allow the clean
# tree and refuse all seven, every time.
#
# EMBEDDED, not a file in the release. A separate script would have to be
# validated before it could be trusted to validate anything, which is the
# bootstrap problem this avoids: bash validates the node BINARY, and this
# program travels inside the already-validated update-code.sh.
#
# The bash `check_path` stays for the handful of single paths checked before
# the runtime is trusted — four files, a few dozen forks.
check_tree() {
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - 0 -- "$@" <<'JS'
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const argv=process.argv.slice(2);
// Owners as an ARGUMENT, never an environment variable: this runs under
// `env -i` and update-code.sh owns the argv, so nothing a caller sets widens it.
const OWNERS=new Set(String(argv.shift()??'0').split(',').map(Number));
const cut=argv.indexOf('--');
const roots=cut===-1?argv:argv.slice(0,cut);
const trees=cut===-1?[]:argv.slice(cut+1);
const die=(m)=>{console.error(m);process.exit(1)};
const seen=new Set();const all=[];
function judge(path,recurse){
 if(seen.has(path))return;seen.add(path);
 // A newline would break the batched `ls` parse below. Nothing in a release
 // has one, and refusing is the safe direction.
 if(/[\n\r]/.test(path))die('Newline in protected path');
 let st;try{st=lstatSync(path)}catch{die('Not a protected path: '+path)}
 if(st.isSymbolicLink())die('Symlink in protected path: '+path);
 if(!st.isFile()&&!st.isDirectory())die('Unexpected file type: '+path);
 if(!OWNERS.has(st.uid)||st.mode&0o022)die('Unprotected path: '+path);
 if(st.isFile()&&st.nlink!==1)die('Hardlink refused: '+path);
 all.push(path);
 const parent=dirname(path);
 if(parent!==path&&path!=='/')judge(parent,false);
 if(recurse&&st.isDirectory())for(const n of readdirSync(path))judge(resolve(path,n),true);
}
for(const p of roots){if(!p.startsWith('/'))die('Not a protected path: '+p);judge(p,false)}
for(const t of trees){if(!t.startsWith('/'))die('Not a protected path: '+t);judge(t,true)}
const CHUNK=160;
// LINUX: the same two mechanisms protected-path.mjs refuses, batched the same
// way. `getfacl --skip-base` prints nothing for a path whose ACL only mirrors
// its mode, and `getcap` nothing for a path without capabilities, so ANY
// output is a refusal. Unlike `ls` on macOS, a failing tool is not read as an
// answer: it stops the update.
const tool=(name)=>['/usr/bin','/bin','/usr/sbin','/sbin'].map(d=>d+'/'+name).find(p=>existsSync(p))??die('Protected update requires '+name+' (install the acl and libcap2-bin packages)');
const inspect=(name,args)=>{try{return execFileSync(tool(name),args,{encoding:'utf8',maxBuffer:64<<20,stdio:['ignore','pipe','ignore']})}catch{die('Could not inspect '+name)}};
for(let i=0;i<all.length;i+=CHUNK){
 const batch=all.slice(i,i+CHUNK);let out;
 if(process.platform==='linux'){
  out=inspect('getfacl',['--absolute-names','--skip-base','--',...batch]);
  if(out.trim())die('ACL on protected path: '+(/^# file: (.*)$/m.exec(out)?.[1]??'unknown'));
  out=inspect('getcap',['--',...batch]);
  if(out.trim())die('File capabilities on protected path: '+out.trim().split('\n')[0]);
  continue;
 }
 try{out=execFileSync('/bin/ls',['-lde','--',...batch],{encoding:'utf8',maxBuffer:64<<20})}
 catch(e){out=String(e.stdout??'');if(!out)die('Could not inspect ACLs')}
 let current='';
 for(const line of out.split('\n')){
  if(/^\s*\d+:\s/.test(line))die('ACL on protected path: '+current.trim());
  if(line.trim())current=line;
 }
}
JS
}
check_path "$SOURCE/update-code.sh"
check_path "$DEST/code"
check_path "$DEST/runtime/node"
check_path "$SERVICE_FILE"
if [[ -e $DEST/code-update.lock || -L $DEST/code-update.lock ]]; then
 check_path "$DEST/code-update.lock"
 [[ $(link_count "$DEST/code-update.lock") == 1 ]] || { echo 'Hardlinked lock refused'; exit 1; }
fi
if [[ $# == 0 ]]; then
 # Non-blocking and kept on both: lockf -k -t 0 on macOS, flock -n on Linux
 # (util-linux; it never removes the file either).
 if [[ $OS == darwin ]]; then
  exec /usr/bin/lockf -k -t 0 "$DEST/code-update.lock" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash --noprofile --norc "$SOURCE/update-code.sh" --locked
 fi
 exec /usr/bin/flock --nonblock "$DEST/code-update.lock" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash --noprofile --norc "$SOURCE/update-code.sh" --locked
fi
# Validate existing runtime/code and the source before any service interruption.
for tree in "$SOURCE" "$DEST/code"; do
 check_tree "$tree" || exit 1
done
FILES=(broker-paths.mjs capabilities.mjs client.js core.mjs device-auth.mjs device-client.mjs http.mjs human-session.mjs main.mjs msgvault-argv.mjs msgvault-runner.mjs msgvault.mjs node-policy.mjs node-session.mjs origins.mjs page.html passkey-admin-socket.mjs passkey-approval.mjs passkey-http.mjs policy.mjs protected-path.mjs shell.css shell.html shell.js slack.mjs socket-listener.mjs state-store.mjs)
for file in "${FILES[@]}"; do
 [[ -f $SOURCE/$file ]] || { echo "Missing release file: $file"; exit 1; }
done
# The update marker pins retries to the same exact source contents.
RELEASE=$(for file in "${FILES[@]}" update-code.sh; do sha256 "$SOURCE/$file"; done | sha256 | /usr/bin/awk '{print $1}')
MARKER="$DEST/code-update"
# BEGIN COMPLETED RELEASE ROLLOVER
archive_completed_update() {
 local old_release archive part entry
 check_path "$MARKER"
 [[ $(link_count "$MARKER") == 1 ]] || { echo 'Hardlinked marker refused'; exit 1; }
 old_release=$(/usr/bin/sed -n '1p' "$MARKER")
 [[ $old_release =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid update marker'; exit 1; }
 if [[ $old_release == "$RELEASE" ]]; then return; fi
 [[ $(/usr/bin/sed -n '2p' "$MARKER") == ready ]] || { echo 'Unfinished update belongs to a different frozen release'; exit 1; }
 # Preserve completed backups instead of deleting/reusing them. Move the marker
 # last: interruption during either directory move resumes this same rollover.
 if [[ ! -e $DEST/completed-updates && ! -L $DEST/completed-updates ]]; then /bin/mkdir -m 700 "$DEST/completed-updates"; fi
 check_path "$DEST/completed-updates"
 archive="$DEST/completed-updates/$old_release"
 if [[ ! -e $archive && ! -L $archive ]]; then /bin/mkdir -m 700 "$archive"; fi
 check_path "$archive"
 [[ -d $archive && ! -e $archive/marker && ! -L $archive/marker ]] || { echo 'Conflicting completed update archive'; exit 1; }
 for part in code.previous code.next; do
  if [[ -e $DEST/$part || -L $DEST/$part ]]; then
   [[ ! -e $archive/$part && ! -L $archive/$part ]] || { echo 'Conflicting completed update tree'; exit 1; }
   entry="$DEST/$part"
  else
   entry="$archive/$part"
  fi
  [[ -d $entry ]] || { echo 'Missing completed update tree'; exit 1; }
  check_tree "$entry" || exit 1
  if [[ -e $DEST/$part ]]; then /bin/mv "$DEST/$part" "$archive/$part"; fi
 done
 /bin/mv "$MARKER" "$archive/marker"
}
if [[ -e $MARKER || -L $MARKER ]]; then archive_completed_update; fi
# END COMPLETED RELEASE ROLLOVER
if [[ ! -e $MARKER ]]; then
 [[ ! -e $DEST/code.previous && ! -L $DEST/code.previous ]] || { echo 'Previous backup exists without update marker; reconcile manually'; exit 1; }
 [[ ! -e $DEST/code.next && ! -L $DEST/code.next ]] || { echo 'Staging exists without update marker; reconcile manually'; exit 1; }
fi
phase() {
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$MARKER" "$RELEASE" "$1" <<'JS'
import {openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
const [path, release, phase] = process.argv.slice(2);
const temporary = `${path}.${process.pid}`;
const fd = openSync(temporary, 'wx', 0o600);
try { writeFileSync(fd, `${release}\n${phase}\n`); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(temporary,path);
const dir = openSync(dirname(path),'r');
try { fsyncSync(dir); } finally { closeSync(dir); }
JS
}
PHASE=$([[ -f $MARKER ]] && /usr/bin/sed -n '2p' "$MARKER" || echo preparing)
trap 'echo "Update incomplete. Rerun the SAME frozen update command to finish forward; do not restore older authentication code."' ERR
if [[ $PHASE == preparing ]]; then
 phase preparing
 # Partial backup/staging from interruption can be completed before any live writes.
 copy_tree "$DEST/code" "$DEST/code.previous"
 copy_tree "$DEST/code" "$DEST/code.next"
 for file in "${FILES[@]}"; do
  /usr/bin/install -o root -g "$ROOT_GROUP" -m 644 "$SOURCE/$file" "$DEST/code.next/$file"
 done
 strip_acls -R "$DEST/code.next"
 phase prepared
fi
# Validate all staged paths even during retry. No symlinks/hardlinks accepted.
for tree in "$DEST/code.previous" "$DEST/code.next"; do
 check_path "$tree"
 check_tree "$tree" || exit 1
done
for file in "${FILES[@]}"; do /usr/bin/cmp -s "$SOURCE/$file" "$DEST/code.next/$file"; done
# Complete dependency closure and private-file access, under the actual service UID.
/usr/bin/sudo -u "$ACCOUNT" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$EMPTY_HOME" "$DEST/runtime/node" "$DEST/code.next/main.mjs" "$DEST/config.json" --check
# launchctl disable persists across reboot, unlike bootout alone (and
# systemctl disable, unlike stop). Leave disabled on interruption until the
# same verified release has been completely installed.
phase inhibiting
service_disable
phase stopping
# ── BOOTOUT IS ASYNCHRONOUS, SO WAIT FOR IT ──────────────────────────────
# `launchctl bootout` returns before teardown finishes. The check used to run
# on the very next line, saw the service still loaded, and refused — leaving
# the broker booted out AND `launchctl disable`d, which persists across
# reboot, with the update half done. That happened on BOTH attempted runs and
# each one needed a second pass to recover.
#
# So the refusal is still there, and it now means what it says: thirty
# seconds of asking, not one look. Polling rather than sleeping, so the normal
# case costs a fraction of a second.
if service_loaded; then
 service_stop
fi
for _ in $(/usr/bin/seq 1 60); do
 service_loaded || break
 /bin/sleep 0.5
done
if service_loaded; then echo 'Broker still loaded after 30s; refusing live code writes'; exit 1; fi
phase installing
# Keep the fixed code directory present. An interrupted copy is completed by retry,
# while the daemon remains unloaded. Never automatically downgrade device state.
for file in "${FILES[@]}"; do
 /usr/bin/install -o root -g "$ROOT_GROUP" -m 644 "$DEST/code.next/$file" "$DEST/code/$file"
done
for file in "${FILES[@]}"; do /usr/bin/cmp -s "$DEST/code.next/$file" "$DEST/code/$file"; done
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$DEST/code" "${FILES[@]}" <<'JS'
import {openSync,fsyncSync,closeSync} from 'node:fs';
const [base,...names]=process.argv.slice(2);
for(const path of [...names.map(name=>`${base}/${name}`),base]) {
 const fd=openSync(path,'r');
 try { fsyncSync(fd); } finally { closeSync(fd); }
}
JS
phase installed
# Only complete, compared and durably written code may run after reboot.
phase starting
service_enable
service_start
ORIGIN=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$DEST/config.json" <<'JS'
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
const origin=c.transport==='tsnet'?readFileSync(c.originPath,'utf8').trim():c.origin;
const u=new URL(origin);
if(u.protocol!=='https:'||u.origin!==origin||!u.hostname.endsWith('.ts.net'))throw Error('Invalid readiness origin');
console.log(origin);
JS
)
# THE READINESS VERSIONS COME FROM THE RELEASE, NOT FROM A LITERAL HERE.
# This check asserted one hardcoded string and the shipped code had moved on,
# so a PERFECTLY GOOD update ended with "readiness is unconfirmed" and exit 1 —
# which reads exactly like a broken install and sent somebody re-running a
# frozen release against a broker that was already healthy.
#
# Replacing the literal with a newer literal would rebuild the same trap, and
# sooner than it looks: http.mjs reports a DIFFERENT version under
# `approvalMode: session` than under `passkey-inline`, so the next cutover
# would have failed this check in the middle of a security change.
ALLOWED=$(/usr/bin/grep -oE "'[A-Za-z0-9-]+-v[0-9]+-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]'" "$SOURCE/http.mjs" | /usr/bin/tr -d "'")
[[ -n $ALLOWED ]] || { echo 'No health version found in the release; refusing to guess'; exit 1; }
for attempt in {1..30}; do
 if /usr/bin/curl --silent --fail --max-time 2 "$ORIGIN/health" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;try{if(!process.argv.slice(1).includes(JSON.parse(s).version))process.exit(1)}catch{process.exit(1)}' $ALLOWED; then
  phase ready
  echo 'New popup broker is ready. Existing pairing and private state preserved.'
  exit 0
 fi
 /bin/sleep 1
done
echo 'Job loaded, but new broker readiness is unconfirmed. Rerun the same frozen command; do not restore older authentication code.'
exit 1
