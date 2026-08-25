#!/bin/bash -p
set -Eeuo pipefail

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

health_fail() {
  printf 'health check rejected: %s\n' "$1" >&2
  exit 1
}

health_stat_value() {
  local gnu_format=$1 bsd_format=$2 path=$3
  [[ -x /usr/bin/stat ]] || return 1
  if /usr/bin/stat -c "$gnu_format" "$path" >/dev/null 2>&1; then
    /usr/bin/stat -c "$gnu_format" "$path"
  else
    /usr/bin/stat -f "$bsd_format" "$path"
  fi
}

health_mode_is_safe() {
  local mode=$1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 8#022) == 0))
}

health_trusted_object() {
  local kind=$1 path=$2 expected_uid=$3 owner mode
  [[ ! -L "$path" ]] || health_fail 'admin path contains a symbolic link'
  case "$kind" in
    directory) [[ -d "$path" ]] || health_fail 'admin directory is missing' ;;
    file) [[ -f "$path" ]] || health_fail 'admin file is missing' ;;
    *) health_fail 'internal trust object kind is invalid' ;;
  esac
  owner="$(health_stat_value '%u' '%u' "$path")" ||
    health_fail 'admin path ownership cannot be inspected'
  mode="$(health_stat_value '%a' '%Lp' "$path")" ||
    health_fail 'admin path mode cannot be inspected'
  [[ "$owner" == "$expected_uid" ]] || health_fail 'admin path has the wrong owner'
  health_mode_is_safe "$mode" || health_fail 'admin path is group/world writable'
}

