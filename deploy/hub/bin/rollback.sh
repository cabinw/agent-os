#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly ADMIN_ENTRY_SOURCE="${BASH_SOURCE[0]}"
if [[ -n "${AGENT_OS_DEPLOY_TEST_ROOT:-}" ]]; then
  [[ "${AGENT_OS_DEPLOY_TEST_MODE:-}" == 1 ]] || {
    printf '%s\n' 'Hub admin entry rejected: test mode is invalid' >&2
    exit 1
  }
  ((EUID != 0)) || {
    printf '%s\n' 'Hub admin entry rejected: test mode must never run as root' >&2
    exit 1
  }
  admin_bin="${AGENT_OS_DEPLOY_TEST_ROOT}/usr/libexec/agent-os/hub/bin"
else
  admin_bin=/usr/libexec/agent-os/hub/bin
fi
[[ "$ADMIN_ENTRY_SOURCE" == "$admin_bin/rollback.sh" ]] || {
  printf '%s\n' 'Hub admin entry rejected: run rollback from the fixed admin kit' >&2
  exit 1
}

admin_entry_fail() {
  printf 'Hub admin entry rejected: %s\n' "$1" >&2
  exit 1
}

admin_entry_stat_value() {
  local gnu_format=$1 bsd_format=$2 path=$3
  [[ -x /usr/bin/stat ]] || return 1
  if /usr/bin/stat -c "$gnu_format" "$path" >/dev/null 2>&1; then
    /usr/bin/stat -c "$gnu_format" "$path"
  else
    /usr/bin/stat -f "$bsd_format" "$path"
  fi
}

admin_entry_mode_is_safe() {
  local mode=$1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 8#022) == 0))
}

admin_entry_trusted_object() {
  local kind=$1 path=$2 expected_uid=$3 owner mode
  [[ ! -L "$path" ]] || admin_entry_fail 'preflight path contains a symbolic link'
  case "$kind" in
    directory) [[ -d "$path" ]] || admin_entry_fail 'preflight directory is missing' ;;
    file) [[ -f "$path" ]] || admin_entry_fail 'preflight file is missing' ;;
    *) admin_entry_fail 'internal preflight object kind is invalid' ;;
  esac
  owner="$(admin_entry_stat_value '%u' '%u' "$path")" ||
    admin_entry_fail 'preflight path ownership cannot be inspected'
  mode="$(admin_entry_stat_value '%a' '%Lp' "$path")" ||
    admin_entry_fail 'preflight path mode cannot be inspected'
  [[ "$owner" == "$expected_uid" ]] || admin_entry_fail 'preflight path has the wrong owner'
  admin_entry_mode_is_safe "$mode" ||
    admin_entry_fail 'preflight path is group/world writable'
}

