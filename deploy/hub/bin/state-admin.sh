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
[[ "$ADMIN_ENTRY_SOURCE" == "$admin_bin/state-admin.sh" ]] || {
  printf '%s\n' 'Hub admin entry rejected: run state-admin from the fixed admin kit' >&2
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

action=${1:-}
label=
snapshot_id=
manifest_sha256=
maintenance_enabled=false
operation_succeeded=false
restore_started=false
restore_committed=false
old_state_moved=false
new_state_moved=false
state_before=
restore_staging=
retired_state=
failed_state=
transaction_id=
restore_was_active=false
restore_summary=
recover_transaction=
recover_old_started=false
parent_transaction=
recover_mode=
recover_finalize=false
recover_finalize_tree=
preservation_mode=
bound_recovery_transaction=
recover_terminal_ready=false
restore_terminal_ready=false
restore_terminal_transaction=

trace_restore_token_checkpoint() {
  local stage=$1 trace=${AGENT_OS_MOCK_RESTORE_TOKEN_TRACE:-}
  local call_label=${AGENT_OS_MOCK_RESTORE_TOKEN_CALL_LABEL:-unlabeled}
  local present=false type=missing uid=unavailable gid=unavailable
  local mode=unavailable links=unavailable value_sha256=unavailable
  [[ -n "$trace" ]] || return 0
  [[ -n "$TEST_ROOT" && "$stage" =~ ^[a-z][a-z0-9-]{0,47}$ && \
    "$call_label" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ && \
    "$trace" == "$TEST_ROOT"/* && -f "$trace" && ! -L "$trace" && \
    "$(stat_value '%u' '%u' "$trace")" == "$EUID" && \
    "$(stat_value '%a' '%Lp' "$trace")" == 600 && \
    "$(stat_value '%h' '%l' "$trace")" == 1 ]] ||
    die 'restore token trace fixture is unsafe'
  if [[ -e "$RECOVERY_START_PATH" || -L "$RECOVERY_START_PATH" ]]; then
    present=true
    type="$(stat_value '%F' '%HT' "$RECOVERY_START_PATH" 2>/dev/null || printf unavailable)"
    uid="$(stat_value '%u' '%u' "$RECOVERY_START_PATH" 2>/dev/null || printf unavailable)"
    gid="$(stat_value '%g' '%g' "$RECOVERY_START_PATH" 2>/dev/null || printf unavailable)"
    mode="$(stat_value '%a' '%Lp' "$RECOVERY_START_PATH" 2>/dev/null || printf unavailable)"
    links="$(stat_value '%h' '%l' "$RECOVERY_START_PATH" 2>/dev/null || printf unavailable)"
    if [[ -f "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]]; then
      value_sha256="$(
        "$NODE_BIN" -e \
          'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
          "$RECOVERY_START_PATH" 2>/dev/null || printf unavailable
      )"
    fi
  fi
  printf 'stage=%s call_label=%s pid=%s ppid=%s present=%s type=%s uid=%s gid=%s mode=%s links=%s value_sha256=%s\n' \
    "$stage" "$call_label" "$$" "$PPID" "$present" "$type" "$uid" \
    "$gid" "$mode" "$links" "$value_sha256" >>"$trace"
}

usage() {
  printf '%s\n' \
    'usage: state-admin.sh backup --label ID' \
    '       state-admin.sh restore --snapshot ID --manifest-sha256 HEX [--from-transaction ID]' \
    '       state-admin.sh recover-old --transaction restore-ID' \
    '       state-admin.sh capacity' >&2
}

validate_short_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$ ]] ||
    die 'operation id must be 1..48 filesystem-safe characters'
}

snapshot_path_for() {
  validate_revision "$1"
  printf '%s/%s\n' "$BACKUP_ROOT" "$1"
}

run_capacity_gate_at() {
  local state_path=$1
  shift
  "$NODE_BIN" "$ADMIN_ROOT/bin/capacity-check.mjs" \
    --state "$state_path" \
    --backup "$BACKUP_ROOT" \
    "$@"
}

run_capacity_gate() {
  run_capacity_gate_at "$STATE_ROOT" "$@"
}

verify_snapshot() {
  local path=$1 expected=${2:-}
  if [[ -n "$expected" ]]; then
    "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" \
      verify "$path" --manifest-sha256 "$expected"
  else
    "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" verify "$path"
  fi
}

restore_phase_is_visible() {
  local transaction=$1 phase=$2 transaction_root phase_path expected_uid=$EUID expected_gid
  expected_gid="$($ID_BIN -g)" || return 1
  [[ "$transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] || return 1
  case "$phase" in
    committed | rolled_back) ;;
    *) return 1 ;;
  esac
  transaction_root="$RECOVERY_ROOT/$transaction"
  phase_path="$transaction_root/$phase"
  [[ -d "$transaction_root" && ! -L "$transaction_root" && \
    -f "$phase_path" && ! -L "$phase_path" && \
    "$(stat_value '%u' '%u' "$transaction_root")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$transaction_root")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$transaction_root")" == 700 && \
    "$(stat_value '%u' '%u' "$phase_path")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$phase_path")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$phase_path")" == 400 && \
    "$(stat_value '%h' '%l' "$phase_path")" == 1 && \
    "$(<"$phase_path")" == \
      $'version=1\n'"transaction=$transaction"$'\n'"phase=$phase" ]]
}

recovery_gates_are_clean() {
  [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
    ! -e "$MAINTENANCE_PATH" && ! -L "$MAINTENANCE_PATH" && \
    ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" && \
    ! -e "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]]
}

mark_recover_old_complete() {
  maintenance_enabled=false
  recover_old_started=false
  operation_succeeded=true
}

mark_direct_restore_complete() {
  maintenance_enabled=false
  restore_started=false
  operation_succeeded=true
}

finish() {
  local result=$? writer_stopped=false recovery_authorized=false
  trap - EXIT TERM INT HUP
  if [[ "$restore_started" == true && "$transaction_id" =~ ^restore- ]] &&
    {
      [[ "${RESTORE_PHASE_DURABLE_TRANSACTION:-}" == "$transaction_id" && \
        "${RESTORE_PHASE_DURABLE:-}" == committed ]] ||
        restore_phase_is_visible "$transaction_id" committed
    }; then
    restore_committed=true
  fi
  if [[ "$operation_succeeded" != true && "$recover_old_started" == true && \
    "$recover_terminal_ready" == true && \
    "${MAINTENANCE_OFF_DURABLE:-false}" == true ]] && recovery_gates_are_clean; then
    mark_recover_old_complete
  fi
  if [[ "$operation_succeeded" != true && "$restore_started" == true && \
    "$restore_terminal_ready" == true && \
    "${MAINTENANCE_OFF_DURABLE:-false}" == true ]] && recovery_gates_are_clean; then
    mark_direct_restore_complete
  fi
  if [[ "$operation_succeeded" != true && "$recover_old_started" == true ]]; then
    (stop_and_prove_writer_stopped_for_path "$STATE_PARENT") >/dev/null 2>&1 || result=1
    service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    (maintenance_fail_closed state-recover-old-failed blocked) >/dev/null 2>&1 || true
    printf '%s\n' \
      'Hub old-state recovery incomplete: no preserved copy was deleted and persistent recovery blocking remains enabled' >&2
    result=1
  elif [[ "$operation_succeeded" != true && "$restore_started" == true ]]; then
    if (stop_and_prove_writer_stopped_for_path "$STATE_PARENT") >/dev/null 2>&1; then
      writer_stopped=true
    else
      result=1
    fi
    service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f -- "$RECOVERY_START_PATH" >/dev/null 2>&1 || true
    # Once the committed phase is durable, the target tree is authoritative.
    # A later health/enable/maintenance cleanup failure must never compensate
    # back to the previous tree; recover-old finalizes the committed journal.
    if [[ "$restore_committed" != true && "$writer_stopped" == true && \
      "$new_state_moved" == true && \
      -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]]; then
      if [[ ! -e "$failed_state" && ! -L "$failed_state" ]]; then
        if mv "$STATE_ROOT" "$failed_state" >/dev/null 2>&1; then
          fsync_path "$STATE_PARENT" >/dev/null 2>&1 || true
        fi
      fi
    fi
    if [[ "$restore_committed" != true && "$writer_stopped" == true && \
      "$old_state_moved" == true && \
      ! -e "$STATE_ROOT" && \
      -d "$retired_state" && ! -L "$retired_state" ]]; then
      if mv "$retired_state" "$STATE_ROOT" >/dev/null 2>&1; then
        fsync_path "$STATE_PARENT" >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$restore_committed" == true ]]; then
      (maintenance_fail_closed \
        state-restore-finalize-failed \
        committed \
        "${restore_terminal_transaction:-$transaction_id}") \
        >/dev/null 2>&1 || true
      printf '%s\n' \
        'Hub committed restore cleanup incomplete: the committed target was retained, the service was stopped and persistent recovery blocking remains enabled' >&2
    else
      (maintenance_fail_closed state-restore-failed blocked) >/dev/null 2>&1 || true
    fi
    if [[ "$restore_committed" != true && "$writer_stopped" == true ]]; then
      printf '%s\n' \
        'Hub state restore incomplete: service is stopped and persistent recovery blocking remains enabled' >&2
    elif [[ "$restore_committed" != true ]]; then
      printf '%s\n' \
        'Hub state restore incomplete: writer stop was not proven; no compensation rename was attempted and persistent recovery blocking remains enabled' >&2
    fi
    result=1
  elif [[ "$operation_succeeded" != true && "$maintenance_enabled" == true ]]; then
    local state_after=
    if (stop_and_prove_writer_stopped) >/dev/null 2>&1; then
      writer_stopped=true
      state_after="$(state_fingerprint 2>/dev/null || true)"
    else
      result=1
    fi
    if [[ "$writer_stopped" == true && -n "$state_before" && \
      "$state_after" == "$state_before" ]]; then
      recovery_authorized=true
    fi
    if [[ "$recovery_authorized" == true ]] &&
      (start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION") \
        >/dev/null 2>&1 &&
      (health_gate live) >/dev/null 2>&1 &&
      (service_enable) >/dev/null 2>&1 &&
      (maintenance_off) >/dev/null 2>&1; then
      maintenance_enabled=false
    else
      service_control stop "$SERVICE_NAME" >/dev/null 2>&1 || true
      service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
      (maintenance_fail_closed state-backup-failed blocked) >/dev/null 2>&1 || true
      result=1
    fi
  elif [[ "$operation_succeeded" != true && "$DURABLE_RECOVERY_ACTIVE" == true ]]; then
    (stop_and_prove_writer_stopped_for_path "$STATE_PARENT") >/dev/null 2>&1 || result=1
    service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    (maintenance_fail_closed state-operation-guard-failed blocked) >/dev/null 2>&1 || true
    printf '%s\n' \
      'Hub state operation failed after publishing its persistent guard; the writer was stopped and recovery blocking remains enabled' >&2
    result=1
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

shift || true
case "$action" in
  backup)
    while (($# > 0)); do
      case "$1" in
        --label)
          (($# >= 2)) || { usage; exit 2; }
          label=$2
          shift 2
          ;;
        *) usage; exit 2 ;;
      esac
    done
    [[ -n "$label" ]] || { usage; exit 2; }
    validate_short_id "$label"
    ;;
  restore)
    while (($# > 0)); do
      case "$1" in
        --snapshot)
          (($# >= 2)) || { usage; exit 2; }
          [[ -z "$snapshot_id" ]] || { usage; exit 2; }
          snapshot_id=$2
          shift 2
          ;;
        --manifest-sha256)
          (($# >= 2)) || { usage; exit 2; }
          [[ -z "$manifest_sha256" ]] || { usage; exit 2; }
          manifest_sha256=$2
          shift 2
          ;;
        --from-transaction)
          (($# >= 2)) || { usage; exit 2; }
          [[ -z "$parent_transaction" ]] || { usage; exit 2; }
          parent_transaction=$2
          shift 2
          ;;
        *) usage; exit 2 ;;
      esac
    done
    [[ -n "$snapshot_id" && -n "$manifest_sha256" ]] || { usage; exit 2; }
    validate_revision "$snapshot_id"
    validate_checksum "$manifest_sha256"
    manifest_sha256="$(printf '%s' "$manifest_sha256" | tr 'A-F' 'a-f')"
    if [[ -n "$parent_transaction" ]]; then
      [[ "$parent_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] || {
        usage
        exit 2
      }
    fi
    ;;
  recover-old)
    (($# == 2)) && [[ "$1" == --transaction ]] || { usage; exit 2; }
    recover_transaction=$2
    [[ "$recover_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] || {
      usage
      exit 2
    }
    ;;
  capacity)
    (($# == 0)) || { usage; exit 2; }
    ;;
  *) usage; exit 2 ;;
esac

require_privilege
require_fixed_admin_execution
require_commands install chmod mv date tr
require_pinned_node
acquire_deploy_lock

if [[ "$action" == restore ]]; then
  [[ "$parent_transaction" != restore-* ]] ||
    die 'an existing restore transaction must be continued with recover-old'
  selected_snapshot="$(snapshot_path_for "$snapshot_id")"
  restore_summary="$(verify_snapshot "$selected_snapshot" "$manifest_sha256")" ||
    die 'snapshot verification failed'
  ensure_layout
  read -r required_state_bytes required_state_inodes target_tree_sha256 < <(
    "$NODE_BIN" -e \
      'const v=JSON.parse(process.argv[1]); const n=v.files+v.directories; if(!Number.isSafeInteger(v.bytes)||v.bytes<0||!Number.isSafeInteger(n)||n<1||!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(`${v.bytes} ${n} ${v.treeSha256}\n`)' \
      "$restore_summary"
  ) || die 'snapshot capacity metadata is invalid'
  run_capacity_gate_at "$STATE_PARENT" \
    --required-state-bytes "$required_state_bytes" \
    --required-state-inodes "$required_state_inodes" >/dev/null
  if [[ -n "$parent_transaction" ]]; then
    [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
      "$(<"$DURABLE_BLOCK_PATH")" == \
        "agent-os-hub-recovery-block-v1:$parent_transaction" ]] ||
      die 'requested parent transaction does not match the persistent recovery block'
  else
    [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
      die 'an existing recovery block requires explicit --from-transaction binding'
  fi
elif [[ "$action" == recover-old ]]; then
  require_existing_recovery_layout
  [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
    die 'recover-old requires a regular persistent recovery block'
  bound_recovery_transaction="$(<"$DURABLE_BLOCK_PATH")"
  bound_recovery_transaction=${bound_recovery_transaction#agent-os-hub-recovery-block-v1:}
  [[ "$bound_recovery_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'recover-old persistent recovery block is invalid'
  if [[ "$bound_recovery_transaction" == "$recover_transaction" ]]; then
    DURABLE_BLOCK_TRANSACTION=$recover_transaction
  elif load_restore_intent "$recover_transaction" &&
    [[ "$RESTORE_INTENT_PARENT" == "$bound_recovery_transaction" ]]; then
    DURABLE_BLOCK_TRANSACTION=$bound_recovery_transaction
  else
    die 'recover-old transaction does not match the persistent recovery block'
  fi
  cleanup_restore_journal_temporaries "$recover_transaction"
  if validate_restore_journal "$recover_transaction"; then
    recover_mode=full
    if [[ "$bound_recovery_transaction" != "$recover_transaction" ]]; then
      [[ "$RESTORE_PARENT_TRANSACTION" == "$bound_recovery_transaction" ]] ||
        die 'restore recovery metadata does not match the persistent parent block'
      for phase_path in \
        prepared staged old_moved new_activated verified committed rolled_back aborted; do
        [[ ! -e "$RECOVERY_ROOT/$recover_transaction/$phase_path" && \
          ! -L "$RECOVERY_ROOT/$recover_transaction/$phase_path" ]] ||
          die 'an unchained restore journal cannot contain a published phase'
      done
      chain_recovery_block_to_restore \
        "$bound_recovery_transaction" \
        "$recover_transaction"
      bound_recovery_transaction=$recover_transaction
    fi
    [[ "$bound_recovery_transaction" == "$recover_transaction" ]] ||
      die 'recover-old transaction does not match the persistent recovery block'
    DURABLE_BLOCK_TRANSACTION=$recover_transaction
    if [[ -e "$RECOVERY_ROOT/$recover_transaction/committed" || \
      -e "$RECOVERY_ROOT/$recover_transaction/rolled_back" ]]; then
      recover_finalize=true
      if [[ -e "$RECOVERY_ROOT/$recover_transaction/committed" ]]; then
        recover_finalize_tree=$RESTORE_TARGET_TREE
      else
        [[ "$RESTORE_PRESERVATION_MODE" != forensic ]] ||
          die 'a corrupt forensic state can never be reactivated as a rollback'
        recover_finalize_tree=$RESTORE_PRESERVED_TREE
      fi
    elif [[ "$RESTORE_PRESERVATION_MODE" == forensic ]]; then
      recover_mode=forward
      snapshot_id=$RESTORE_TARGET_SNAPSHOT
      manifest_sha256=$RESTORE_TARGET_DIGEST
      selected_snapshot="$(snapshot_path_for "$snapshot_id")"
      restore_summary="$(verify_snapshot "$selected_snapshot" "$manifest_sha256")" ||
        die 'forensic forward target snapshot verification failed'
      read -r required_state_bytes required_state_inodes recovered_tree < <(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); const n=v.files+v.directories; if(!Number.isSafeInteger(v.bytes)||v.bytes<0||!Number.isSafeInteger(n)||n<1||!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(`${v.bytes} ${n} ${v.treeSha256}\n`)' \
          "$restore_summary"
      ) || die 'forensic forward target capacity metadata is invalid'
      [[ "$recovered_tree" == "$RESTORE_TARGET_TREE" ]] ||
        die 'forensic forward target tree does not match recovery metadata'
      preserved_snapshot="$(snapshot_path_for "$RESTORE_PRESERVED_SNAPSHOT")"
      forensic_summary="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-forensic.mjs" verify \
          "$preserved_snapshot" --manifest-sha256 "$RESTORE_PRESERVED_DIGEST"
      )" || die 'forensic preservation artifact verification failed'
      forensic_tree="$(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$forensic_summary"
      )" || die 'forensic preservation artifact metadata is invalid'
      [[ "$forensic_tree" == "$RESTORE_PRESERVED_TREE" ]] ||
        die 'forensic preservation artifact tree does not match recovery metadata'
      if [[ ! -e "$RECOVERY_ROOT/$recover_transaction/staged" && \
        ! -e "$STATE_PARENT/.hub.restore-$recover_transaction" && \
        ! -L "$STATE_PARENT/.hub.restore-$recover_transaction" ]]; then
        run_capacity_gate_at "$STATE_PARENT" \
          --required-state-bytes "$required_state_bytes" \
          --required-state-inodes "$required_state_inodes" >/dev/null
      fi
    else
      snapshot_id=$RESTORE_PRESERVED_SNAPSHOT
      manifest_sha256=$RESTORE_PRESERVED_DIGEST
      selected_snapshot="$(snapshot_path_for "$snapshot_id")"
      restore_summary="$(verify_snapshot "$selected_snapshot" "$manifest_sha256")" ||
        die 'preserved pre-restore snapshot verification failed'
      read -r required_state_bytes required_state_inodes recovered_tree < <(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); const n=v.files+v.directories; if(!Number.isSafeInteger(v.bytes)||v.bytes<0||!Number.isSafeInteger(n)||n<1||!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(`${v.bytes} ${n} ${v.treeSha256}\n`)' \
          "$restore_summary"
      ) || die 'preserved snapshot capacity metadata is invalid'
      [[ "$recovered_tree" == "$RESTORE_PRESERVED_TREE" ]] ||
        die 'preserved snapshot tree does not match recovery metadata'
      run_capacity_gate_at "$STATE_PARENT" \
        --required-state-bytes "$required_state_bytes" \
        --required-state-inodes "$required_state_inodes" >/dev/null
    fi
  elif validate_restore_orphan_intent "$recover_transaction"; then
    if [[ -e "$RECOVERY_ROOT/$recover_transaction/aborted" ]]; then
      recover_mode=orphan_finalize
    else
      recover_mode=orphan
    fi
    [[ "$RESTORE_INTENT_PARENT" == recovery-pre-* ]] ||
      die 'a parent failure transaction requires a new signed restore bound with --from-transaction'
    [[ "$bound_recovery_transaction" == "$RESTORE_INTENT_PARENT" ]] ||
      die 'orphan restore intent does not match the persistent recovery block'
    DURABLE_BLOCK_TRANSACTION=$RESTORE_INTENT_PARENT
  else
    die 'restore recovery journal is invalid'
  fi
else
  require_clean_maintenance_state
  ensure_layout
fi

AGENT_OS_NODE_BIN="$NODE_BIN" "$ADMIN_ROOT/bin/validate-config.sh" "$ENV_FILE"
if [[ "$action" != capacity ]]; then require_installed_runtime_contract; fi

case "$action" in
  capacity)
    run_capacity_gate
    operation_succeeded=true
    ;;
  backup)
    service_control is-active --quiet "$SERVICE_NAME" ||
      die 'staging backup requires an active Hub service'
    health_gate quiescent || die 'Hub has assigned, running, queued or inflight work'
    transaction_id="backup-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
    durable_recovery_on state-backup prepared "$transaction_id"
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
    run_capacity_gate \
      --required-bytes "$required_bytes" \
      --required-inodes "$required_inodes" >/dev/null
    snapshot_id="manual-${label}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    selected_snapshot="$(snapshot_path_for "$snapshot_id")"
    "$ADMIN_ROOT/pre-upgrade-snapshot" "$STATE_ROOT" "$selected_snapshot" >/dev/null
    verify_snapshot "$selected_snapshot" >/dev/null
    [[ "$(state_fingerprint)" == "$state_before" ]] ||
      die 'snapshot operation changed stopped source state'
    start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
      die 'Hub failed its authorized restart after backup'
    health_gate live || die 'Hub failed exact liveness after backup'
    service_enable
    maintenance_off
    maintenance_enabled=false
    operation_succeeded=true
    manifest_sha256="$(<"$selected_snapshot/manifest.sha256")"
    [[ "$manifest_sha256" =~ ^[a-f0-9]{64}$ ]] || die 'snapshot manifest digest is invalid'
    printf 'hub_state_backup status=ok snapshot=%s manifest_sha256=%s\n' \
      "$snapshot_id" "$manifest_sha256"
    ;;
  restore)
    if service_control is-active --quiet "$SERVICE_NAME"; then
      restore_was_active=true
      health_gate quiescent || die 'Hub has assigned, running, queued or inflight work'
    fi
    current_measurement="$($NODE_BIN "$ADMIN_ROOT/bin/tree-digest.mjs" "$STATE_ROOT")" ||
      die 'current state cannot be structurally measured for restore peak capacity'
    read -r current_required_bytes current_required_inodes current_raw_tree < <(
      "$NODE_BIN" -e \
        'const v=JSON.parse(process.argv[1]); if(!Number.isSafeInteger(v.totalBytes)||v.totalBytes<0||!Number.isSafeInteger(v.entryCount)||v.entryCount<1||!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(`${v.totalBytes} ${v.entryCount} ${v.treeSha256}\n`)' \
        "$current_measurement"
    ) || die 'current state peak-capacity metadata is invalid'
    run_capacity_gate_at "$STATE_PARENT" \
      --required-bytes "$current_required_bytes" \
      --required-inodes "$current_required_inodes" \
      --required-state-bytes "$required_state_bytes" \
      --required-state-inodes "$required_state_inodes" >/dev/null
    if [[ "$restore_was_active" != true ]]; then
      if inactive_preflight_measurement="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT" \
          2>&1
      )"; then
        :
      else
        case "$inactive_preflight_measurement" in
          'Hub state snapshot failed: active_tasks_present')
            die 'current state contains assigned, running or inflight work and cannot be restored automatically'
            ;;
          'Hub state snapshot failed: event_log_invalid' | \
            'Hub state snapshot failed: json_state_invalid' | \
            'Hub state snapshot failed: placement_invalid' | \
            'Hub state snapshot failed: request_ledger_invalid')
            ;;
          *)
            die 'inactive current state could not be safely classified before restore'
            ;;
        esac
      fi
    fi
    transaction_id="restore-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
    restore_staging="$STATE_PARENT/.hub.restore-$transaction_id"
    retired_state="$STATE_PARENT/hub.pre-restore-$transaction_id"
    failed_state="$STATE_PARENT/hub.failed-restore-$transaction_id"
    for path in "$restore_staging" "$retired_state" "$failed_state"; do
      [[ ! -e "$path" && ! -L "$path" ]] || die 'restore transaction path already exists'
    done
    if [[ -n "$parent_transaction" ]]; then
      [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
        "$(<"$DURABLE_BLOCK_PATH")" == \
          "agent-os-hub-recovery-block-v1:$parent_transaction" ]] ||
        die 'parent recovery block changed before restore intent publication'
      pre_restore_transaction=$parent_transaction
    else
      [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
        die 'a recovery block appeared before restore intent publication'
      pre_restore_transaction="recovery-pre-${transaction_id#restore-}"
    fi
    trace_restore_token_checkpoint before-intent
    record_restore_intent \
      "$transaction_id" \
      "$snapshot_id" \
      "$manifest_sha256" \
      "$target_tree_sha256" \
      "$pre_restore_transaction"
    trace_restore_token_checkpoint after-intent
    durable_recovery_on \
      state-restore \
      preserving-current \
      "$pre_restore_transaction"
    trace_restore_token_checkpoint after-durable-block
    restore_started=true
    maintenance_on_for_recovery
    trace_restore_token_checkpoint after-maintenance
    maintenance_enabled=true
    if [[ "$restore_was_active" == true ]] && ! health_gate quiescent; then
      die 'Hub stopped being quiescent before the restore consistency point'
    fi
    stop_and_prove_writer_stopped ||
      die 'could not stop the active writer or prove its cgroup and state descriptors clear'
    trace_restore_token_checkpoint after-stop-proof
    service_control disable "$SERVICE_NAME" || die 'could not disable Hub during state restore'
    service_is_disabled || die 'Hub remained enabled during state restore'
    trace_restore_token_checkpoint after-disable
    stopped_raw_measurement="$(
      "$NODE_BIN" "$ADMIN_ROOT/bin/tree-digest.mjs" "$STATE_ROOT"
    )" || die 'stopped current state cannot be structurally measured'
    read -r required_bytes required_inodes state_before < <(
      "$NODE_BIN" -e \
        'const v=JSON.parse(process.argv[1]); if(!Number.isSafeInteger(v.totalBytes)||v.totalBytes<0||!Number.isSafeInteger(v.entryCount)||v.entryCount<1||!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(`${v.totalBytes} ${v.entryCount} ${v.treeSha256}\n`)' \
        "$stopped_raw_measurement"
    ) || die 'stopped current-state capacity metadata is invalid'
    run_capacity_gate_at "$STATE_PARENT" \
      --required-bytes "$required_bytes" \
      --required-inodes "$required_inodes" \
      --required-state-bytes "$required_state_bytes" \
      --required-state-inodes "$required_state_inodes" >/dev/null
    preservation_mode=strict
    if measurement="$(
      "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT" 2>/dev/null
    )"; then
      :
    else
      if strict_diagnostic="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT" \
          2>&1 >/dev/null
      )"; then
        die 'strict current-state classification changed while the writer was stopped'
      fi
      case "$strict_diagnostic" in
        'Hub state snapshot failed: active_tasks_present')
          die 'current state contains assigned, running or inflight work and cannot be restored automatically'
          ;;
        'Hub state snapshot failed: event_log_invalid' | \
          'Hub state snapshot failed: json_state_invalid' | \
          'Hub state snapshot failed: placement_invalid' | \
          'Hub state snapshot failed: request_ledger_invalid')
          preservation_mode=forensic
          ;;
        *)
          die 'current state failure is not eligible for automatic forensic restore'
          ;;
      esac
    fi
    if [[ "$preservation_mode" == strict ]]; then
      preserved_snapshot_id="pre-restore-current-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    else
      preserved_snapshot_id="forensic-current-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    fi
    preserved_snapshot="$(snapshot_path_for "$preserved_snapshot_id")"
    if [[ "$preservation_mode" == strict ]]; then
      "$ADMIN_ROOT/pre-upgrade-snapshot" "$STATE_ROOT" "$preserved_snapshot" >/dev/null ||
        die 'pre-restore current-state snapshot failed'
      preserved_summary="$(verify_snapshot "$preserved_snapshot")" ||
        die 'pre-restore current-state snapshot verification failed'
    else
      forensic_owner_uid=$EUID
      forensic_owner_gid="$($ID_BIN -g)" || die 'forensic artifact GID is unavailable'
      "$NODE_BIN" "$ADMIN_ROOT/bin/state-forensic.mjs" \
        create "$STATE_ROOT" "$preserved_snapshot" \
        --owner-uid "$forensic_owner_uid" \
        --owner-gid "$forensic_owner_gid" >/dev/null ||
        die 'corrupt current-state forensic preservation failed'
      preserved_summary="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-forensic.mjs" verify "$preserved_snapshot"
      )" || die 'corrupt current-state forensic preservation verification failed'
    fi
    trace_restore_token_checkpoint after-preservation
    read -r preserved_manifest_sha256 preserved_tree_sha256 < <(
      "$NODE_BIN" -e \
        'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.manifestSha256))||!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(`${v.manifestSha256} ${v.treeSha256}\n`)' \
        "$preserved_summary"
    ) || die 'pre-restore current-state snapshot metadata is invalid'
    after_preservation="$(
      "$NODE_BIN" "$ADMIN_ROOT/bin/tree-digest.mjs" "$STATE_ROOT"
    )" || die 'current state cannot be remeasured after preservation'
    after_preservation_tree="$(
      "$NODE_BIN" -e \
        'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
        "$after_preservation"
    )" || die 'post-preservation current-state metadata is invalid'
    [[ "$after_preservation_tree" == "$state_before" ]] ||
      die 'pre-restore preservation changed stopped source state'
    record_restore_metadata \
      "$transaction_id" \
      "$snapshot_id" \
      "$manifest_sha256" \
      "$target_tree_sha256" \
      "$preserved_snapshot_id" \
      "$preserved_manifest_sha256" \
      "$preserved_tree_sha256" \
      "$state_before" \
      "$pre_restore_transaction" \
      "$preservation_mode"
    trace_restore_token_checkpoint after-metadata
    trace_restore_token_checkpoint before-block-chain
    chain_recovery_block_to_restore "$pre_restore_transaction" "$transaction_id"
    record_recovery_phase "$transaction_id" prepared
    owner_uid="$($ID_BIN -u "$SERVICE_USER")" || die 'service UID is unavailable'
    owner_gid="$($ID_BIN -g "$SERVICE_USER")" || die 'service GID is unavailable'
    "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" \
      materialize "$selected_snapshot" "$restore_staging" \
      --manifest-sha256 "$manifest_sha256" \
      --owner-uid "$owner_uid" \
      --owner-gid "$owner_gid" >/dev/null
    record_recovery_phase "$transaction_id" staged
    mv "$STATE_ROOT" "$retired_state"
    old_state_moved=true
    fsync_path "$STATE_PARENT"
    record_recovery_phase "$transaction_id" old_moved
    mv "$restore_staging" "$STATE_ROOT"
    new_state_moved=true
    fsync_path "$STATE_PARENT"
    record_recovery_phase "$transaction_id" new_activated
    start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
      die 'restored Hub failed its authorized start'
    health_gate live || die 'restored Hub failed exact liveness'
    record_recovery_phase "$transaction_id" verified
    service_enable
    record_recovery_phase "$transaction_id" committed
    restore_committed=true
    restore_terminal_ready=true
    restore_terminal_transaction=$transaction_id
    maintenance_off "$restore_terminal_transaction"
    mark_direct_restore_complete
    printf 'hub_state_restore status=ok snapshot=%s manifest_sha256=%s retained_previous=%s\n' \
      "$snapshot_id" "$manifest_sha256" "${retired_state##*/}"
    ;;
  recover-old)
    transaction_id=$recover_transaction
    recover_old_started=true
    maintenance_on_for_recovery
    maintenance_enabled=true
    stop_and_prove_writer_stopped_for_path "$STATE_PARENT" ||
      die 'could not stop the writer or prove its cgroup and state descriptors clear'
    service_control disable "$SERVICE_NAME" ||
      die 'could not disable Hub during old-state recovery'
    service_is_disabled || die 'Hub remained enabled during old-state recovery'
    if [[ "$recover_mode" == orphan ]]; then
      validate_restore_orphan_intent "$transaction_id" ||
        die 'restore orphan intent changed during recovery preflight'
      "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT" >/dev/null ||
        die 'orphan current state is not semantically replayable; use a signed restore bound to its parent transaction'
      start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
        die 'orphan restore intent current state failed its authorized start'
      health_gate live || die 'orphan restore intent current state failed liveness'
      service_enable
      record_restore_intent_aborted "$transaction_id"
      recover_terminal_ready=true
      maintenance_off
      mark_recover_old_complete
      printf 'hub_state_recover_old status=aborted transaction=%s\n' "$transaction_id"
    elif [[ "$recover_mode" == orphan_finalize ]]; then
      validate_restore_orphan_intent "$transaction_id" ||
        die 'terminal orphan restore intent changed during finalize'
      [[ -f "$RECOVERY_ROOT/$transaction_id/aborted" && \
        ! -L "$RECOVERY_ROOT/$transaction_id/aborted" ]] ||
        die 'terminal orphan restore abort marker is missing'
      "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT" \
        >/dev/null || die 'terminal orphan current state is not semantically replayable'
      start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
        die 'terminal orphan current state failed its authorized start'
      health_gate live || die 'terminal orphan current state failed exact liveness'
      service_enable
      recover_terminal_ready=true
      maintenance_off
      mark_recover_old_complete
      printf 'hub_state_recover_old status=finalized transaction=%s\n' "$transaction_id"
    elif [[ "$recover_finalize" == true ]]; then
      validate_restore_journal "$transaction_id" ||
        die 'terminal restore journal changed during finalize'
      finalize_measurement="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT"
      )" || die 'terminal restore state is not semantically replayable'
      finalize_tree="$(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$finalize_measurement"
      )" || die 'terminal restore state tree metadata is invalid'
      [[ "$finalize_tree" == "$recover_finalize_tree" ]] ||
        die 'terminal restore state tree does not match its committed phase'
      start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
        die 'terminal restore state failed its authorized start'
      health_gate live || die 'terminal restore state failed exact liveness'
      service_enable
      recover_terminal_ready=true
      maintenance_off
      mark_recover_old_complete
      printf 'hub_state_recover_old status=finalized transaction=%s\n' "$transaction_id"
    elif [[ "$recover_mode" == forward ]]; then
      validate_restore_journal "$transaction_id" ||
        die 'forensic forward journal changed during recovery preflight'
      recovery_staging="$STATE_PARENT/.hub.restore-$transaction_id"
      retired_state="$STATE_PARENT/hub.pre-restore-$transaction_id"
      failed_state="$STATE_PARENT/hub.failed-restore-$transaction_id"
      [[ ! -e "$failed_state" && ! -L "$failed_state" ]] ||
        die 'forensic forward recovery found an unexpected failed target tree'
      preserved_snapshot="$(snapshot_path_for "$RESTORE_PRESERVED_SNAPSHOT")"
      forensic_summary="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-forensic.mjs" verify \
          "$preserved_snapshot" --manifest-sha256 "$RESTORE_PRESERVED_DIGEST"
      )" || die 'forensic preservation artifact changed during forward recovery'
      forensic_tree="$(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$forensic_summary"
      )" || die 'forensic preservation artifact metadata changed during recovery'
      [[ "$forensic_tree" == "$RESTORE_PRESERVED_TREE" ]] ||
        die 'forensic preservation artifact no longer matches the recovery journal'
      owner_uid="$($ID_BIN -u "$SERVICE_USER")" || die 'service UID is unavailable'
      owner_gid="$($ID_BIN -g "$SERVICE_USER")" || die 'service GID is unavailable'
      if [[ ! -e "$RECOVERY_ROOT/$transaction_id/prepared" ]]; then
        record_recovery_phase "$transaction_id" prepared
      fi
      if [[ ! -e "$RECOVERY_ROOT/$transaction_id/staged" ]]; then
        [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          ! -e "$retired_state" && ! -L "$retired_state" ]] ||
          die 'forensic prepared topology is invalid'
        if [[ ! -e "$recovery_staging" && ! -L "$recovery_staging" ]]; then
          "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" \
            materialize "$selected_snapshot" "$recovery_staging" \
            --manifest-sha256 "$manifest_sha256" \
            --owner-uid "$owner_uid" \
            --owner-gid "$owner_gid" >/dev/null ||
            die 'forensic forward target could not be materialized'
        else
          [[ -d "$recovery_staging" && ! -L "$recovery_staging" ]] ||
            die 'forensic materialization phase-lag path is unsafe'
          lag_staged_measurement="$(
            "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$recovery_staging"
          )" || die 'forensic materialization phase-lag target is invalid'
          lag_staged_tree="$(
            "$NODE_BIN" -e \
              'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
              "$lag_staged_measurement"
          )" || die 'forensic materialization phase-lag metadata is invalid'
          [[ "$lag_staged_tree" == "$RESTORE_TARGET_TREE" ]] ||
            die 'forensic materialization phase-lag target changed'
        fi
        record_recovery_phase "$transaction_id" staged
      fi
      if [[ ! -e "$RECOVERY_ROOT/$transaction_id/old_moved" ]]; then
        [[ -d "$recovery_staging" && ! -L "$recovery_staging" ]] ||
          die 'forensic staged target is missing before source retirement'
        if [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          ! -e "$retired_state" && ! -L "$retired_state" ]]; then
          current_raw_measurement="$(
            "$NODE_BIN" "$ADMIN_ROOT/bin/tree-digest.mjs" "$STATE_ROOT"
          )" || die 'forensic source state cannot be structurally remeasured'
          current_raw_tree="$(
            "$NODE_BIN" -e \
              'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
              "$current_raw_measurement"
          )" || die 'forensic source state metadata is invalid'
          [[ "$current_raw_tree" == "$RESTORE_PRESERVED_STATE" ]] ||
            die 'forensic source state changed after preservation'
          mv "$STATE_ROOT" "$retired_state" ||
            die 'forensic source state could not be retired'
          fsync_path "$STATE_PARENT"
        elif [[ ! -e "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          -d "$retired_state" && ! -L "$retired_state" ]]; then
          :
        else
          die 'forensic staged phase-lag topology is invalid'
        fi
        record_recovery_phase "$transaction_id" old_moved
      fi
      retired_raw_measurement="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/tree-digest.mjs" "$retired_state"
      )" || die 'retired forensic state cannot be structurally verified'
      retired_raw_tree="$(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$retired_raw_measurement"
      )" || die 'retired forensic state metadata is invalid'
      [[ "$retired_raw_tree" == "$RESTORE_PRESERVED_STATE" ]] ||
        die 'retired forensic state no longer matches the recovery journal'
      if [[ ! -e "$RECOVERY_ROOT/$transaction_id/new_activated" ]]; then
        if [[ ! -e "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          -d "$recovery_staging" && ! -L "$recovery_staging" ]]; then
          staged_measurement="$(
            "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$recovery_staging"
          )" || die 'forensic staged target is not semantically replayable'
          staged_tree="$(
            "$NODE_BIN" -e \
              'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
              "$staged_measurement"
          )" || die 'forensic staged target metadata is invalid'
          [[ "$staged_tree" == "$RESTORE_TARGET_TREE" ]] ||
            die 'forensic staged target does not match the recovery journal'
          mv "$recovery_staging" "$STATE_ROOT" ||
            die 'forensic verified target could not be activated'
          fsync_path "$STATE_PARENT"
        elif [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          ! -e "$recovery_staging" && ! -L "$recovery_staging" ]]; then
          :
        else
          die 'forensic old_moved phase-lag topology is invalid'
        fi
        record_recovery_phase "$transaction_id" new_activated
      fi
      forward_measurement="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT"
      )" || die 'forensic forward target is not semantically replayable'
      forward_tree="$(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$forward_measurement"
      )" || die 'forensic forward target metadata is invalid'
      [[ "$forward_tree" == "$RESTORE_TARGET_TREE" ]] ||
        die 'forensic forward target does not match the recovery journal'
      start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
        die 'forensic forward target failed its authorized start'
      health_gate live || die 'forensic forward target failed exact liveness'
      if [[ ! -e "$RECOVERY_ROOT/$transaction_id/verified" ]]; then
        record_recovery_phase "$transaction_id" verified
      fi
      service_enable
      record_recovery_phase "$transaction_id" committed
      recover_terminal_ready=true
      maintenance_off
      mark_recover_old_complete
      printf 'hub_state_recover_old status=forward_completed transaction=%s snapshot=%s manifest_sha256=%s\n' \
        "$transaction_id" "$snapshot_id" "$manifest_sha256"
    else
      validate_restore_journal "$transaction_id" ||
        die 'restore recovery journal changed during recovery preflight'
      verify_snapshot "$selected_snapshot" "$manifest_sha256" >/dev/null ||
        die 'preserved pre-restore snapshot changed during recovery preflight'
      if [[ ! -e "$RECOVERY_ROOT/$transaction_id/prepared" ]]; then
        record_recovery_phase "$transaction_id" prepared
      fi
      recovery_staging="$STATE_PARENT/.hub.recover-old-$transaction_id"
      aborted_state="$STATE_PARENT/hub.aborted-new-$transaction_id"
      retired_state="$STATE_PARENT/hub.pre-restore-$transaction_id"
      target_staging="$STATE_PARENT/.hub.restore-$transaction_id"
      failed_state="$STATE_PARENT/hub.failed-restore-$transaction_id"
      [[ ! -e "$recovery_staging" && ! -L "$recovery_staging" ]] ||
        die 'old-state recovery found an unexpected secondary staging tree'
      if [[ -e "$RECOVERY_ROOT/$transaction_id/new_activated" ]]; then
        recover_phase=activated
      elif [[ -e "$RECOVERY_ROOT/$transaction_id/old_moved" ]]; then
        recover_phase=old_moved
      elif [[ -e "$RECOVERY_ROOT/$transaction_id/staged" ]]; then
        recover_phase=staged
      else
        recover_phase=prepared
      fi

      # An aborted target is a transaction-owned recovery artifact, not a
      # marker.  A crash may leave it visible before the following directory
      # fsync or phase write, so every re-entry must revalidate its complete
      # private tree before adopting it.
      if [[ -e "$aborted_state" || -L "$aborted_state" ]]; then
        [[ -d "$aborted_state" && ! -L "$aborted_state" ]] ||
          die 'aborted target rollback artifact is invalid'
        aborted_measurement="$(
          "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$aborted_state"
        )" || die 'aborted target tree cannot be measured during rollback'
        aborted_tree="$(
          "$NODE_BIN" -e \
            'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
            "$aborted_measurement"
        )" || die 'aborted target tree metadata is invalid during rollback'
        [[ "$aborted_tree" == "$RESTORE_TARGET_TREE" ]] ||
          die 'aborted target tree does not match the recovery journal'
      fi
      if [[ -e "$failed_state" || -L "$failed_state" ]]; then
        [[ "$recover_phase" == activated && \
          -d "$failed_state" && ! -L "$failed_state" && \
          ! -e "$aborted_state" && ! -L "$aborted_state" ]] ||
          die 'failed target rollback artifact is invalid for the recovery phase'
        failed_measurement="$(
          "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$failed_state"
        )" || die 'failed target tree cannot be measured during rollback'
        failed_tree="$(
          "$NODE_BIN" -e \
            'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
            "$failed_measurement"
        )" || die 'failed target tree metadata is invalid during rollback'
        [[ "$failed_tree" == "$RESTORE_TARGET_TREE" ]] ||
          die 'failed target tree does not match the recovery journal'
        mv "$failed_state" "$aborted_state" ||
          die 'failed target tree could not be adopted during rollback'
        fsync_path "$STATE_PARENT"
      fi

      if [[ "$recover_phase" == prepared || "$recover_phase" == staged ]]; then
        [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          ! -e "$retired_state" && ! -L "$retired_state" ]] ||
          die 'pre-retirement old-state recovery topology is invalid'
        preserved_measurement="$(
          "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT"
        )" || die 'preserved live old-state tree cannot be measured'
        preserved_tree="$(
          "$NODE_BIN" -e \
            'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
            "$preserved_measurement"
        )" || die 'preserved live old-state metadata is invalid'
        [[ "$preserved_tree" == "$RESTORE_PRESERVED_TREE" ]] ||
          die 'preserved live old-state tree does not match the recovery journal'
        if [[ "$recover_phase" == prepared ]]; then
          [[ ! -e "$target_staging" && ! -L "$target_staging" && \
            ! -e "$aborted_state" && ! -L "$aborted_state" && \
            ! -e "$failed_state" && ! -L "$failed_state" ]] ||
            die 'prepared rollback contains an unexpected target tree'
        fi
      fi

      if [[ "$recover_phase" != activated ]]; then
        [[ ! -e "$failed_state" && ! -L "$failed_state" ]] ||
          die 'pre-activation rollback contains an unexpected failed target tree'
      fi

      if [[ "$recover_phase" == staged || "$recover_phase" == old_moved ]]; then
        if [[ -d "$target_staging" && ! -L "$target_staging" && \
          ! -e "$aborted_state" && ! -L "$aborted_state" ]]; then
          target_measurement="$(
            "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$target_staging"
          )" || die 'staged target tree cannot be measured during rollback'
          target_tree="$(
            "$NODE_BIN" -e \
              'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
              "$target_measurement"
          )" || die 'staged target tree metadata is invalid during rollback'
          [[ "$target_tree" == "$RESTORE_TARGET_TREE" ]] ||
            die 'staged target tree does not match the recovery journal'
          mv "$target_staging" "$aborted_state" ||
            die 'staged target could not be isolated during rollback'
          fsync_path "$STATE_PARENT"
        elif [[ ! -e "$target_staging" && ! -L "$target_staging" && \
          -d "$aborted_state" && ! -L "$aborted_state" ]]; then
          # The shared aborted-target preflight above bound this artifact to
          # RESTORE_TARGET_TREE before this phase-lag topology is accepted.
          :
        else
          die 'staged target rollback topology is invalid'
        fi
      fi

      if [[ "$recover_phase" == old_moved ]]; then
        if [[ ! -e "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          -d "$retired_state" && ! -L "$retired_state" ]]; then
          retired_measurement="$(
            "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$retired_state"
          )" || die 'retired old-state tree cannot be measured'
          retired_tree="$(
            "$NODE_BIN" -e \
              'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
              "$retired_measurement"
          )" || die 'retired old-state metadata is invalid'
          [[ "$retired_tree" == "$RESTORE_PRESERVED_TREE" ]] ||
            die 'retired old-state tree does not match the recovery journal'
          mv "$retired_state" "$STATE_ROOT" ||
            die 'retired old-state tree could not be reactivated'
          fsync_path "$STATE_PARENT"
        elif [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          ! -e "$retired_state" && ! -L "$retired_state" ]]; then
          :
        else
          die 'old_moved rollback phase-lag topology is invalid'
        fi
      elif [[ "$recover_phase" == activated ]]; then
        [[ ! -e "$target_staging" && ! -L "$target_staging" ]] ||
          die 'activated rollback retained an impossible target staging tree'
        if [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          -d "$retired_state" && ! -L "$retired_state" && \
          ! -e "$aborted_state" && ! -L "$aborted_state" ]]; then
          active_target_measurement="$(
            "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT"
          )" || die 'active target tree cannot be measured during rollback'
          active_target_tree="$(
            "$NODE_BIN" -e \
              'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
              "$active_target_measurement"
          )" || die 'active target tree metadata is invalid during rollback'
          [[ "$active_target_tree" == "$RESTORE_TARGET_TREE" ]] ||
            die 'active target tree does not match the recovery journal'
          mv "$STATE_ROOT" "$aborted_state" ||
            die 'active target tree could not be isolated during rollback'
          fsync_path "$STATE_PARENT"
        fi
        if [[ ! -e "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          -d "$retired_state" && ! -L "$retired_state" && \
          -d "$aborted_state" && ! -L "$aborted_state" ]]; then
          mv "$retired_state" "$STATE_ROOT" ||
            die 'retired old-state tree could not be reactivated'
          fsync_path "$STATE_PARENT"
        elif [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" && \
          ! -e "$retired_state" && ! -L "$retired_state" && \
          -d "$aborted_state" && ! -L "$aborted_state" ]]; then
          :
        else
          die 'activated rollback phase-lag topology is invalid'
        fi
      fi
      activated_measurement="$(
        "$NODE_BIN" "$ADMIN_ROOT/bin/state-snapshot.mjs" measure "$STATE_ROOT"
      )" || die 'activated old-state tree cannot be measured'
      activated_tree="$(
        "$NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$activated_measurement"
      )" || die 'activated old-state tree metadata is invalid'
      [[ "$activated_tree" == "$RESTORE_PRESERVED_TREE" ]] ||
        die 'activated old-state tree does not match the recovery journal'
      [[ ! -e "$target_staging" && ! -L "$target_staging" && \
        ! -e "$recovery_staging" && ! -L "$recovery_staging" && \
        ! -e "$failed_state" && ! -L "$failed_state" ]] ||
        die 'old-state recovery retained a staging tree after activation'
      start_authorized_recovery_service "$DURABLE_BLOCK_TRANSACTION" ||
        die 'old state failed its authorized start'
      health_gate live || die 'old state failed exact liveness'
      service_enable
      record_recovery_phase "$transaction_id" rolled_back
      recover_terminal_ready=true
      maintenance_off
      mark_recover_old_complete
      printf 'hub_state_recover_old status=ok transaction=%s snapshot=%s manifest_sha256=%s\n' \
        "$transaction_id" "$snapshot_id" "$manifest_sha256"
    fi
    mark_recover_old_complete
    ;;
esac
