#!/bin/bash -p
set -Eeuo pipefail

command_name=${1:-}
source_root=${AGENT_OS_GENERATION_SOURCE_ROOT:?}
test_root=${AGENT_OS_DEPLOY_TEST_ROOT:?}
library="$source_root/bin/lib.sh"
source "$library"

fsync_path() { :; }

copy_admin_tree() {
  local source=$1 destination=$2 relative mode
  mkdir -p "$destination"
  chmod 0700 "$destination"
  while IFS= read -r relative; do
    mode=0444
    [[ "$relative" == *.sh || "$relative" == pre-upgrade-snapshot ]] && mode=0555
    mkdir -p "$destination/$(dirname -- "$relative")"
    install -m "$mode" "$source/$relative" "$destination/$relative"
  done < <(admin_files)
  find "$destination" -type d -exec chmod 0555 {} +
}

write_runtime_set() {
  local root=$1 mode relative destination label
  while IFS='|' read -r mode relative destination label; do
    mkdir -p "$(dirname -- "$destination")"
    install -m "$mode" "$root/$relative" "$destination"
  done < <(legacy_runtime_files)
}

runtime_payload_digest() {
  local root=$1 canonical=${2:-true} payload="$test_root/runtime-digest" mode relative destination label
  rm -rf "$payload"
  mkdir -p "$payload"
  while IFS='|' read -r mode relative destination label; do
    install -m 0400 "$root/$relative" "$payload/$label"
  done < <(legacy_runtime_files)
  chmod 0500 "$payload"
  chgrp -R "$(id -g)" "$payload"
  if [[ "$canonical" == true ]]; then
    canonical_root_tree_sha256_for "$payload"
  else
    tree_sha256_for "$payload"
  fi
  chmod 0700 "$payload"
  rm -rf "$payload"
}

admin_target_digest() {
  local payload="$test_root/admin-digest"
  rm -rf "$payload"
  copy_admin_tree "$source_root" "$payload"
  chgrp -R "$(id -g)" "$payload"
  tree_sha256_for "$payload"
  chmod -R u+w "$payload"
  rm -rf "$payload"
}

source_contract() {
  local summary
  local -a admin_manifest=() runtime_manifest=()
  while IFS= read -r summary; do admin_manifest+=("$summary"); done < <(admin_files)
  while IFS= read -r summary; do runtime_manifest+=("$summary"); done < <(legacy_runtime_files)
  "$NODE_BIN" "$source_root/admin-generation-digest.mjs" \
    "$source_root" "${admin_manifest[@]}" --runtime "${runtime_manifest[@]}"
}

initialize_fixture() {
  local old_admin new_admin old_runtime new_runtime summary contract
  mkdir -p "$ADMIN_PARENT" "$CONFIG_ROOT" "$STATE_ROOT" "$RECOVERY_ROOT" \
    "$RUNTIME_ROOT" "$(dirname -- "$UNIT_PATH")" "$(dirname -- "$NGINX_EXAMPLE_PATH")" \
    "$(dirname -- "$NGINX_LIMITS_EXAMPLE_PATH")"
  chmod 0700 "$ADMIN_PARENT" "$CONFIG_ROOT" "$STATE_ROOT" "$RECOVERY_ROOT" "$RUNTIME_ROOT"
  copy_admin_tree "$source_root" "$ADMIN_ROOT"
  chmod 0644 "$ADMIN_ROOT/env.example"
  printf '\n# previous generation\n' >>"$ADMIN_ROOT/env.example"
  chmod 0444 "$ADMIN_ROOT/env.example"
  old_admin="$(canonical_root_tree_sha256_for "$ADMIN_ROOT")"
  old_runtime="$(runtime_payload_digest "$ADMIN_ROOT" true)"
  write_runtime_set "$ADMIN_ROOT"
  summary="$(source_contract)"
  [[ "$($NODE_BIN -e 'process.stdout.write(String(JSON.parse(process.argv[1]).admin.fileCount))' "$summary")" == 25 ]]
  new_admin="$(admin_target_digest)"
  new_runtime="$(runtime_payload_digest "$source_root" false)"
  contract="$test_root/.generation-edge"
  umask 0077
  printf 'OLD_ADMIN=%s\nNEW_ADMIN=%s\nOLD_RUNTIME=%s\nNEW_RUNTIME=%s\n' \
    "$old_admin" "$new_admin" "$old_runtime" "$new_runtime" >"$contract"
  chmod 0400 "$contract"
  mkdir -p "$test_root/mock"
  : >"$test_root/mock/active"
  : >"$test_root/mock/enabled"
  chgrp -R "$(id -g)" "$test_root"
  printf '%s\n' "$old_admin"
}

