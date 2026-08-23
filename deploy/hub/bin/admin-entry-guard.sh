#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

guard_fail() {
  printf 'Hub admin entry rejected: %s\n' "$1" >&2
  exit 1
}

guard_stat_value() {
  local gnu_format=$1 bsd_format=$2 path=$3
  [[ -x /usr/bin/stat ]] || return 1
  if /usr/bin/stat -c "$gnu_format" "$path" >/dev/null 2>&1; then
    /usr/bin/stat -c "$gnu_format" "$path"
  else
    /usr/bin/stat -f "$bsd_format" "$path"
  fi
}

guard_mode_is_safe() {
  local mode=$1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 8#022) == 0))
}

guard_trusted_object() {
  local kind=$1 path=$2 expected_uid=$3 owner mode
  [[ ! -L "$path" ]] || guard_fail 'admin path contains a symbolic link'
  case "$kind" in
    directory) [[ -d "$path" ]] || guard_fail 'admin directory is missing' ;;
    file) [[ -f "$path" ]] || guard_fail 'admin file is missing' ;;
    *) guard_fail 'internal trust object kind is invalid' ;;
  esac
  owner="$(guard_stat_value '%u' '%u' "$path")" ||
    guard_fail 'admin path ownership cannot be inspected'
  mode="$(guard_stat_value '%a' '%Lp' "$path")" ||
    guard_fail 'admin path mode cannot be inspected'
  [[ "$owner" == "$expected_uid" ]] || guard_fail 'admin path has the wrong owner'
  guard_mode_is_safe "$mode" || guard_fail 'admin path is group/world writable'
}

(($# == 1)) || guard_fail 'exactly one admin entry path is required'
readonly ENTRY_SOURCE=$1
readonly ENTRY_NAME="${ENTRY_SOURCE##*/}"
case "$ENTRY_NAME" in
  install.sh | rollback.sh | upgrade.sh | validate-config.sh) ;;
  *) guard_fail 'admin entry is not allowlisted' ;;
esac

readonly REQUESTED_TEST_ROOT="${AGENT_OS_DEPLOY_TEST_ROOT:-}"
if [[ -n "$REQUESTED_TEST_ROOT" ]]; then
  [[ "${AGENT_OS_DEPLOY_TEST_MODE:-}" == 1 ]] ||
    guard_fail 'test root requires AGENT_OS_DEPLOY_TEST_MODE=1'
  ((EUID != 0)) || guard_fail 'test mode must never run as root'
  [[ "$REQUESTED_TEST_ROOT" == /* && "$REQUESTED_TEST_ROOT" != / && \
    "$REQUESTED_TEST_ROOT" != *'//'* && "$REQUESTED_TEST_ROOT" != *$'\n'* && \
    -d "$REQUESTED_TEST_ROOT" && ! -L "$REQUESTED_TEST_ROOT" ]] ||
    guard_fail 'test root must be a non-root canonical absolute directory'
  case "/$REQUESTED_TEST_ROOT/" in
    */../* | */./*) guard_fail 'test root contains dot path components' ;;
  esac
  canonical_test_root="$(CDPATH= cd -P -- "$REQUESTED_TEST_ROOT" 2>/dev/null && pwd -P)" ||
    guard_fail 'test root cannot be canonicalized'
  [[ "$canonical_test_root" == "$REQUESTED_TEST_ROOT" ]] ||
    guard_fail 'test root contains a symbolic or non-canonical component'
  marker="$REQUESTED_TEST_ROOT/.agent-os-deploy-test-root"
  nonce="${AGENT_OS_DEPLOY_TEST_NONCE:-}"
  [[ "$nonce" =~ ^[A-Za-z0-9_-]{32,128}$ ]] ||
    guard_fail 'test root nonce is missing or invalid'
  [[ -f "$marker" && ! -L "$marker" && "$(<"$marker")" == "$nonce" ]] ||
    guard_fail 'test root marker is missing or invalid'
  marker_mode="$(guard_stat_value '%a' '%Lp' "$marker")"
  marker_uid="$(guard_stat_value '%u' '%u' "$marker")"
  [[ "$marker_mode" == 600 && "$marker_uid" == "$EUID" ]] ||
    guard_fail 'test root marker ownership or mode is invalid'
  expected_uid=$EUID
  admin_bin="$REQUESTED_TEST_ROOT/usr/libexec/agent-os/hub/bin"
  trusted_directories=(
    "$REQUESTED_TEST_ROOT"
    "$REQUESTED_TEST_ROOT/usr"
    "$REQUESTED_TEST_ROOT/usr/libexec"
    "$REQUESTED_TEST_ROOT/usr/libexec/agent-os"
    "$REQUESTED_TEST_ROOT/usr/libexec/agent-os/hub"
    "$admin_bin"
  )
else
  expected_uid=0
  admin_bin=/usr/libexec/agent-os/hub/bin
  trusted_directories=(
    /
    /usr
    /usr/libexec
    /usr/libexec/agent-os
    /usr/libexec/agent-os/hub
    "$admin_bin"
  )
fi

readonly GUARD_SOURCE="${BASH_SOURCE[0]}"
[[ "$GUARD_SOURCE" == "$admin_bin/admin-entry-guard.sh" ]] ||
  guard_fail 'run guard from the fixed admin kit'
[[ "$ENTRY_SOURCE" == "$admin_bin/$ENTRY_NAME" ]] ||
  guard_fail 'run operation from the fixed admin kit'
for trusted_directory in "${trusted_directories[@]}"; do
  guard_trusted_object directory "$trusted_directory" "$expected_uid"
done
for trusted_file in \
  "$admin_bin/admin-entry-guard.sh" \
  "$ENTRY_SOURCE" \
  "$admin_bin/lib.sh" \
  "$admin_bin/validate-config.mjs"; do
  guard_trusted_object file "$trusted_file" "$expected_uid"
done
