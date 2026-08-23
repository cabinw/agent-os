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
[[ "$ADMIN_ENTRY_SOURCE" == "$admin_bin/validate-config.sh" ]] || {
  printf '%s\n' 'Hub admin entry rejected: run validator from the fixed admin kit' >&2
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

require_pinned_node

exec "$NODE_BIN" "$SCRIPT_DIR/validate-config.mjs" "$@"