readonly HEALTH_SOURCE="${BASH_SOURCE[0]}"
readonly REQUESTED_TEST_ROOT="${AGENT_OS_DEPLOY_TEST_ROOT:-}"
if [[ -n "$REQUESTED_TEST_ROOT" ]]; then
  [[ "${AGENT_OS_DEPLOY_TEST_MODE:-}" == 1 ]] ||
    health_fail 'test root requires AGENT_OS_DEPLOY_TEST_MODE=1'
  ((EUID != 0)) || health_fail 'test mode must never run as root'
  [[ "$REQUESTED_TEST_ROOT" == /* && "$REQUESTED_TEST_ROOT" != / && \
    "$REQUESTED_TEST_ROOT" != *'//'* && "$REQUESTED_TEST_ROOT" != *$'\n'* && \
    -d "$REQUESTED_TEST_ROOT" && ! -L "$REQUESTED_TEST_ROOT" ]] ||
    health_fail 'test root must be a non-root canonical absolute directory'
  case "/$REQUESTED_TEST_ROOT/" in
    */../* | */./*) health_fail 'test root contains dot path components' ;;
  esac
  canonical_test_root="$(CDPATH= cd -P -- "$REQUESTED_TEST_ROOT" 2>/dev/null && pwd -P)" ||
    health_fail 'test root cannot be canonicalized'
  [[ "$canonical_test_root" == "$REQUESTED_TEST_ROOT" ]] ||
    health_fail 'test root contains a symbolic or non-canonical component'
  marker="$REQUESTED_TEST_ROOT/.agent-os-deploy-test-root"
  nonce="${AGENT_OS_DEPLOY_TEST_NONCE:-}"
  [[ "$nonce" =~ ^[A-Za-z0-9_-]{32,128}$ ]] ||
    health_fail 'test root nonce is missing or invalid'
  [[ -f "$marker" && ! -L "$marker" && "$(<"$marker")" == "$nonce" ]] ||
    health_fail 'test root marker is missing or invalid'
  marker_mode="$(health_stat_value '%a' '%Lp' "$marker")"
  marker_uid="$(health_stat_value '%u' '%u' "$marker")"
  [[ "$marker_mode" == 600 && "$marker_uid" == "$EUID" ]] ||
    health_fail 'test root marker ownership or mode is invalid'
  expected_uid=$EUID
  expected_script_dir="$REQUESTED_TEST_ROOT/usr/libexec/agent-os/hub/bin"
  trusted_directories=(
    "$REQUESTED_TEST_ROOT"
    "$REQUESTED_TEST_ROOT/usr"
    "$REQUESTED_TEST_ROOT/usr/libexec"
    "$REQUESTED_TEST_ROOT/usr/libexec/agent-os"
    "$REQUESTED_TEST_ROOT/usr/libexec/agent-os/hub"
    "$expected_script_dir"
  )
else
  expected_uid=0
  expected_script_dir=/usr/libexec/agent-os/hub/bin
  trusted_directories=(
    /
    /usr
    /usr/libexec
    /usr/libexec/agent-os
    /usr/libexec/agent-os/hub
    "$expected_script_dir"
  )
fi

[[ "$HEALTH_SOURCE" == "$expected_script_dir/health-check.sh" ]] ||
  health_fail 'run health check from the fixed admin kit'
for trusted_directory in "${trusted_directories[@]}"; do
  health_trusted_object directory "$trusted_directory" "$expected_uid"
done
for trusted_file in \
  "$expected_script_dir/health-check.sh" \
  "$expected_script_dir/validate-config.sh" \
  "$expected_script_dir/lib.sh" \
  "$expected_script_dir/validate-config.mjs"; do
  health_trusted_object file "$trusted_file" "$expected_uid"
done

readonly SCRIPT_DIR="$expected_script_dir"
readonly VALIDATOR="$SCRIPT_DIR/validate-config.sh"
if [[ -n "$REQUESTED_TEST_ROOT" ]]; then
  CURL_BIN="${AGENT_OS_CURL_BIN:-/usr/bin/curl}"
  SYSTEMCTL_BIN="${AGENT_OS_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
  SS_BIN="${AGENT_OS_SS_BIN:-/usr/bin/ss}"
else
  if [[ -n "${AGENT_OS_CURL_BIN:-}" && "$AGENT_OS_CURL_BIN" != /usr/bin/curl ]]; then
    printf '%s\n' 'health check rejected: production CURL override is forbidden' >&2
    exit 1
  fi
  if [[ -n "${AGENT_OS_SYSTEMCTL_BIN:-}" && \
    "$AGENT_OS_SYSTEMCTL_BIN" != /usr/bin/systemctl ]]; then
    printf '%s\n' 'health check rejected: production SYSTEMCTL override is forbidden' >&2
    exit 1
  fi
  if [[ -n "${AGENT_OS_SS_BIN:-}" && "$AGENT_OS_SS_BIN" != /usr/bin/ss ]]; then
    printf '%s\n' 'health check rejected: production SS override is forbidden' >&2
    exit 1
  fi
  CURL_BIN=/usr/bin/curl
  SYSTEMCTL_BIN=/usr/bin/systemctl
  SS_BIN=/usr/bin/ss
fi
readonly CURL_BIN SYSTEMCTL_BIN SS_BIN

env_file=/etc/agent-os/hub.env
unit=agent-os-hub.service
candidate=
probe=ready
attempts=1
interval=2

usage() {
  printf '%s\n' \
    'usage: health-check.sh [--config PATH] [--unit UNIT] [--candidate REVISION] [--live|--ready|--quiescent] [--attempts N] [--interval SECONDS]' >&2
}

while (($# > 0)); do
  case "$1" in
    --config | --unit | --candidate | --attempts | --interval)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --config) env_file=$2 ;;
        --unit) unit=$2 ;;
        --candidate) candidate=$2 ;;
        --attempts) attempts=$2 ;;
        --interval) interval=$2 ;;
      esac
      shift 2
      ;;
    --live) probe=live; shift ;;
    --ready) probe=ready; shift ;;
    --quiescent) probe=quiescent; shift ;;
    *) usage; exit 2 ;;
  esac
done

[[ "$unit" =~ ^[A-Za-z0-9_.@-]+[.]service$ && ${#unit} -le 256 ]] || {
  printf '%s\n' 'health check rejected: unit name is invalid' >&2
  exit 2
}
if [[ -n "$candidate" ]]; then
  [[ "$candidate" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
    printf '%s\n' 'health check rejected: candidate revision is invalid' >&2
    exit 2
  }
fi
[[ "$attempts" =~ ^[1-9][0-9]*$ ]] && ((attempts <= 120)) || {
  printf '%s\n' 'health check rejected: attempts must be 1..120' >&2
  exit 2
}
[[ "$interval" =~ ^[0-9]+$ ]] && ((interval <= 30)) || {
  printf '%s\n' 'health check rejected: interval must be 0..30 seconds' >&2
  exit 2
}
for executable in "$CURL_BIN" "$SYSTEMCTL_BIN" "$SS_BIN"; do
  command -v "$executable" >/dev/null 2>&1 || {
    printf '%s\n' 'health check failed: a required executable is unavailable' >&2
    exit 1
  }
done

validator_arguments=(--print-port)
[[ -n "$candidate" ]] && validator_arguments+=(--candidate "$candidate")
validator_arguments+=("$env_file")
port="$($VALIDATOR "${validator_arguments[@]}")"
url="http://127.0.0.1:${port}/health/${probe}"
expected_body='{"status":"ready"}'
[[ "$probe" == live ]] && expected_body='{"status":"ok"}'
[[ "$probe" == quiescent ]] && expected_body='{"status":"quiescent"}'

managed_listener() {
  local pid=$1 output line matched=false
  output="$($SS_BIN -H -ltnp "sport = :$port" 2>/dev/null || true)"
  [[ -n "$output" ]] || return 1
  while IFS= read -r line; do
    [[ "$line" == *"127.0.0.1:${port}"* && "$line" == *"pid=${pid},"* ]] || return 1
    matched=true
  done <<<"$output"
  [[ "$matched" == true ]]
}

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  active=false
  "$SYSTEMCTL_BIN" is-active --quiet "$unit" >/dev/null 2>&1 && active=true
  main_pid="$($SYSTEMCTL_BIN show --property=MainPID --value "$unit" 2>/dev/null || true)"
  response=
  if [[ "$active" == true && "$main_pid" =~ ^[1-9][0-9]*$ ]] && ((main_pid > 1)) &&
    managed_listener "$main_pid"; then
    response="$($CURL_BIN \
      --silent \
      --show-error \
      --max-filesize 1024 \
      --write-out $'\n%{http_code}' \
      --connect-timeout 2 \
      --max-time 5 \
      --noproxy '*' \
      "$url" 2>/dev/null || true)"
    status="${response##*$'\n'}"
    body="${response%$'\n'*}"
    confirmed_pid="$($SYSTEMCTL_BIN show --property=MainPID --value "$unit" 2>/dev/null || true)"
    if [[ "$status" == 200 && "$body" == "$expected_body" && \
      "$confirmed_pid" == "$main_pid" ]] && \
      "$SYSTEMCTL_BIN" is-active --quiet "$unit" >/dev/null 2>&1 && \
      managed_listener "$confirmed_pid"; then
      printf '{"component":"hub","probe":"%s","ok":true}\n' "$probe"
      exit 0
    fi
  fi
  if ((attempt < attempts)); then sleep "$interval"; fi
done

printf '{"component":"hub","probe":"%s","ok":false}\n' "$probe" >&2
exit 1
