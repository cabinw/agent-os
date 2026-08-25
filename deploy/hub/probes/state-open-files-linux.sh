#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin
readonly PATH
LC_ALL=C
readonly LC_ALL

mode=${1:-}
script_path=$(/usr/bin/realpath -- "${BASH_SOURCE[0]}")
probe_source_root=$(/usr/bin/dirname -- "$script_path")
source_root=$(/usr/bin/realpath -- "$probe_source_root/..")
helper="$source_root/bin/state-open-files.mjs"
holder_source="$probe_source_root/state-open-files-linux-holder.c"
between_scans="$probe_source_root/state-open-files-between-scans.mjs"
node_bin=/usr/bin/node
cc_bin=/usr/bin/cc
probe_root=
holder_pid=
probe_unit=

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ -n "$holder_pid" && "$holder_pid" =~ ^[1-9][0-9]*$ ]]; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  if [[ -n "$probe_unit" ]]; then
    /usr/bin/systemctl stop "$probe_unit" >/dev/null 2>&1 || true
    /usr/bin/systemctl reset-failed "$probe_unit" >/dev/null 2>&1 || true
  fi
  if [[ -n "$probe_root" && "$probe_root" == /tmp/agent-os-openfd-probe.* && -d "$probe_root" ]]; then
    chmod -R u+rwX "$probe_root" 2>/dev/null || true
    rm -rf -- "$probe_root"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

fail() {
  printf 'probe_ok=false reason=%s\n' "$1" >&2
  exit 1
}

