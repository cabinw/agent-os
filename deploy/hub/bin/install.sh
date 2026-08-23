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
[[ "$ADMIN_ENTRY_SOURCE" == "$admin_bin/install.sh" ]] || {
  printf '%s\n' 'Hub admin entry rejected: run install from the fixed admin kit' >&2
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

archive=
checksum=
install_revision=
source_env=
STAGING_PATH=
ARTIFACT_COPY=
ENV_STAGING_PATH=
commit_started=false
install_succeeded=false
environment_publish_attempted=false
unit_publish_attempted=false
candidate_unit_publish_attempted=false
nginx_publish_attempted=false
nginx_limits_publish_attempted=false
environment_example_publish_attempted=false
pointer_publish_attempted=false
daemon_reload_attempted=false
service_start_attempted=false
service_enable_attempted=false

usage() {
  printf '%s\n' \
    'usage: install.sh --archive FILE --sha256 HEX --revision ID --env-file FILE' >&2
}

cleanup_environment_candidate() {
  [[ -n "$ENV_STAGING_PATH" ]] || return 0
  [[ "$(dirname -- "$ENV_STAGING_PATH")" == "$CONFIG_ROOT" ]] || {
    printf '%s\n' 'refusing environment cleanup outside the configuration root' >&2
    return 1
  }
  case "$(basename -- "$ENV_STAGING_PATH")" in
    .hub.env.*) ;;
    *)
      printf '%s\n' 'refusing environment cleanup for an unowned filename' >&2
      return 1
      ;;
  esac
  rm -f -- "$ENV_STAGING_PATH" || return 1
  ENV_STAGING_PATH=
}

inject_publish_failure() {
  local label=$1 marker=${AGENT_OS_DEPLOY_FAIL_PUBLISH_ONCE:-}
  [[ -n "$TEST_ROOT" && -n "$marker" ]] || return 0
  [[ -f "$marker" && ! -L "$marker" ]] || return 0
  [[ "$(<"$marker")" == "$label" ]] || return 0
  rm -f -- "$marker"
  die 'test-only install publication fault injected'
}

remove_attempted_file() {
  local attempted=$1 path=$2
  [[ "$attempted" == true ]] || return 0
  [[ ! -L "$path" ]] || return 1
  rm -f -- "$path"
}

rollback_failed_install() {
  local rollback_ok=true
  [[ "$commit_started" == true && "$install_succeeded" != true ]] || return 0
  if [[ "$service_start_attempted" == true ]]; then
    service_control stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if ! service_is_inactive; then
      (maintenance_on) >/dev/null 2>&1 || true
      (maintenance_fail_closed) >/dev/null 2>&1 || true
      printf '%s\n' 'failed initial process is still active; deployment was left fail-closed for operator recovery' >&2
      return 1
    fi
  fi
  if [[ "$service_enable_attempted" == true ]]; then
    service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    service_is_disabled || rollback_ok=false
  fi
  if [[ "$pointer_publish_attempted" == true && \
    "$(read_revision_link "$CURRENT_LINK" 2>/dev/null || true)" == "$install_revision" ]]; then
    (remove_revision_link "$CURRENT_LINK") || rollback_ok=false
  fi
  remove_attempted_file "$environment_publish_attempted" "$ENV_FILE" || rollback_ok=false
  remove_attempted_file "$unit_publish_attempted" "$UNIT_PATH" || rollback_ok=false
  remove_attempted_file "$candidate_unit_publish_attempted" "$CANDIDATE_UNIT_PATH" ||
    rollback_ok=false
  remove_attempted_file "$nginx_publish_attempted" "$NGINX_EXAMPLE_PATH" || rollback_ok=false
  remove_attempted_file "$nginx_limits_publish_attempted" "$NGINX_LIMITS_EXAMPLE_PATH" ||
    rollback_ok=false
  remove_attempted_file \
    "$environment_example_publish_attempted" \
    "$CONFIG_ROOT/hub.env.example" || rollback_ok=false
  if [[ "$daemon_reload_attempted" == true ]]; then
    service_control daemon-reload >/dev/null 2>&1 || rollback_ok=false
  fi
  if [[ "$rollback_ok" != true ]]; then
    (maintenance_on) >/dev/null 2>&1 || true
    (maintenance_fail_closed) >/dev/null 2>&1 || true
    return 1
  fi
  notice install_rollback ok
}

