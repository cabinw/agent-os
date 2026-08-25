#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

fail() {
  printf 'Hub recovery start rejected: %s\n' "$1" >&2
  exit 1
}

stat_value() {
  local gnu_format=$1 bsd_format=$2 path=$3
  if /usr/bin/stat -c "$gnu_format" "$path" >/dev/null 2>&1; then
    /usr/bin/stat -c "$gnu_format" "$path"
  else
    /usr/bin/stat -f "$bsd_format" "$path"
  fi
}

test_root="${AGENT_OS_DEPLOY_TEST_ROOT:-}"
if [[ -n "$test_root" ]]; then
  [[ "${AGENT_OS_DEPLOY_TEST_MODE:-}" == 1 && $EUID -ne 0 ]] ||
    fail 'test mode is invalid'
  [[ "$test_root" == /* && "$test_root" != / && -d "$test_root" && ! -L "$test_root" ]] ||
    fail 'test root is unsafe'
  case "/$test_root/" in
    */../* | */./*) fail 'test root contains dot components' ;;
  esac
  [[ "$(CDPATH= cd -P -- "$test_root" && pwd -P)" == "$test_root" ]] ||
    fail 'test root is non-canonical'
  marker="$test_root/.agent-os-deploy-test-root"
  nonce="${AGENT_OS_DEPLOY_TEST_NONCE:-}"
  [[ "$nonce" =~ ^[A-Za-z0-9_-]{32,128}$ && -f "$marker" && ! -L "$marker" && \
    "$(<"$marker")" == "$nonce" && "$(stat_value '%a' '%Lp' "$marker")" == 600 && \
    "$(stat_value '%u' '%u' "$marker")" == "$EUID" ]] ||
    fail 'test root marker is invalid'
fi

block="$test_root/var/lib/agent-os-ops/hub-block"
token="$test_root/run/agent-os/hub-recovery-start"
maintenance="$test_root/run/agent-os/hub-maintenance"
hard_maintenance="$test_root/run/agent-os/hub-maintenance-hard"
expected_uid=$EUID
maintenance_active=false
for sentinel in "$maintenance" "$hard_maintenance"; do
  if [[ -e "$sentinel" || -L "$sentinel" ]]; then
    [[ -f "$sentinel" && ! -L "$sentinel" && \
      "$(stat_value '%u' '%u' "$sentinel")" == "$expected_uid" && \
      "$(stat_value '%a' '%Lp' "$sentinel")" == 444 && \
      "$(stat_value '%h' '%l' "$sentinel")" == 1 ]] ||
      fail 'maintenance sentinel is unsafe'
    maintenance_active=true
  fi
done
if [[ ! -e "$block" && ! -L "$block" ]]; then
  [[ ! -e "$token" && ! -L "$token" ]] || fail 'orphan recovery start token exists'
  [[ "$maintenance_active" == false ]] || fail 'maintenance is active'
  exit 0
fi
[[ -f "$block" && ! -L "$block" ]] || fail 'persistent recovery block is unsafe'
[[ -f "$token" && ! -L "$token" ]] || fail 'persistent recovery block is active'
[[ "$(stat_value '%u' '%u' "$block")" == "$expected_uid" && \
  "$(stat_value '%a' '%Lp' "$block")" == 444 && \
  "$(stat_value '%h' '%l' "$block")" == 1 ]] ||
  fail 'persistent recovery block is unsafe'
[[ "$(stat_value '%u' '%u' "$token")" == "$expected_uid" && \
  "$(stat_value '%a' '%Lp' "$token")" == 400 && \
  "$(stat_value '%h' '%l' "$token")" == 1 ]] ||
  fail 'recovery start token is unsafe'
token_value="$(<"$token")"
[[ "$token_value" =~ ^((backup|restore|rollback|upgrade)-[A-Za-z0-9._-]{1,128}|recovery-pre-[A-Za-z0-9._-]{1,124})$ ]] ||
  fail 'recovery start token is invalid'
[[ "$(<"$block")" == "agent-os-hub-recovery-block-v1:$token_value" ]] ||
  fail 'recovery start token does not match the persistent block'
/bin/rm -f -- "$token"
[[ ! -e "$token" && ! -L "$token" ]] || fail 'recovery start token was not consumed'

printf '%s\n' 'hub_recovery_start_gate status=authorized'