assert_trusted_ancestor_chain() {
  local current=$1 metadata owner mode
  current=$(/usr/bin/dirname -- "$current")
  while :; do
    [[ -d "$current" && ! -L "$current" ]] || fail untrusted_source_ancestor
    metadata=$(/usr/bin/stat -c '%u %a' -- "$current") || fail untrusted_source_ancestor
    read -r owner mode <<<"$metadata"
    [[ "$owner" == 0 ]] || fail untrusted_source_ancestor
    (( (8#$mode & 0022) == 0 )) || fail untrusted_source_ancestor
    [[ "$current" == / ]] && break
    current=$(/usr/bin/dirname -- "$current")
  done
}

assert_trusted_source_file() {
  local path=$1 metadata owner mode links
  [[ "$path" == /* && -f "$path" && ! -L "$path" ]] || fail untrusted_source_file
  [[ "$(/usr/bin/realpath -- "$path")" == "$path" ]] || fail untrusted_source_file
  metadata=$(/usr/bin/stat -c '%u %a %h' -- "$path") || fail untrusted_source_file
  read -r owner mode links <<<"$metadata"
  [[ "$owner" == 0 && "$links" == 1 ]] || fail untrusted_source_file
  (( (8#$mode & 0022) == 0 )) || fail untrusted_source_file
  assert_trusted_ancestor_chain "$path"
}

[[ "$mode" == chroot || "$mode" == otmpfile || "$mode" == cgroup ]] || {
  printf 'usage: %s chroot|otmpfile|cgroup\n' "${0##*/}" >&2
  exit 2
}
[[ "$(id -u)" == 0 ]] || fail root_required
[[ -x "$node_bin" && -x "$cc_bin" && -f "$helper" && -f "$holder_source" ]] ||
  fail dependency_missing
for trusted_source in "$script_path" "$helper" "$holder_source" "$between_scans"; do
  assert_trusted_source_file "$trusted_source"
done

probe_root=$(mktemp -d /tmp/agent-os-openfd-probe.XXXXXX)
chmod 0700 "$probe_root"
state_root="$probe_root/state"
mkdir -m 0700 "$state_root"
printf '%s\n' '{"probe":true}' >"$state_root/opaque.json"
chmod 0600 "$state_root/opaque.json"
filesystem_type=$(/usr/bin/findmnt -n -o FSTYPE --target "$state_root")
[[ "$filesystem_type" == ext4 ]] || fail unsupported_state_filesystem
"$cc_bin" -O2 -Wall -Wextra -Werror \
  "$holder_source" -o "$probe_root/holder"
chmod 0700 "$probe_root/holder"
service_uid=$(id -u nobody)
[[ "$service_uid" =~ ^[1-9][0-9]*$ ]] || fail service_uid_unavailable
absent_cgroup="/system.slice/agent-os-openfd-absent-$$.service"

wait_for_line() {
  local path=$1 expected=$2 index
  for index in {1..500}; do
    if [[ -f "$path" ]] && /usr/bin/grep -qx "$expected" "$path"; then return 0; fi
    /bin/sleep 0.01
  done
  return 1
}

wait_for_cgroup_populated() {
  local events=$1 index
  for index in {1..500}; do
    if [[ -f "$events" ]] && /usr/bin/grep -qx 'populated 1' "$events"; then return 0; fi
    /bin/sleep 0.01
  done
  return 1
}

run_chroot_probe() {
  "$probe_root/holder" chroot "$state_root" >"$probe_root/holder.log" 2>"$probe_root/holder.err" &
  holder_pid=$!
  wait_for_line "$probe_root/holder.log" READY || fail chroot_holder_not_ready
  set +e
  "$node_bin" "$helper" "$state_root" \
    --forbidden-cgroup "$absent_cgroup" --service-uid "$service_uid" \
    --unit-inactive-proof inactive-mainpid0 >"$probe_root/result.json" 2>"$probe_root/helper.err"
  helper_status=$?
  set -e
  [[ "$helper_status" == 1 ]] || fail chroot_not_rejected
  "$node_bin" -e '
    const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(value.ok!==false||value.processRootDetected!==true||value.inspectionComplete!==true)process.exit(1)
  ' "$probe_root/result.json" || fail chroot_result_invalid
  printf 'probe=chroot ok=true rejected=true process_root_detected=true\n'
}

run_tmpfile_probe() {
  trigger="$probe_root/link.trigger"
  published="$state_root/probe-published"
  "$probe_root/holder" tmpfile "$state_root" "$trigger" \
    >"$probe_root/holder.log" 2>"$probe_root/holder.err" &
  holder_pid=$!
  wait_for_line "$probe_root/holder.log" READY || fail tmpfile_holder_not_ready
  "$node_bin" "$between_scans" "$helper" "$state_root" "$absent_cgroup" \
    "$service_uid" "$trigger" "$published" >"$probe_root/result.json" \
    2>"$probe_root/helper.err" || fail tmpfile_not_rejected
  "$node_bin" -e '
    const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(value.ok!==false||value.linked!==true||value.failClosedReason!=="state_root_changed"||value.scanCount!==2)process.exit(1)
  ' "$probe_root/result.json" || fail tmpfile_result_invalid
  printf 'probe=otmpfile ok=true linked_between_scans=true fail_closed=state_root_changed\n'
}

run_cgroup_probe() {
  probe_unit="agent-os-openfd-probe-$PPID-$$.service"
  /usr/bin/systemd-run --collect --unit "$probe_unit" --property "User=nobody" \
    --property "Type=simple" /bin/sleep infinity >/dev/null
  /usr/bin/systemctl is-active --quiet "$probe_unit" || fail cgroup_unit_not_active
  wait_for_cgroup_populated "/sys/fs/cgroup/system.slice/$probe_unit/cgroup.events" ||
    fail cgroup_unit_not_populated
  set +e
  "$node_bin" "$helper" "$state_root" --forbidden-cgroup "/system.slice/$probe_unit" \
    --service-uid "$service_uid" >"$probe_root/active.json" 2>"$probe_root/active.err"
  active_status=$?
  set -e
  [[ "$active_status" == 1 ]] || fail active_cgroup_not_rejected
  "$node_bin" -e '
    const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(value.ok!==false||value.cgroupPopulatedDetected!==true)process.exit(1)
  ' "$probe_root/active.json" || fail active_cgroup_result_invalid
  /usr/bin/systemctl stop "$probe_unit"
  for _ in {1..500}; do
    [[ ! -e "/sys/fs/cgroup/system.slice/$probe_unit" ]] && break
    /bin/sleep 0.01
  done
  [[ ! -e "/sys/fs/cgroup/system.slice/$probe_unit" ]] || fail cgroup_not_trimmed
  "$node_bin" "$helper" "$state_root" --forbidden-cgroup "/system.slice/$probe_unit" \
    --service-uid "$service_uid" --unit-inactive-proof inactive-mainpid0 \
    >"$probe_root/stopped.json" 2>"$probe_root/stopped.err" || fail stopped_cgroup_not_clean
  "$node_bin" -e '
    const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(value.ok!==true||value.cgroupDirectoryAbsent!==true||value.inspectionComplete!==true)process.exit(1)
  ' "$probe_root/stopped.json" || fail stopped_cgroup_result_invalid
  printf 'probe=cgroup ok=true active_rejected=true trimmed=true stopped_clean=true\n'
}

case "$mode" in
  chroot) run_chroot_probe ;;
  otmpfile) run_tmpfile_probe ;;
  cgroup) run_cgroup_probe ;;
esac