finish() {
  local result=$?
  trap - EXIT
  cleanup_staging || result=1
  cleanup_environment_candidate || result=1
  rollback_failed_install || result=1
  exit "$result"
}
trap finish EXIT

while (($# > 0)); do
  case "$1" in
    --archive | --sha256 | --revision | --env-file)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --archive) archive=$2 ;;
        --sha256) checksum=$2 ;;
        --revision) install_revision=$2 ;;
        --env-file) source_env=$2 ;;
      esac
      shift 2
      ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$archive" && -n "$checksum" && -n "$install_revision" && -n "$source_env" ]] || {
  usage
  exit 2
}
require_privilege
require_fixed_admin_execution
require_commands install find chmod chown mv ln readlink awk tr
require_pinned_node
acquire_deploy_lock
require_clean_maintenance_state
ensure_layout

[[ -f "$source_env" && ! -L "$source_env" ]] || die 'source environment must be a regular file'
[[ ! -e "$ENV_FILE" && ! -L "$ENV_FILE" ]] || die 'Hub environment already exists; install never overwrites it'
[[ ! -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]] || die 'Hub is already installed; use upgrade'
[[ ! -e "$PREVIOUS_LINK" && ! -L "$PREVIOUS_LINK" ]] ||
  die 'fresh install requires no previous release pointer'
for target in \
  "$UNIT_PATH" \
  "$CANDIDATE_UNIT_PATH" \
  "$NGINX_EXAMPLE_PATH" \
  "$NGINX_LIMITS_EXAMPLE_PATH" \
  "$CONFIG_ROOT/hub.env.example"; do
  [[ ! -e "$target" && ! -L "$target" ]] || die 'Hub deployment target already exists'
done
service_is_inactive || die 'fresh install requires the Hub service to be inactive'
if ! service_is_disabled; then
  die 'fresh install requires the Hub service to be disabled'
fi

# Complete all checks and immutable release extraction before publishing any
# service configuration, secret, pointer or enabled unit.
ENV_STAGING_PATH="$CONFIG_ROOT/.hub.env.$$"
[[ ! -e "$ENV_STAGING_PATH" && ! -L "$ENV_STAGING_PATH" ]] ||
  die 'environment staging path already exists'
"$NODE_BIN" "$ADMIN_ROOT/bin/copy-artifact.mjs" "$source_env" "$ENV_STAGING_PATH"
chmod 0600 "$ENV_STAGING_PATH"
if [[ -z "$TEST_ROOT" ]]; then chown root:root "$ENV_STAGING_PATH"; fi
AGENT_OS_NODE_BIN="$NODE_BIN" "$ADMIN_ROOT/bin/validate-config.sh" "$ENV_STAGING_PATH"
stage_release "$archive" "$checksum" "$install_revision"

commit_started=true
environment_publish_attempted=true
inject_publish_failure environment
mv "$ENV_STAGING_PATH" "$ENV_FILE"
ENV_STAGING_PATH=
unit_publish_attempted=true
inject_publish_failure unit
install_regular_file 0644 root root "$ADMIN_ROOT/systemd/agent-os-hub.service" "$UNIT_PATH"
candidate_unit_publish_attempted=true
inject_publish_failure candidate-unit
install_regular_file \
  0644 root root \
  "$ADMIN_ROOT/systemd/agent-os-hub-candidate@.service" \
  "$CANDIDATE_UNIT_PATH"
nginx_publish_attempted=true
inject_publish_failure nginx
install_regular_file 0644 root root "$ADMIN_ROOT/nginx/agent-os-hub.conf" "$NGINX_EXAMPLE_PATH"
nginx_limits_publish_attempted=true
inject_publish_failure nginx-limits
install_regular_file \
  0644 root root \
  "$ADMIN_ROOT/nginx/agent-os-hub-limits.conf" \
  "$NGINX_LIMITS_EXAMPLE_PATH"
environment_example_publish_attempted=true
inject_publish_failure environment-example
install_regular_file 0600 root root "$ADMIN_ROOT/env.example" "$CONFIG_ROOT/hub.env.example"
pointer_publish_attempted=true
activate_revision "$install_revision"
daemon_reload_attempted=true
service_control daemon-reload
service_start_attempted=true
service_control start "$SERVICE_NAME" || die 'service failed to start'
health_gate live || die 'initial activation failed its exact liveness gate'
service_enable_attempted=true
service_enable
install_succeeded=true
notice install ok
