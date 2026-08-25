#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

bootstrap_fail() {
  printf 'Hub admin bootstrap failed: %s\n' "$1" >&2
  exit 1
}

bootstrap_stat_value() {
  local gnu_format=$1 bsd_format=$2 path=$3
  [[ -x /usr/bin/stat ]] || return 1
  if /usr/bin/stat -c "$gnu_format" "$path" >/dev/null 2>&1; then
    /usr/bin/stat -c "$gnu_format" "$path"
  else
    /usr/bin/stat -f "$bsd_format" "$path"
  fi
}

bootstrap_mode_is_safe() {
  local mode=$1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 8#022) == 0))
}

bootstrap_trusted_file() {
  local path=$1 remaining current component owner mode final=false
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *'//'* ]] ||
    bootstrap_fail 'source paths must be canonical absolute paths'
  case "/$path/" in
    */../* | */./*) bootstrap_fail 'source paths must not contain dot components' ;;
  esac
  owner="$(bootstrap_stat_value '%u' '%u' /)" ||
    bootstrap_fail 'cannot inspect the filesystem root'
  mode="$(bootstrap_stat_value '%a' '%Lp' /)" ||
    bootstrap_fail 'cannot inspect the filesystem root'
  [[ "$owner" == 0 ]] || bootstrap_fail 'filesystem root is not root-owned'
  bootstrap_mode_is_safe "$mode" ||
    bootstrap_fail 'filesystem root is group/world writable'

  remaining=${path#/}
  current=
  while [[ -n "$remaining" ]]; do
    component=${remaining%%/*}
    if [[ "$remaining" == */* ]]; then
      remaining=${remaining#*/}
    else
      remaining=
      final=true
    fi
    [[ -n "$component" && "$component" != . && "$component" != .. ]] ||
      bootstrap_fail 'source path contains an invalid component'
    current="$current/$component"
    [[ ! -L "$current" ]] || bootstrap_fail 'source path contains a symbolic link'
    if [[ "$final" == true ]]; then
      [[ -f "$current" ]] || bootstrap_fail 'trusted source file is missing'
    else
      [[ -d "$current" ]] || bootstrap_fail 'trusted source directory is missing'
    fi
    owner="$(bootstrap_stat_value '%u' '%u' "$current")" ||
      bootstrap_fail 'cannot inspect the admin source'
    mode="$(bootstrap_stat_value '%a' '%Lp' "$current")" ||
      bootstrap_fail 'cannot inspect the admin source'
    [[ "$owner" == 0 ]] || bootstrap_fail 'admin source path must be root-owned'
    bootstrap_mode_is_safe "$mode" ||
      bootstrap_fail 'admin source path must not be group/world writable'
  done
}

# This is the only deployment program intentionally run from the separately
# delivered administrator kit. Application release archives are never a source
# for privileged helpers or service/proxy configuration.
readonly BOOTSTRAP_SOURCE="${BASH_SOURCE[0]}"
readonly BOOTSTRAP_TEST_ROOT="${AGENT_OS_DEPLOY_TEST_ROOT:-}"
if [[ -n "$BOOTSTRAP_TEST_ROOT" ]]; then
  [[ "${AGENT_OS_DEPLOY_TEST_MODE:-}" == 1 ]] ||
    bootstrap_fail 'test root requires AGENT_OS_DEPLOY_TEST_MODE=1'
  ((EUID != 0)) || bootstrap_fail 'test mode must never run as root'
else
  bootstrap_trusted_file "$BOOTSTRAP_SOURCE"
fi
readonly SCRIPT_DIR="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$BOOTSTRAP_SOURCE")" && pwd -P)"
if [[ -z "$BOOTSTRAP_TEST_ROOT" ]]; then
  bootstrap_trusted_file "$SCRIPT_DIR/bin/lib.sh"
  if [[ "${1:-}" == --upgrade-generation ]]; then
    bootstrap_trusted_file "$SCRIPT_DIR/admin-generation-digest.mjs"
  fi
fi
# shellcheck source=bin/lib.sh
source "$SCRIPT_DIR/bin/lib.sh"

readonly ADMIN_GENERATION_ID=hub-admin-25-20260825-g4
readonly ADMIN_GENERATION_OLD_SHA256=50363eb8ecb86e1fbaa3c03df3c0e6e2ee22a8d28bdb2c1100b10477a51ccb36
readonly ADMIN_GENERATION_NEW_SHA256=af8d4c3fcdf474851a7fae3e33e42d79c3c92286e2ddc781acaa640982e7afaa
readonly ADMIN_GENERATION_OLD_RUNTIME_SHA256=ccbc5110a87237401808774011390e335c2437080c48ab7fedf5e04d46944440
readonly ADMIN_GENERATION_NEW_RUNTIME_SHA256=ccbc5110a87237401808774011390e335c2437080c48ab7fedf5e04d46944440
readonly ADMIN_GENERATION_PREDECESSOR_TRANSACTION=upgrade-admin-migration-f90634641ef071322baa637b6eb059ee8cad7a0bf3d552b4ae8e59ac37cfcde8-attempt-000001
readonly ADMIN_GENERATION_PREDECESSOR_SHA256=7b9ee35e2f422fbf2699ad404f03f6a7b02fdf82a2ea104b8fc1e8b0f4f00b03
readonly ADMIN_GENERATION_ANCESTOR_TRANSACTION=upgrade-admin-migration-444a95509b66052f71dfe94b725dbfbf6de82f053440cdba153f4b567422dbc6-attempt-000001
readonly ADMIN_GENERATION_ANCESTOR_SHA256=7a332db8154e10f9fb0de500474db2ad2e02e98c8b59f6fe5a46e990b5c95112
readonly ADMIN_GENERATION_ROOT_ANCESTOR_TRANSACTION=upgrade-admin-migration-1f064246a0f547571aa832b374baae377a8bbfb3b8b10733ed530b459d168220-attempt-000001
readonly ADMIN_GENERATION_ROOT_ANCESTOR_SHA256=8ff2613d3a952cc35f4954b8cfccb0206e1514d094cdec2ee3c774d44e5e853f

