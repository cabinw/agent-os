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
fi
# shellcheck source=bin/lib.sh
source "$SCRIPT_DIR/bin/lib.sh"

replace_cold=false
migrate_installed=false
migration_action=forward
expected_current_digest=
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
else
  printf '%s\n' \
    'usage: bootstrap-admin.sh [--replace-cold --expected-current-sha256 HEX]' \
    '       bootstrap-admin.sh --migrate-installed --expected-current-sha256 HEX [--rollback]' >&2
  exit 2
fi

require_privilege
require_commands install chmod find mv
require_pinned_node
if [[ "$migrate_installed" == true ]]; then
  # Reject the operator pin, source or legacy runtime before even creating the
  # deployment lock. Re-run the same preflight after taking the lock to close
  # the read/check race before the first durable migration mutation.
  preflight_installed_admin_migration "$expected_current_digest" "$migration_action"
  acquire_deploy_lock
  recover_admin_migration_temporaries \
    "$expected_current_digest" "$migration_action"
  preflight_installed_admin_migration "$expected_current_digest" "$migration_action"
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