if [[ -n "${AGENT_OS_DEPLOY_TEST_ROOT:-}" ]]; then
  [[ "$AGENT_OS_DEPLOY_TEST_ROOT" == /* && "$AGENT_OS_DEPLOY_TEST_ROOT" != / && \
    "$AGENT_OS_DEPLOY_TEST_ROOT" != *'//'* && \
    "$AGENT_OS_DEPLOY_TEST_ROOT" != *$'\n'* && \
    -d "$AGENT_OS_DEPLOY_TEST_ROOT" && ! -L "$AGENT_OS_DEPLOY_TEST_ROOT" ]] ||
    admin_entry_fail 'test root must be a non-root canonical absolute directory'
  case "/$AGENT_OS_DEPLOY_TEST_ROOT/" in
    */../* | */./*) admin_entry_fail 'test root contains dot path components' ;;
  esac
  canonical_test_root="$(
    CDPATH= cd -P -- "$AGENT_OS_DEPLOY_TEST_ROOT" 2>/dev/null && pwd -P
  )" || admin_entry_fail 'test root cannot be canonicalized'
  [[ "$canonical_test_root" == "$AGENT_OS_DEPLOY_TEST_ROOT" ]] ||
    admin_entry_fail 'test root contains a symbolic or non-canonical component'
  marker="$AGENT_OS_DEPLOY_TEST_ROOT/.agent-os-deploy-test-root"
  nonce="${AGENT_OS_DEPLOY_TEST_NONCE:-}"
  [[ "$nonce" =~ ^[A-Za-z0-9_-]{32,128}$ ]] ||
    admin_entry_fail 'test root nonce is missing or invalid'
  [[ -f "$marker" && ! -L "$marker" && "$(<"$marker")" == "$nonce" ]] ||
    admin_entry_fail 'test root marker is missing or invalid'
  marker_mode="$(admin_entry_stat_value '%a' '%Lp' "$marker")"
  marker_uid="$(admin_entry_stat_value '%u' '%u' "$marker")"
  [[ "$marker_mode" == 600 && "$marker_uid" == "$EUID" ]] ||
    admin_entry_fail 'test root marker ownership or mode is invalid'
  admin_entry_expected_uid=$EUID
  admin_entry_directories=(
    "$AGENT_OS_DEPLOY_TEST_ROOT"
    "$AGENT_OS_DEPLOY_TEST_ROOT/usr"
    "$AGENT_OS_DEPLOY_TEST_ROOT/usr/libexec"
    "$AGENT_OS_DEPLOY_TEST_ROOT/usr/libexec/agent-os"
    "$AGENT_OS_DEPLOY_TEST_ROOT/usr/libexec/agent-os/hub"
    "$admin_bin"
  )
else
  admin_entry_expected_uid=0
  admin_entry_directories=(
    /
    /usr
    /usr/libexec
    /usr/libexec/agent-os
    /usr/libexec/agent-os/hub
    "$admin_bin"
  )
fi
for admin_entry_directory in "${admin_entry_directories[@]}"; do
  admin_entry_trusted_object directory "$admin_entry_directory" "$admin_entry_expected_uid"
done
readonly ADMIN_ENTRY_GUARD="$admin_bin/admin-entry-guard.sh"
admin_entry_trusted_object file "$ADMIN_ENTRY_SOURCE" "$admin_entry_expected_uid"
admin_entry_trusted_object file "$ADMIN_ENTRY_GUARD" "$admin_entry_expected_uid"
[[ -x "$ADMIN_ENTRY_GUARD" ]] || admin_entry_fail 'fixed entry guard is not executable'
/bin/bash -p "$ADMIN_ENTRY_GUARD" "$ADMIN_ENTRY_SOURCE"
readonly SCRIPT_DIR="$admin_bin"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

target=
current_revision=
previous_revision=
state_before=
maintenance_enabled=false
operation_succeeded=false
operation_transaction=

usage() {
  printf '%s\n' 'usage: rollback.sh [--revision ID]' >&2
}

recover_failed_commit() {
  local recovery_ok=true state_after=
  (stop_and_prove_writer_stopped) >/dev/null 2>&1 || recovery_ok=false
  if [[ -n "$state_before" ]]; then
    state_after="$(state_fingerprint 2>/dev/null || true)"
  fi
  if [[ "$recovery_ok" == true && -n "$current_revision" ]]; then
    if ! (activate_revision "$current_revision") >/dev/null; then recovery_ok=false; fi
    if ! (record_previous_revision "$previous_revision") >/dev/null; then recovery_ok=false; fi
    service_control daemon-reload >/dev/null 2>&1 || recovery_ok=false
  fi
  if [[
    "$recovery_ok" == true &&
    -n "$state_before" &&
    -n "$state_after" &&
    "$state_before" == "$state_after"
  ]]; then
    if [[ "$recovery_ok" == true ]] &&
      (start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION") \
        >/dev/null 2>&1 &&
      (health_gate live) >/dev/null 2>&1 &&
      (service_enable) >/dev/null 2>&1 &&
      (maintenance_off) >/dev/null 2>&1; then
      maintenance_enabled=false
      notice rollback_recovery ok
      return 0
    fi
  fi
  service_control stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  (maintenance_fail_closed) >/dev/null 2>&1 || true
  printf '%s\n' \
    'Hub rollback recovery incomplete: service is stopped and maintenance remains enabled; restore the stopped-state snapshot explicitly' >&2
  return 1
}

finish() {
  local result=$?
  trap - EXIT
  if [[ "$operation_succeeded" != true && \
    ("$DURABLE_RECOVERY_ACTIVE" == true || "$maintenance_enabled" == true) ]]; then
    recover_failed_commit || result=1
  fi
  exit "$result"
}
trap finish EXIT

while (($# > 0)); do
  case "$1" in
    --revision)
      (($# >= 2)) || { usage; exit 2; }
      target=$2
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

require_privilege
require_fixed_admin_execution
require_commands mv ln readlink date
require_pinned_node
acquire_deploy_lock
require_clean_maintenance_state
ensure_layout
require_installed_runtime_contract
AGENT_OS_NODE_BIN="$NODE_BIN" "$ADMIN_ROOT/bin/validate-config.sh" "$ENV_FILE"

current_revision="$(read_revision_link "$CURRENT_LINK")" || die 'no active release is installed'
previous_revision="$(read_revision_link "$PREVIOUS_LINK" 2>/dev/null || true)"
if [[ -z "$target" ]]; then
  target="$previous_revision"
  [[ -n "$target" ]] || die 'no previous release is recorded'
fi
validate_revision "$target"
[[ "$target" != "$current_revision" ]] || die 'rollback target is already active'
[[ -d "$RELEASES_ROOT/$target" && ! -L "$RELEASES_ROOT/$target" ]] ||
  die 'rollback target is not an installed immutable release'

health_gate quiescent || die 'Hub has assigned, running, queued or inflight work'
operation_transaction="rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
durable_recovery_on state-rollback prepared "$operation_transaction"
maintenance_on_for_recovery
maintenance_enabled=true
if ! health_gate quiescent; then
  maintenance_off
  maintenance_enabled=false
  die 'Hub stopped being quiescent before the consistency point'
fi
stop_and_prove_writer_stopped ||
  die 'could not stop the active writer or prove its cgroup and state descriptors clear'
state_before="$(state_fingerprint)" || die 'could not fingerprint stopped state'
measurement="$($NODE_BIN "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT")" ||
  die 'state measurement failed'
read -r required_bytes required_inodes < <(
  "$NODE_BIN" -e \
    'const v=JSON.parse(process.argv[1]); process.stdout.write(`${v.totalBytes} ${v.entryCount}\n`)' \
    "$measurement"
)
"$NODE_BIN" "$ADMIN_ROOT/bin/capacity-check.mjs" \
  --state "$STATE_ROOT" \
  --backup "$BACKUP_ROOT" \
  --required-bytes "$required_bytes" \
  --required-inodes "$required_inodes" >/dev/null ||
  die 'pre-rollback snapshot capacity gate failed'
snapshot_path="$BACKUP_ROOT/pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)-${target}-$$"
[[ ! -e "$snapshot_path" && ! -L "$snapshot_path" ]] ||
  die 'pre-rollback snapshot destination already exists'
"$ADMIN_ROOT/pre-upgrade-snapshot" "$STATE_ROOT" "$snapshot_path" >/dev/null ||
  die 'pre-rollback snapshot failed'
"$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" verify "$snapshot_path" >/dev/null ||
  die 'pre-rollback snapshot verification failed'
[[ "$(state_fingerprint)" == "$state_before" ]] ||
  die 'pre-rollback snapshot changed stopped source state'
activate_revision "$target"
service_control daemon-reload
start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
  die 'rollback target failed its authorized start'
health_gate live || die 'rollback target failed exact liveness'
service_enable
record_previous_revision "$current_revision"
maintenance_off
maintenance_enabled=false
operation_succeeded=true
notice rollback ok