load_contract() {
  local key value count=0
  while IFS='=' read -r key value; do
    [[ "$value" =~ ^[a-f0-9]{64}$ ]] || exit 2
    case "$key" in
      OLD_ADMIN) OLD_ADMIN=$value ;;
      NEW_ADMIN) NEW_ADMIN=$value ;;
      OLD_RUNTIME) OLD_RUNTIME=$value ;;
      NEW_RUNTIME) NEW_RUNTIME=$value ;;
      *) exit 2 ;;
    esac
    count=$((count + 1))
  done <"$test_root/.generation-edge"
  [[ "$count" == 4 ]]
  configure_admin_migration_contract generation \
    "$OLD_ADMIN" "$NEW_ADMIN" "$OLD_RUNTIME" "$NEW_RUNTIME" \
    upgrade-admin-migration-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-attempt-000001 \
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
}

service_control() {
  local action=$1
  shift
  case "$action" in
    disable) rm -f "$test_root/mock/enabled" ;;
    enable) : >"$test_root/mock/enabled" ;;
    stop) rm -f "$test_root/mock/active" ;;
    start) : >"$test_root/mock/active" ;;
    is-active) [[ -f "$test_root/mock/active" ]] ;;
    is-enabled) [[ -f "$test_root/mock/enabled" ]] ;;
    daemon-reload | reset-failed) : ;;
    show) return 1 ;;
    *) return 1 ;;
  esac
}
service_is_strictly_disabled() { [[ ! -e "$test_root/mock/enabled" ]]; }
stop_and_prove_admin_migration_writer_stopped() { rm -f "$test_root/mock/active"; }
prove_admin_migration_state_quiescent() { :; }
require_installed_runtime_contract() { :; }
reset_failed_or_prove_inactive() { :; }
health_gate() { [[ -f "$test_root/mock/active" ]]; }
start_authorized_recovery_service() { : >"$test_root/mock/active"; }
service_enable() { : >"$test_root/mock/enabled"; }
verify_admin_migration_env_contract() { :; }
verify_admin_migration_state_root_contract() { :; }
verify_admin_migration_release_pointer_contract() { :; }
effective_unit_contract_is_current() { :; }
ensure_admin_migration_guard() {
  ADMIN_MIGRATION_ACTIVE=true
  if [[ ! -e "$MAINTENANCE_PATH" ]]; then
    : >"$MAINTENANCE_PATH"
    chmod 0444 "$MAINTENANCE_PATH"
  fi
  if [[ ! -e "$FAIL_CLOSED_PATH" ]]; then
    : >"$FAIL_CLOSED_PATH"
    chmod 0444 "$FAIL_CLOSED_PATH"
  fi
  if [[ ! -e "$DURABLE_BLOCK_PATH" ]]; then
    printf '%s\n' "$ADMIN_MIGRATION_TRANSACTION" >"$DURABLE_BLOCK_PATH"
    chmod 0400 "$DURABLE_BLOCK_PATH"
  fi
  record_admin_migration_phase blocked
}
maintenance_off() {
  rm -f "$MAINTENANCE_PATH" "$FAIL_CLOSED_PATH" "$DURABLE_BLOCK_PATH" "$RECOVERY_START_PATH"
}
admin_migration_guard_is_clean() {
  [[ ! -e "$MAINTENANCE_PATH" && ! -e "$FAIL_CLOSED_PATH" && \
    ! -e "$DURABLE_BLOCK_PATH" && ! -e "$RECOVERY_START_PATH" ]]
}

run_migration() {
  local action=${2:-forward}
  load_contract
  migrate_installed_admin_kit "$OLD_ADMIN" "$action"
}

case "$command_name" in
  init) initialize_fixture ;;
  run) run_migration "$@" ;;
  status)
    load_contract
    ADMIN_MIGRATION_ROOT="$(/usr/bin/find "$RECOVERY_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -name "upgrade-admin-migration-$OLD_ADMIN-attempt-*" -print | LC_ALL=C sort | tail -n 1)"
    [[ -n "$ADMIN_MIGRATION_ROOT" ]]
    printf 'current=%s old=%s committed=%s finalized=%s rolled_back=%s active=%s enabled=%s guards=%s\n' \
      "$(canonical_root_tree_sha256_for "$ADMIN_ROOT")" "$OLD_ADMIN" \
      "$([[ -e "$ADMIN_MIGRATION_ROOT/committed" ]] && echo yes || echo no)" \
      "$([[ -e "$ADMIN_MIGRATION_ROOT/finalized" ]] && echo yes || echo no)" \
      "$([[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" ]] && echo yes || echo no)" \
      "$([[ -e "$test_root/mock/active" ]] && echo yes || echo no)" \
      "$([[ -e "$test_root/mock/enabled" ]] && echo yes || echo no)" \
      "$([[ -e "$DURABLE_BLOCK_PATH" || -e "$MAINTENANCE_PATH" || -e "$FAIL_CLOSED_PATH" ]] && echo present || echo clean)"
    ;;
  tamper-new-runtime)
    load_contract
    select_admin_migration_attempt "$OLD_ADMIN" forward
    chmod 0600 "$ADMIN_MIGRATION_ROOT/new-runtime/env-example"
    printf tampered >>"$ADMIN_MIGRATION_ROOT/new-runtime/env-example"
    chmod 0400 "$ADMIN_MIGRATION_ROOT/new-runtime/env-example"
    ;;
  *) exit 2 ;;
esac