replace_cold=false
migrate_installed=false
migrate_generation=false
migration_action=forward
expected_current_digest=

prepare_generation_rollback_retry_token() {
  [[ "$migrate_generation" == true && "$migration_action" == rollback ]] ||
    return 0
  select_admin_migration_attempt "$expected_current_digest" rollback
  if [[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" && \
    ! -e "$ADMIN_MIGRATION_ROOT/finalized" ]]; then
    validate_or_create_recovery_start_token "$ADMIN_MIGRATION_TRANSACTION" ||
      die 'admin generation rollback retry token is invalid'
  fi
}

if (($# == 0)); then
  :
elif (($# == 3)) && [[ "$1" == --replace-cold && "$2" == --expected-current-sha256 ]]; then
  replace_cold=true
  expected_current_digest=$3
elif (($# == 3)) && \
  [[ "$1" == --migrate-installed && "$2" == --expected-current-sha256 ]]; then
  migrate_installed=true
  expected_current_digest=$3
elif (($# == 4)) && \
  [[ "$1" == --migrate-installed && "$2" == --expected-current-sha256 && \
    "$4" == --rollback ]]; then
  migrate_installed=true
  migration_action=rollback
  expected_current_digest=$3
elif (($# == 2)) && \
  [[ "$1" == --upgrade-generation && "$2" == "$ADMIN_GENERATION_ID" ]]; then
  migrate_installed=true
  migrate_generation=true
  expected_current_digest=$ADMIN_GENERATION_OLD_SHA256
elif (($# == 3)) && \
  [[ "$1" == --upgrade-generation && "$2" == "$ADMIN_GENERATION_ID" && \
    "$3" == --rollback ]]; then
  migrate_installed=true
  migrate_generation=true
  migration_action=rollback
  expected_current_digest=$ADMIN_GENERATION_OLD_SHA256
else
  printf '%s\n' \
    'usage: bootstrap-admin.sh [--replace-cold --expected-current-sha256 HEX]' \
    '       bootstrap-admin.sh --migrate-installed --expected-current-sha256 HEX [--rollback]' \
    '       bootstrap-admin.sh --upgrade-generation hub-admin-25-20260825-g4 [--rollback]' >&2
  exit 2
fi

require_privilege
require_commands install chmod find mv
require_pinned_node
if [[ "$migrate_installed" == true ]]; then
  if [[ "$migrate_generation" == true ]]; then
    configure_admin_migration_contract \
      generation \
      "$ADMIN_GENERATION_OLD_SHA256" \
      "$ADMIN_GENERATION_NEW_SHA256" \
      "$ADMIN_GENERATION_OLD_RUNTIME_SHA256" \
      "$ADMIN_GENERATION_NEW_RUNTIME_SHA256" \
      "$ADMIN_GENERATION_PREDECESSOR_TRANSACTION" \
      "$ADMIN_GENERATION_PREDECESSOR_SHA256" \
      "$ADMIN_GENERATION_ANCESTOR_TRANSACTION" \
      "$ADMIN_GENERATION_ANCESTOR_SHA256" \
      "$ADMIN_GENERATION_ROOT_ANCESTOR_TRANSACTION" \
      "$ADMIN_GENERATION_ROOT_ANCESTOR_SHA256"
  fi
  # Reject the operator pin, source or legacy runtime before even creating the
  # deployment lock. Re-run the same preflight after taking the lock to close
  # the read/check race before the first durable migration mutation.
  preflight_installed_admin_migration "$expected_current_digest" "$migration_action"
  acquire_deploy_lock
  recover_admin_migration_temporaries \
    "$expected_current_digest" "$migration_action"
  preflight_installed_admin_migration "$expected_current_digest" "$migration_action"
  prepare_generation_rollback_retry_token
  admin_migration_finish() {
    local result=$?
    trap - EXIT TERM INT HUP
    if [[ "${ADMIN_MIGRATION_ACTIVE:-false}" == true && \
      "${ADMIN_MIGRATION_COMPLETE:-false}" != true ]]; then
      admin_migration_fail_closed || result=1
    fi
    exit "$result"
  }
  trap admin_migration_finish EXIT TERM INT HUP
  migrate_installed_admin_kit "$expected_current_digest" "$migration_action"
  ADMIN_MIGRATION_COMPLETE=true
  ADMIN_MIGRATION_ACTIVE=false
elif [[ "$replace_cold" == true ]]; then
  acquire_deploy_lock
  ensure_layout
  replace_admin_kit_cold "$expected_current_digest"
else
  acquire_deploy_lock
  ensure_layout
  install_admin_kit
fi
notice bootstrap_admin ok
