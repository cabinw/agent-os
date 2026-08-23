#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly HUB_ROOT="$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(CDPATH= cd -- "$HUB_ROOT/../.." && pwd -P)"
readonly REAL_NODE_BIN=/usr/bin/node
readonly REAL_COREPACK_BIN=/usr/bin/corepack
readonly TEMPORARY_PARENT="$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)"
temporary=

fail() {
  printf 'hub deploy gate failed: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [[ -n "$temporary" && -d "$temporary" && ! -L "$temporary" ]] || return 0
  [[ "$(dirname -- "$temporary")" == "$TEMPORARY_PARENT" ]] || {
    printf '%s\n' 'refusing test cleanup outside the owned temporary parent' >&2
    return 1
  }
  case "$(basename -- "$temporary")" in
    agent-os-hub-test.*) ;;
    *)
      printf '%s\n' 'refusing test cleanup for an unowned directory name' >&2
      return 1
      ;;
  esac
  find "$temporary" -type d -exec chmod u+rwx {} + || return 1
  find "$temporary" -type f -exec chmod u+rw {} + || return 1
  rm -rf -- "$temporary" || return 1
  [[ ! -e "$temporary" ]] || return 1
  temporary=
}

finish() {
  local result=$?
  trap - EXIT
  cleanup || result=1
  exit "$result"
}
trap finish EXIT

assert_contains() {
  local file=$1 literal=$2
  grep -Fq -- "$literal" "$file" || fail "missing required static policy: $literal"
}

expect_failure() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then fail "$label"; fi
}

expect_failure_message() {
  local label=$1 expected=$2 output
  shift 2
  if output="$("$@" 2>&1)"; then fail "$label"; fi
  [[ "$output" == "$expected" ]] || fail "$label (wrong rejection reason)"
}

if (
  expect_failure_message \
    'exact failure matcher accepted trailing diagnostics' \
    expected-only \
    /bin/bash -p -c 'printf "%s\n%s\n" expected-only unexpected >&2; exit 1'
) >/dev/null 2>&1; then
  fail 'failure-message gate is not an exact whole-output assertion'
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[[ -z "${AGENT_OS_NODE_BIN:-}" || "$AGENT_OS_NODE_BIN" == "$REAL_NODE_BIN" ]] ||
  fail 'deploy gate rejects an alternate Node entry'
[[ -z "${AGENT_OS_COREPACK_BIN:-}" || "$AGENT_OS_COREPACK_BIN" == "$REAL_COREPACK_BIN" ]] ||
  fail 'deploy gate rejects an alternate Corepack entry'
[[ -f "$REAL_NODE_BIN" && -x "$REAL_NODE_BIN" ]] ||
  fail 'pinned Node executable /usr/bin/node is unavailable'
[[ -f "$REAL_COREPACK_BIN" && -x "$REAL_COREPACK_BIN" ]] ||
  fail 'pinned Corepack executable /usr/bin/corepack is unavailable'
temporary="$(mktemp -d "$TEMPORARY_PARENT/agent-os-hub-test.XXXXXX")"

(
  unset AGENT_OS_DEPLOY_TEST_ROOT AGENT_OS_DEPLOY_TEST_MODE AGENT_OS_DEPLOY_TEST_NONCE
  export AGENT_OS_NODE_BIN="$REAL_NODE_BIN"
  # shellcheck source=/dev/null
  source "$HUB_ROOT/bin/lib.sh"
  require_pinned_node
  resolve_trusted_executable Corepack "$REAL_COREPACK_BIN"
) || fail 'Node/Corepack trust-chain preflight failed'

# Static and parser gates.
while IFS= read -r script; do bash -n "$script"; done < <(
  find "$HUB_ROOT" -type f -name '*.sh' -print
)
while IFS= read -r module; do "$REAL_NODE_BIN" --check "$module" >/dev/null; done < <(
  find "$HUB_ROOT" -type f -name '*.mjs' -print
)
if command -v shellcheck >/dev/null 2>&1; then
  while IFS= read -r script; do shellcheck -x "$script"; done < <(
    find "$HUB_ROOT" -type f -name '*.sh' -print
  )
fi
biome_entry="$REPOSITORY_ROOT/node_modules/@biomejs/biome/bin/biome"
if [[ -f "$biome_entry" ]]; then
  "$REAL_NODE_BIN" "$biome_entry" check "$HUB_ROOT"/bin/*.mjs >/dev/null
fi

unit="$HUB_ROOT/systemd/agent-os-hub.service"
candidate_unit="$HUB_ROOT/systemd/agent-os-hub-candidate@.service"
for policy in \
  'User=agent-os' \
  'Group=agent-os' \
  'EnvironmentFile=/etc/agent-os/hub.env' \
  'ExecStartPre=+/usr/libexec/agent-os/hub/bin/validate-config.sh /etc/agent-os/hub.env' \
  'UMask=0077' \
  'StateDirectoryMode=0700' \
  'ProtectSystem=strict' \
  'Restart=on-failure' \
  'TimeoutStopSec=45s' \
  'MemoryHigh=384M' \
  'MemoryMax=512M' \
  'TasksMax=64' \
  'LimitNOFILE=4096' \
  'LimitCORE=0' \
  'CPUQuota=150%' \
  'OOMPolicy=stop' \
  'CapabilityBoundingSet=' \
  'AmbientCapabilities='; do
  assert_contains "$unit" "$policy"
done
grep -Fq '/opt/agent-os/current/deploy/' "$unit" &&
  fail 'production unit executes privileged content from the application release'
for policy in \
  'User=agent-os-candidate' \
  'Group=agent-os-candidate' \
  'EnvironmentFile=/run/agent-os/hub-candidates/%i.env' \
  'ExecStartPre=+/usr/libexec/agent-os/hub/bin/validate-config.sh --candidate %i' \
  'ReadWritePaths=/var/lib/agent-os/hub-candidates/%i' \
  'InaccessiblePaths=/var/lib/agent-os/hub /etc/agent-os/hub.env' \
  'ProtectProc=invisible' \
  'MemoryMax=512M' \
  'TasksMax=64' \
  'CapabilityBoundingSet=' \
  'AmbientCapabilities='; do
  assert_contains "$candidate_unit" "$policy"
done

nginx="$HUB_ROOT/nginx/agent-os-hub.conf"
limits="$HUB_ROOT/nginx/agent-os-hub-limits.conf"
for policy in \
  'listen 443 ssl http2;' \
  'proxy_pass http://127.0.0.1:4173;' \
  'proxy_set_header Authorization $http_authorization;' \
  'proxy_set_header Origin $http_origin;' \
  'location = /health/live {' \
  'location = /health/ready {' \
  'location ^~ /runner/v1/ {' \
  'proxy_request_buffering off;' \
  'proxy_buffering off;' \
  'access_log off;' \
  'error_log /var/log/nginx/agent-os-hub-error.log crit;' \
  'if ($is_args != "") {' \
  'limit_conn agent_os_conn' \
  'limit_req zone=agent_os_api' \
  '/run/agent-os/hub-maintenance-hard'; do
  assert_contains "$nginx" "$policy"
done
[[ "$(grep -Fc '/run/agent-os/hub-maintenance)' "$nginx")" == 3 ]] ||
  fail 'normal maintenance must block events, Runner and general ingress'
[[ "$(grep -Fc '/run/agent-os/hub-maintenance-hard)' "$nginx")" == 3 ]] ||
  fail 'hard maintenance must block every proxied namespace'
runner_location="$(sed -n '/location \^~ \/runner\/v1\//,/^    }/p' "$nginx")"
[[ "$runner_location" == *'/run/agent-os/hub-maintenance)'* ]] ||
  fail 'normal maintenance does not block Runner reconnect'
[[ "$runner_location" == *'/run/agent-os/hub-maintenance-hard)'* ]] ||
  fail 'hard maintenance does not block Runner reconnect'
[[ "$(grep -Fc 'return 404;' "$nginx")" == 2 ]] ||
  fail 'both public health routes must terminate locally with 404'
grep -Fq 'proxy_ssl_verify off' "$nginx" && fail 'proxy example disables TLS verification'
grep -Fq 'listen 80' "$nginx" && fail 'proxy example adds a public cleartext listener'
grep -Eq '\$(request|request_uri|args)([^A-Za-z0-9_]|$)' "$nginx" &&
  fail 'proxy example references a log-sensitive request target variable'
for policy in \
  'limit_conn_zone $binary_remote_addr zone=agent_os_conn:10m;' \
  'limit_req_zone $binary_remote_addr zone=agent_os_api:10m rate=10r/s;' \
  'limit_req_zone $binary_remote_addr zone=agent_os_runner:10m rate=20r/s;'; do
  assert_contains "$limits" "$policy"
done
assert_contains "$HUB_ROOT/env.example" "AGENT_OS_AGENT_TOKENS='{\"claude\":"
assert_contains "$REPOSITORY_ROOT/deploy/README.md" '| `PORT` | exactly `4173`'
assert_contains "$REPOSITORY_ROOT/deploy/README.md" '`/run/agent-os/hub-deploy.lock`'
assert_contains "$HUB_ROOT/bin/lib.sh" 'readonly CANDIDATE_SERVICE_USER=agent-os-candidate'
assert_contains "$HUB_ROOT/bin/lib.sh" '"$CANDIDATE_SERVICE_USER" \'
assert_contains "$HUB_ROOT/bin/lib.sh" '[[ "$group_ids" == "$numeric_gid" ]]'
assert_contains "$HUB_ROOT/bin/lib.sh" 'service identity UID and GID must both be non-root'
assert_contains "$HUB_ROOT/bin/lib.sh" 'service identity UID must map to exactly one passwd entry'
assert_contains "$HUB_ROOT/bin/lib.sh" 'live and candidate services must use distinct numeric UIDs'
assert_contains "$HUB_ROOT/bin/lib.sh" 'live and candidate services must use distinct numeric GIDs'
normal_remove_line="$(grep -nF 'rm -f -- "$MAINTENANCE_PATH"' "$HUB_ROOT/bin/lib.sh" | cut -d: -f1)"
hard_remove_line="$(grep -nF 'rm -f -- "$FAIL_CLOSED_PATH"' "$HUB_ROOT/bin/lib.sh" | cut -d: -f1)"
((normal_remove_line < hard_remove_line)) ||
  fail 'maintenance removal does not keep the hard sentinel until last'
for operation in install upgrade rollback; do
  lock_line="$(grep -nF 'acquire_deploy_lock' "$HUB_ROOT/bin/$operation.sh" | cut -d: -f1)"
  clean_gate_line="$(grep -nF 'require_clean_maintenance_state' "$HUB_ROOT/bin/$operation.sh" | cut -d: -f1)"
  layout_line="$(grep -nF 'ensure_layout' "$HUB_ROOT/bin/$operation.sh" | cut -d: -f1)"
  ((lock_line < clean_gate_line)) ||
    fail "$operation does not serialize its fail-closed maintenance check"
  ((clean_gate_line < layout_line)) ||
    fail "$operation mutates the deployment layout before rejecting fail-closed maintenance"
done
assert_contains "$HUB_ROOT/bin/upgrade.sh" 'state_after_snapshot="$(state_fingerprint)"'
assert_contains "$HUB_ROOT/bin/upgrade.sh" '[[ "$state_after_snapshot" == "$state_before" ]]'
assert_contains "$HUB_ROOT/bin/upgrade.sh" \
  'readonly FIXED_SNAPSHOT_HOOK="$(rooted /usr/libexec/agent-os/hub/pre-upgrade-snapshot)"'
assert_contains "$HUB_ROOT/bin/upgrade.sh" 'prepare_snapshot_hook "$snapshot_hook"'
assert_contains "$HUB_ROOT/bin/upgrade.sh" '"$SNAPSHOT_HOOK_COPY" "$STATE_ROOT" "$snapshot_path"'
assert_contains "$HUB_ROOT/bin/lib.sh" '[[ "$owner" == "$expected_uid" && "$links" == 1 ]]'
assert_contains "$HUB_ROOT/bin/lib.sh" '"$NODE_BIN" "$ADMIN_ROOT/bin/copy-artifact.mjs" "$source" "$copy"'
assert_contains "$HUB_ROOT/bin/lib.sh" 'mode_is_safe() {'
assert_contains "$HUB_ROOT/bin/lib.sh" 'stat_value() {'
assert_contains "$HUB_ROOT/bin/lib.sh" 'resolve_trusted_executable() {'
assert_contains "$HUB_ROOT/bin/lib.sh" 'bin/admin-entry-guard.sh \'
assert_contains "$HUB_ROOT/bin/validate-config.sh" 'require_pinned_node'
assert_contains "$HUB_ROOT/bin/lib.sh" 'readonly EXPECTED_NODE_VERSION=24.19.0'
assert_contains "$HUB_ROOT/bin/lib.sh" 'readonly EXPECTED_COREPACK_VERSION=0.35.0'
assert_contains "$unit" 'ExecStart=/usr/bin/node /opt/agent-os/current/apps/chat-spike/src/server.mjs'
assert_contains "$candidate_unit" \
  'ExecStart=/usr/bin/node /opt/agent-os/releases/%i/apps/chat-spike/src/server.mjs'
for influence in OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_ENGINES OPENSSL_MODULES; do
  assert_contains "$HUB_ROOT/bin/lib.sh" "$influence"
  assert_contains "$HUB_ROOT/bin/package-release.sh" "$influence"
done
assert_contains "$HUB_ROOT/bin/health-check.sh" '"$expected_script_dir/validate-config.mjs"'
for admin_entry in install upgrade rollback validate-config; do
  assert_contains "$HUB_ROOT/bin/$admin_entry.sh" 'readonly ADMIN_ENTRY_GUARD='
done
grep -Eq 'stat -f .*\|\| stat -c' "$HUB_ROOT/bin/lib.sh" &&
  fail 'portable stat fallback can contaminate GNU stat output'
[[ "$(grep -Ec '^[[:space:]]*mode_is_safe "\$' "$HUB_ROOT/bin/lib.sh")" == 11 ]] ||
  fail 'filesystem mode policy is not centralized through mode_is_safe'
mode_helper_line="$(grep -nF 'mode_is_safe() {' "$HUB_ROOT/bin/lib.sh" | cut -d: -f1)"
raw_mode_expression_lines="$(grep -En \
  '&[[:space:]]+(8#)?0*22.*==[[:space:]]*0' "$HUB_ROOT/bin/lib.sh" || true)"
[[ "$(printf '%s\n' "$raw_mode_expression_lines" | grep -c .)" == 1 ]] ||
  fail 'raw filesystem mode bit tests exist outside the centralized helper'
mode_expression_line="${raw_mode_expression_lines%%:*}"
((mode_expression_line > mode_helper_line && mode_expression_line <= mode_helper_line + 4)) ||
  fail 'raw filesystem mode bit test escaped mode_is_safe'
packager="$HUB_ROOT/bin/package-release.sh"
for policy in \
  'pnpm@11.17.0' \
  'HOME="$temporary/home"' \
  'COREPACK_ENV_FILE=0' \
  '--frozen-lockfile' \
  '--ignore-scripts' \
  '--config.node-linker=hoisted' \
  '--config.package-import-method=copy' \
  'await import("@modelcontextprotocol/sdk/server")' \
  'await import("zod")'; do
  assert_contains "$packager" "$policy"
done

# Strict EnvironmentFile grammar and secret non-disclosure.
good_env="$temporary/good.env"
cat >"$good_env" <<'ENV'
HOST=127.0.0.1
PORT=4173
LOG_PATH=/var/lib/agent-os/hub/events.jsonl
AGENT_OS_REMOTE_STATE_PATH=/var/lib/agent-os/hub/remote-placement.json
AGENT_OS_RUNNER_MODE=remote
AGENT_OS_RUNNER_ID=test-runner-01
AGENT_OS_RUNNER_TOKEN=test-only-runner-000000000000000000000001
AGENT_OS_HUMAN_TOKEN=test-only-human-0000000000000000000000002
AGENT_OS_AGENT_TOKENS='{"claude":"test-only-claude-00000000000000000000003","grok":"test-only-grok-0000000000000000000000004","kimi":"test-only-kimi-0000000000000000000000005","codex":"test-only-codex-000000000000000000000006"}'
AGENT_OS_ALLOWED_ORIGINS=https://hub.staging.example.com
HOP_BUDGET=6
ENV
chmod 0600 "$good_env"
"$REAL_NODE_BIN" "$HUB_ROOT/bin/validate-config.mjs" "$good_env"

expect_config_rejection() {
  local path=$1 output
  if output="$("$REAL_NODE_BIN" "$HUB_ROOT/bin/validate-config.mjs" "$path" 2>&1)"; then
    fail 'invalid configuration was accepted'
  fi
  case "$output" in
    *test-only-runner-* | *test-only-human-* | *test-only-claude-* | *test-only-grok-* | *test-only-kimi-* | *test-only-codex-*)
      fail 'configuration rejection leaked a test credential'
      ;;
  esac
}

write_runner_token() {
  local target=$1 token=$2 line
  while IFS= read -r line; do
    if [[ "$line" == AGENT_OS_RUNNER_TOKEN=* ]]; then
      printf 'AGENT_OS_RUNNER_TOKEN=%s\n' "$token"
    else
      printf '%s\n' "$line"
    fi
  done <"$good_env" >"$target"
  chmod 0600 "$target"
}

sed '/^AGENT_OS_HUMAN_TOKEN=/d' "$good_env" >"$temporary/missing.env"
chmod 0600 "$temporary/missing.env"
expect_config_rejection "$temporary/missing.env"
sed 's/^AGENT_OS_HUMAN_TOKEN=.*/AGENT_OS_HUMAN_TOKEN=short/' "$good_env" >"$temporary/short.env"
chmod 0600 "$temporary/short.env"
expect_config_rejection "$temporary/short.env"
sed 's/^HOST=.*/HOST=0.0.0.0/' "$good_env" >"$temporary/public.env"
chmod 0600 "$temporary/public.env"
expect_config_rejection "$temporary/public.env"
sed 's/^PORT=.*/PORT=4174/' "$good_env" >"$temporary/port.env"
chmod 0600 "$temporary/port.env"
expect_config_rejection "$temporary/port.env"
sed 's/^PORT=.*/PORT=04173/' "$good_env" >"$temporary/noncanonical-port.env"
chmod 0600 "$temporary/noncanonical-port.env"
expect_config_rejection "$temporary/noncanonical-port.env"
sed 's#^AGENT_OS_ALLOWED_ORIGINS=.*#AGENT_OS_ALLOWED_ORIGINS=http://hub.staging.example.com#' \
  "$good_env" >"$temporary/http.env"
chmod 0600 "$temporary/http.env"
expect_config_rejection "$temporary/http.env"
cp "$good_env" "$temporary/open.env"
chmod 0644 "$temporary/open.env"
expect_config_rejection "$temporary/open.env"
cp "$good_env" "$temporary/duplicate.env"
printf '%s\n' 'PORT=4173' >>"$temporary/duplicate.env"
chmod 0600 "$temporary/duplicate.env"
expect_config_rejection "$temporary/duplicate.env"
for token in \
  'test-only-runner-000000000000000000000001\' \
  "test-only-runner-000000000000000000000001'" \
  'test-only-runner-000000000000000000000001"' \
  'test-only-runner-000000000000000000000001 space' \
  'test-only-runner-000000000000000000000001;id'; do
  write_runner_token "$temporary/bad-token.env" "$token"
  expect_config_rejection "$temporary/bad-token.env"
done
sed \
  "s/^AGENT_OS_AGENT_TOKENS='\(.*\)'$/AGENT_OS_AGENT_TOKENS=\1/" \
  "$good_env" >"$temporary/unquoted.env"
chmod 0600 "$temporary/unquoted.env"
expect_config_rejection "$temporary/unquoted.env"
expect_config_rejection "$HUB_ROOT/env.example"

# Build one application-only release from the real frozen workspace. The source
# contains deploy/hub, so its absence from the archive proves the app/admin
# trust-domain allowlist. The packager itself proves the transitive SDK export
# import from a zero-link hoisted production closure.
fixture="$REPOSITORY_ROOT"

production_archive="$temporary/release.tar.gz"
caller_cwd="$temporary/non-source-caller-cwd"
install -d -m 0700 "$caller_cwd"
printf '%s\n' '{"packageManager":"pnpm@0.0.1"}' >"$caller_cwd/package.json"
cat >"$caller_cwd/corepack" <<'FAKE_COREPACK'
#!/usr/bin/env bash
set -Eeuo pipefail
: >"$FAKE_COREPACK_MARKER"
exit 99
FAKE_COREPACK
chmod 0700 "$caller_cwd/corepack"
cat >"$caller_cwd/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
: >"$FAKE_NODE_MARKER"
exit 98
FAKE_NODE
chmod 0700 "$caller_cwd/node"
fake_system_tool="$temporary/fake-system-tool"
cat >"$fake_system_tool" <<'FAKE_SYSTEM_TOOL'
#!/bin/bash
set -Eeuo pipefail
: >"$FAKE_SYSTEM_TOOL_MARKER"
exit 97
FAKE_SYSTEM_TOOL
for tool in bash dirname stat; do install -m 0700 "$fake_system_tool" "$caller_cwd/$tool"; done
fake_corepack_marker="$temporary/fake-corepack-ran"
fake_node_marker="$temporary/fake-node-ran"
fake_system_tool_marker="$temporary/fake-system-tool-ran"

untrusted_health_dir="$temporary/untrusted-health"
untrusted_health_root="$temporary/untrusted-health-root"
untrusted_health_nonce=untrustedhealthnonce00000000000000000001
untrusted_validator_marker="$temporary/untrusted-validator-ran"
install -d -m 0700 "$untrusted_health_dir" "$untrusted_health_root"
cp "$HUB_ROOT/bin/health-check.sh" "$untrusted_health_dir/health-check.sh"
cat >"$untrusted_health_dir/validate-config.sh" <<'UNTRUSTED_VALIDATOR'
#!/bin/bash
: >"${UNTRUSTED_VALIDATOR_MARKER:?}"
exit 99
UNTRUSTED_VALIDATOR
chmod 0755 "$untrusted_health_dir/health-check.sh" "$untrusted_health_dir/validate-config.sh"
printf '%s\n' "$untrusted_health_nonce" >"$untrusted_health_root/.agent-os-deploy-test-root"
chmod 0600 "$untrusted_health_root/.agent-os-deploy-test-root"
expect_failure \
  'health check executed an adjacent validator before fixed-path validation' \
  env AGENT_OS_DEPLOY_TEST_ROOT="$untrusted_health_root" \
  AGENT_OS_DEPLOY_TEST_MODE=1 AGENT_OS_DEPLOY_TEST_NONCE="$untrusted_health_nonce" \
  AGENT_OS_CURL_BIN="$fake_system_tool" AGENT_OS_SYSTEMCTL_BIN="$fake_system_tool" \
  AGENT_OS_SS_BIN="$fake_system_tool" \
  UNTRUSTED_VALIDATOR_MARKER="$untrusted_validator_marker" \
  FAKE_SYSTEM_TOOL_MARKER="$fake_system_tool_marker" \
  /bin/bash -p "$untrusted_health_dir/health-check.sh" --config "$good_env" --live
[[ ! -e "$untrusted_validator_marker" && ! -e "$fake_system_tool_marker" ]] ||
  fail 'health check ran adjacent validator or fake tools before trust validation'

for override_name in \
  AGENT_OS_SYSTEMCTL_BIN \
  AGENT_OS_SS_BIN \
  AGENT_OS_FLOCK_BIN; do
  expect_failure \
    "production deployment library accepted $override_name" \
    env "$override_name=$fake_system_tool" \
    /bin/bash -p -c 'source "$1"' _ "$HUB_ROOT/bin/lib.sh"
done
expect_failure \
  'production health check accepted a CURL executable override' \
  env AGENT_OS_CURL_BIN="$fake_system_tool" \
  /bin/bash -p "$HUB_ROOT/bin/health-check.sh" --config "$good_env" --live
[[ ! -e "$fake_system_tool_marker" ]] ||
  fail 'a production executable override ran before rejection'

untrusted_node_output="$temporary/untrusted-node.tar.gz"
expect_failure \
  'package builder executed an untrusted absolute Node override' \
  env FAKE_NODE_MARKER="$fake_node_marker" AGENT_OS_NODE_BIN="$caller_cwd/node" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" --output "$untrusted_node_output"
[[ ! -e "$fake_node_marker" && ! -e "$untrusted_node_output" && \
  ! -e "$untrusted_node_output.sha256" ]] ||
  fail 'untrusted absolute Node override ran or created release output'
expect_failure \
  'package builder accepted a relative Node override' \
  env AGENT_OS_NODE_BIN=node AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/relative-node.tar.gz"
ln -s "$REAL_NODE_BIN" "$caller_cwd/untrusted-node-link"
expect_failure \
  'package builder accepted a Node symlink below an untrusted ancestor' \
  env AGENT_OS_NODE_BIN="$caller_cwd/untrusted-node-link" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/untrusted-node-link.tar.gz"
trusted_node_parent=${REAL_NODE_BIN%/*}
trusted_node_name=${REAL_NODE_BIN##*/}
ln -s "$trusted_node_parent" "$caller_cwd/trusted-node-parent-alias"
expect_failure \
  'package builder erased an untrusted lexical ancestor through a directory symlink' \
  env AGENT_OS_NODE_BIN="$caller_cwd/trusted-node-parent-alias/$trusted_node_name" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/untrusted-node-parent-alias.tar.gz"

resolve_probe() {
  /bin/bash -p -c \
    'source "$1"; resolve_trusted_executable Probe "$2"' \
    _ "$HUB_ROOT/bin/lib.sh" "$1"
}
expect_failure \
  'trusted executable resolver accepted a relative path' \
  resolve_probe node
expect_failure \
  'trusted executable resolver accepted a file below an untrusted ancestor' \
  resolve_probe "$caller_cwd/node"
expect_failure \
  'trusted executable resolver accepted a leaf symlink below an untrusted ancestor' \
  resolve_probe "$caller_cwd/untrusted-node-link"
expect_failure \
  'trusted executable resolver erased an untrusted lexical directory alias' \
  resolve_probe "$caller_cwd/trusted-node-parent-alias/$trusted_node_name"
[[ ! -e "$fake_node_marker" ]] ||
  fail 'trusted executable resolver executed an untrusted probe'

expect_failure \
  'package builder accepted a relative Corepack override' \
  env AGENT_OS_NODE_BIN="$REAL_NODE_BIN" AGENT_OS_COREPACK_BIN=corepack \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/relative-corepack.tar.gz"
expect_failure \
  'package builder executed an untrusted absolute Corepack override' \
  env FAKE_COREPACK_MARKER="$fake_corepack_marker" AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  AGENT_OS_COREPACK_BIN="$caller_cwd/corepack" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/untrusted-corepack.tar.gz"
[[ ! -e "$fake_corepack_marker" ]] ||
  fail 'untrusted absolute Corepack override was executed'

packager_test_root="$temporary/packager-test-root"
packager_test_nonce=packagertestnonce00000000000000000000001
install -d -m 0700 "$packager_test_root"
printf '%s\n' "$packager_test_nonce" >"$packager_test_root/.agent-os-deploy-test-root"
chmod 0600 "$packager_test_root/.agent-os-deploy-test-root"
expect_failure \
  'package builder accepted deployment test mode to bypass toolchain trust' \
  env AGENT_OS_DEPLOY_TEST_ROOT="$packager_test_root" AGENT_OS_DEPLOY_TEST_MODE=1 \
  AGENT_OS_DEPLOY_TEST_NONCE="$packager_test_nonce" AGENT_OS_NODE_BIN="$caller_cwd/node" \
  AGENT_OS_COREPACK_BIN="$caller_cwd/corepack" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/test-mode-bypass.tar.gz"
[[ ! -e "$fake_node_marker" && ! -e "$fake_corepack_marker" ]] ||
  fail 'deployment test-mode rejection executed an untrusted toolchain'

node_preload="$caller_cwd/preload.cjs"
cat >"$node_preload" <<'NODE_PRELOAD'
require("node:fs").writeFileSync(process.env.NODE_PRELOAD_MARKER, "executed");
NODE_PRELOAD
node_preload_marker="$temporary/node-preload-ran"
expect_failure \
  'package builder accepted NODE_OPTIONS preloading' \
  env NODE_OPTIONS="--require=$node_preload" NODE_PRELOAD_MARKER="$node_preload_marker" \
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/node-options.tar.gz"
[[ ! -e "$node_preload_marker" ]] ||
  fail 'NODE_OPTIONS executed before package-builder rejection'
validate_preload_marker="$temporary/validate-preload-ran"
expect_failure \
  'deployment library accepted NODE_OPTIONS preloading' \
  env NODE_OPTIONS="--require=$node_preload" NODE_PRELOAD_MARKER="$validate_preload_marker" \
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  /bin/bash -p -c 'source "$1"; require_pinned_node' _ "$HUB_ROOT/bin/lib.sh"
[[ ! -e "$validate_preload_marker" ]] ||
  fail 'NODE_OPTIONS executed before deployment-library rejection'
for openssl_influence in OPENSSL_CONF OPENSSL_CONF_INCLUDE OPENSSL_ENGINES OPENSSL_MODULES; do
  openssl_node_marker="$temporary/openssl-node-ran-$openssl_influence"
  expect_failure_message \
    "deployment library accepted $openssl_influence" \
    "Hub deployment failed: deployment runtime rejects inherited variable $openssl_influence" \
    env "$openssl_influence=$caller_cwd/openssl-influence" \
    /bin/bash -p -c \
    'source "$1"; require_pinned_node; "$NODE_BIN" -e '\''require("node:fs").writeFileSync(process.argv[1], "executed")'\'' "$2"' \
    _ "$HUB_ROOT/bin/lib.sh" "$openssl_node_marker"
  [[ ! -e "$openssl_node_marker" ]] ||
    fail "$openssl_influence reached the fixed Node helper before rejection"
  openssl_package_output="$temporary/$openssl_influence.tar.gz"
  expect_failure_message \
    "package builder accepted $openssl_influence" \
    "Hub deployment failed: release packaging rejects inherited variable $openssl_influence" \
    env "$openssl_influence=$caller_cwd/openssl-influence" \
    /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
    --output "$openssl_package_output"
  [[ ! -e "$openssl_package_output" && ! -L "$openssl_package_output" && \
    ! -e "$openssl_package_output.sha256" && ! -L "$openssl_package_output.sha256" ]] ||
    fail "$openssl_influence reached package artifact publication before rejection"
done
expect_failure \
  'package builder accepted an inherited Corepack cache' \
  env COREPACK_HOME="$caller_cwd/corepack-home" AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/inherited-corepack-home.tar.gz"
expect_failure \
  'package builder accepted caller-supplied Corepack integrity keys' \
  env COREPACK_INTEGRITY_KEYS=0 AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/inherited-corepack-keys.tar.gz"

bash_env_file="$caller_cwd/bash-env"
bash_env_marker="$temporary/bash-env-ran"
cat >"$bash_env_file" <<'BASH_ENV_FILE'
: >"${BASH_ENV_MARKER:?}"
BASH_ENV_FILE
expect_failure \
  'package builder imported caller BASH_ENV before trust checks' \
  env BASH_ENV="$bash_env_file" BASH_ENV_MARKER="$bash_env_marker" \
  AGENT_OS_NODE_BIN=node AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" \
  --output "$temporary/bash-env.tar.gz"
[[ ! -e "$bash_env_marker" ]] || fail 'package builder executed caller BASH_ENV content'

production_fixture="$temporary/production-source"
install -d -m 0700 "$production_fixture/apps/chat-spike"
cp -a \
  "$fixture/package.json" \
  "$fixture/pnpm-lock.yaml" \
  "$fixture/pnpm-workspace.yaml" \
  "$production_fixture/"
cp -a "$fixture/deploy" "$production_fixture/"
cp -a \
  "$fixture/apps/chat-spike/package.json" \
  "$fixture/apps/chat-spike/src" \
  "$fixture/apps/chat-spike/public" \
  "$fixture/apps/chat-spike/bin" \
  "$production_fixture/apps/chat-spike/"
printf '%s\n' 'COREPACK_INTEGRITY_KEYS=not-valid-json' >"$production_fixture/.corepack.env"

if ! (
  cd "$caller_cwd"
  PATH="$caller_cwd:$PATH" \
  FAKE_COREPACK_MARKER="$fake_corepack_marker" \
  FAKE_NODE_MARKER="$fake_node_marker" \
  FAKE_SYSTEM_TOOL_MARKER="$fake_system_tool_marker" \
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
    /bin/bash -p "$HUB_ROOT/bin/package-release.sh" \
      --source "$production_fixture" \
      --output "$production_archive" >/dev/null
); then
  fail 'production release packaging failed from a non-source caller cwd'
fi
[[ ! -e "$fake_corepack_marker" ]] ||
  fail 'caller cwd shadowed the fixed Corepack executable'
[[ ! -e "$fake_node_marker" ]] ||
  fail 'caller cwd shadowed the fixed Node executable'
[[ ! -e "$fake_system_tool_marker" ]] ||
  fail 'caller cwd shadowed a pre-trust system executable'
tar -tzf "$production_archive" | grep -Eq '(^|/)deploy(/|$)' &&
  fail 'application archive contains the privileged deploy tree'

invalid_source="$temporary/not-an-agent-os-source"
install -d -m 0700 "$invalid_source"
if invalid_source_output="$(
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
    /bin/bash -p "$HUB_ROOT/bin/package-release.sh" \
      --source "$invalid_source" \
      --output "$temporary/invalid-source.tar.gz" 2>&1
)"; then
  fail 'package builder accepted an invalid source root'
fi
[[ "$invalid_source_output" == *"$invalid_source"* ]] ||
  fail 'invalid source-root diagnostic omitted the expected path'

wrong_manager_source="$temporary/wrong-package-manager-source"
install -d -m 0700 "$wrong_manager_source/apps/chat-spike/src"
printf '%s\n' '{"packageManager":"pnpm@0.0.1"}' >"$wrong_manager_source/package.json"
wrong_manager_output="$temporary/wrong-package-manager.tar.gz"
if wrong_manager_diagnostic="$(
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" \
  AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
    /bin/bash -p "$HUB_ROOT/bin/package-release.sh" \
      --source "$wrong_manager_source" \
      --output "$wrong_manager_output" 2>&1
)"; then
  fail 'package builder accepted the wrong source-root package manager'
fi
[[ "$wrong_manager_diagnostic" == *"$wrong_manager_source"* ]] ||
  fail 'wrong package-manager diagnostic omitted the source root'
[[ ! -e "$wrong_manager_output" && ! -e "$wrong_manager_output.sha256" ]] ||
  fail 'wrong package-manager rejection created release output'

broken_output="$temporary/broken-output.tar.gz"
ln -s "$temporary/missing-checksum-target" "$broken_output.sha256"
expect_failure \
  'package builder followed a broken checksum symlink' \
  env AGENT_OS_NODE_BIN="$REAL_NODE_BIN" AGENT_OS_COREPACK_BIN="$REAL_COREPACK_BIN" \
  /bin/bash -p "$HUB_ROOT/bin/package-release.sh" --source "$fixture" --output "$broken_output"
[[ ! -e "$broken_output" ]] || fail 'rejected package output created an archive'

safe_extract="$temporary/safe-extract"
install -d -m 0700 "$safe_extract"
"$REAL_NODE_BIN" "$HUB_ROOT/bin/extract-release.mjs" "$production_archive" "$safe_extract"
"$REAL_NODE_BIN" "$HUB_ROOT/bin/verify-release.mjs" "$safe_extract"
[[ ! -e "$safe_extract/deploy" ]] || fail 'safe extractor admitted admin content'
(
  cd "$safe_extract/apps/chat-spike"
  "$REAL_NODE_BIN" --input-type=module --eval \
    'await import("@modelcontextprotocol/sdk/server"); await import("zod");'
)
[[ -z "$(find "$safe_extract/apps/chat-spike/node_modules" -type l -print -quit)" ]] ||
  fail 'extracted production closure contains a symbolic link'
[[ -z "$(find "$safe_extract/apps/chat-spike/node_modules" -type f -links +1 -print -quit)" ]] ||
  fail 'extracted production closure contains a multiply-linked file'

# Repeated transaction fault injection uses a tiny structurally valid archive;
# the independent production archive above is the only closure claim and has
# already passed the real package-export import after audited extraction.
transaction_root="$temporary/transaction-root"
install -d \
  "$transaction_root/apps/chat-spike/src" \
  "$transaction_root/apps/chat-spike/public" \
  "$transaction_root/apps/chat-spike/node_modules/@modelcontextprotocol/sdk/dist/esm/server" \
  "$transaction_root/apps/chat-spike/node_modules/zod"
cat >"$transaction_root/package.json" <<'JSON'
{"name":"agent-os","private":true,"type":"module"}
JSON
cat >"$transaction_root/apps/chat-spike/package.json" <<'JSON'
{"name":"@agent-os/chat-spike","private":true,"type":"module"}
JSON
cat >"$transaction_root/apps/chat-spike/node_modules/@modelcontextprotocol/sdk/package.json" <<'JSON'
{"name":"@modelcontextprotocol/sdk","version":"0.0.0-transaction","type":"module"}
JSON
cat >"$transaction_root/apps/chat-spike/node_modules/zod/package.json" <<'JSON'
{"name":"zod","version":"0.0.0-transaction","type":"module"}
JSON
printf '%s\n' 'export const transactionFixture = true;' \
  >"$transaction_root/apps/chat-spike/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"
printf '%s\n' 'console.log("transaction fixture");' \
  >"$transaction_root/apps/chat-spike/src/server.mjs"
printf '%s\n' '<!doctype html><title>transaction fixture</title>' \
  >"$transaction_root/apps/chat-spike/public/index.html"
printf '%s\n' 'lockfileVersion: transaction' >"$transaction_root/pnpm-lock.yaml"
printf '%s\n' 'packages:' '  - apps/*' >"$transaction_root/pnpm-workspace.yaml"
"$REAL_NODE_BIN" "$HUB_ROOT/bin/verify-release.mjs" "$transaction_root"
archive="$temporary/transaction-release.tar.gz"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$archive" -C "$transaction_root" .
chmod 0600 "$archive"
checksum="$(sha256_file "$archive")"

expect_extract_rejection() {
  local candidate=$1 destination="$temporary/rejected-extract-$RANDOM"
  install -d -m 0700 "$destination"
  if "$REAL_NODE_BIN" "$HUB_ROOT/bin/extract-release.mjs" "$candidate" "$destination" \
    >/dev/null 2>&1; then
    fail 'unsafe release archive was extracted'
  fi
}

malicious_root="$temporary/malicious-root"
install -d "$malicious_root/deploy/hub/bin"
cat >"$malicious_root/deploy/hub/bin/health-check.sh" <<'MALICIOUS'
#!/usr/bin/env bash
printf '%s\n' executed >"${AGENT_OS_MALICIOUS_MARKER:?}"
MALICIOUS
chmod 0755 "$malicious_root/deploy/hub/bin/health-check.sh"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$temporary/admin-content.tar.gz" -C "$malicious_root" .
expect_extract_rejection "$temporary/admin-content.tar.gz"

link_root="$temporary/link-root"
install -d "$link_root/apps/chat-spike/public"
marker="$temporary/no-link-write"
printf '%s\n' unchanged >"$marker"
ln -s "$marker" "$link_root/apps/chat-spike/public/link"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$temporary/symlink.tar.gz" -C "$link_root" .
expect_extract_rejection "$temporary/symlink.tar.gz"
grep -Fq unchanged "$marker" || fail 'symlink archive changed its external target'

hard_root="$temporary/hard-root"
install -d "$hard_root/apps/chat-spike/public"
printf '%s\n' one >"$hard_root/apps/chat-spike/public/one"
ln "$hard_root/apps/chat-spike/public/one" "$hard_root/apps/chat-spike/public/two"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$temporary/hardlink.tar.gz" -C "$hard_root" .
expect_extract_rejection "$temporary/hardlink.tar.gz"

fifo_root="$temporary/fifo-root"
install -d "$fifo_root/apps/chat-spike/public"
mkfifo "$fifo_root/apps/chat-spike/public/pipe"
COPYFILE_DISABLE=1 tar --format=ustar -czf "$temporary/fifo.tar.gz" -C "$fifo_root" .
expect_extract_rejection "$temporary/fifo.tar.gz"

copy_parent="$temporary/copy-parent"
install -d -m 0700 "$copy_parent"
ln -s "$archive" "$temporary/archive-link"
expect_failure \
  'artifact copier followed a source symlink' \
  "$REAL_NODE_BIN" "$HUB_ROOT/bin/copy-artifact.mjs" \
  "$temporary/archive-link" "$copy_parent/copied-link.tar.gz"
ln "$archive" "$temporary/archive-hardlink"
expect_failure \
  'artifact copier accepted a multiply-linked source' \
  "$REAL_NODE_BIN" "$HUB_ROOT/bin/copy-artifact.mjs" \
  "$archive" "$copy_parent/copied-hard.tar.gz"
rm -f -- "$temporary/archive-hardlink"
real_copy_parent="$temporary/real-copy-parent"
install -d -m 0700 "$real_copy_parent"
ln -s "$real_copy_parent" "$temporary/copy-parent-link"
expect_failure \
  'artifact copier followed a destination ancestor symlink' \
  "$REAL_NODE_BIN" "$HUB_ROOT/bin/copy-artifact.mjs" \
  "$archive" "$temporary/copy-parent-link/copied.tar.gz"
[[ ! -e "$real_copy_parent/copied.tar.gz" ]] || fail 'destination ancestor escape wrote a file'

hash_root="$temporary/hash-root"
install -d "$hash_root"
printf '%s\n' state >"$hash_root/ledger"
chmod 0600 "$hash_root/ledger"
hash_before="$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" "$hash_root")"
chmod 0644 "$hash_root/ledger"
hash_after="$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" "$hash_root")"
[[ "$hash_before" != "$hash_after" ]] || fail 'state hash ignored file security metadata'
ln "$hash_root/ledger" "$hash_root/ledger-hard"
expect_failure \
  'state hash accepted a hardlink' \
  "$REAL_NODE_BIN" "$HUB_ROOT/bin/state-hash.mjs" "$hash_root"
ln -s "$hash_root" "$temporary/hash-root-link"
expect_failure \
  'state hash followed a root symlink' \
  "$REAL_NODE_BIN" "$HUB_ROOT/bin/state-hash.mjs" "$temporary/hash-root-link"

untrusted_admin_source="$temporary/untrusted-admin-source"
untrusted_admin_marker="$temporary/untrusted-admin-lib-ran"
install -d -m 0700 "$untrusted_admin_source/bin"
cp "$HUB_ROOT/bootstrap-admin.sh" "$untrusted_admin_source/bootstrap-admin.sh"
cat >"$untrusted_admin_source/bin/lib.sh" <<'UNTRUSTED_ADMIN_LIB'
: >"${UNTRUSTED_ADMIN_MARKER:?}"
exit 99
UNTRUSTED_ADMIN_LIB
chmod 0755 "$untrusted_admin_source/bootstrap-admin.sh" "$untrusted_admin_source/bin/lib.sh"
expect_failure \
  'admin bootstrap sourced an untrusted library before source validation' \
  env -u AGENT_OS_DEPLOY_TEST_ROOT -u AGENT_OS_DEPLOY_TEST_MODE \
  -u AGENT_OS_DEPLOY_TEST_NONCE UNTRUSTED_ADMIN_MARKER="$untrusted_admin_marker" \
  /bin/bash -p "$untrusted_admin_source/bootstrap-admin.sh"
[[ ! -e "$untrusted_admin_marker" ]] ||
  fail 'admin bootstrap executed an untrusted library before source validation'

untrusted_entry_source="$temporary/untrusted-entry-source"
untrusted_sibling_marker="$temporary/untrusted-admin-sibling-ran"
install -d -m 0700 "$untrusted_entry_source"
for entry_name in install.sh upgrade.sh rollback.sh validate-config.sh; do
  cp "$HUB_ROOT/bin/$entry_name" "$untrusted_entry_source/$entry_name"
  chmod 0755 "$untrusted_entry_source/$entry_name"
done
cat >"$untrusted_entry_source/lib.sh" <<'UNTRUSTED_SIBLING'
: >"${UNTRUSTED_SIBLING_MARKER:?}"
exit 99
UNTRUSTED_SIBLING
cat >"$untrusted_entry_source/admin-entry-guard.sh" <<'UNTRUSTED_SIBLING'
: >"${UNTRUSTED_SIBLING_MARKER:?}"
exit 98
UNTRUSTED_SIBLING
chmod 0755 \
  "$untrusted_entry_source/lib.sh" \
  "$untrusted_entry_source/admin-entry-guard.sh"
for entry_name in install.sh upgrade.sh rollback.sh validate-config.sh; do
  expect_failure \
    "$entry_name executed an adjacent sibling before fixed-path validation" \
    env -u AGENT_OS_DEPLOY_TEST_ROOT -u AGENT_OS_DEPLOY_TEST_MODE \
    -u AGENT_OS_DEPLOY_TEST_NONCE UNTRUSTED_SIBLING_MARKER="$untrusted_sibling_marker" \
    /bin/bash -p "$untrusted_entry_source/$entry_name"
done
[[ ! -e "$untrusted_sibling_marker" ]] ||
  fail 'a privileged admin entry executed an adjacent sibling before path validation'

# A path-only rejection is insufficient: prove that every privileged entry
# rejects a reachable guard inside the fixed test namespace before executing it.
fixed_untrusted_root="$temporary/fixed-untrusted-root"
fixed_untrusted_nonce=fixedguardnonce0000000000000000000000000000
fixed_untrusted_marker="$temporary/fixed-untrusted-guard-ran"
fixed_untrusted_bin="$fixed_untrusted_root/usr/libexec/agent-os/hub/bin"
install -d -m 0700 "$fixed_untrusted_bin"
printf '%s\n' "$fixed_untrusted_nonce" >"$fixed_untrusted_root/.agent-os-deploy-test-root"
chmod 0600 "$fixed_untrusted_root/.agent-os-deploy-test-root"
for entry_name in install.sh upgrade.sh rollback.sh validate-config.sh; do
  cp "$HUB_ROOT/bin/$entry_name" "$fixed_untrusted_bin/$entry_name"
  chmod 0755 "$fixed_untrusted_bin/$entry_name"
done
cat >"$fixed_untrusted_bin/admin-entry-guard.sh" <<'UNTRUSTED_FIXED_GUARD'
: >"${UNTRUSTED_FIXED_GUARD_MARKER:?}"
exit 97
UNTRUSTED_FIXED_GUARD
chmod 0777 "$fixed_untrusted_bin/admin-entry-guard.sh"
for entry_name in install.sh upgrade.sh rollback.sh validate-config.sh; do
  expect_failure \
    "$entry_name executed an unsafe guard from the fixed test namespace" \
    env AGENT_OS_DEPLOY_TEST_MODE=1 AGENT_OS_DEPLOY_TEST_ROOT="$fixed_untrusted_root" \
    AGENT_OS_DEPLOY_TEST_NONCE="$fixed_untrusted_nonce" \
    UNTRUSTED_FIXED_GUARD_MARKER="$fixed_untrusted_marker" \
    /bin/bash -p "$fixed_untrusted_bin/$entry_name"
done
[[ ! -e "$fixed_untrusted_marker" ]] ||
  fail 'a privileged admin entry executed an unsafe fixed-path guard before trust validation'

# The test-root namespace is accepted only with a canonical, process-owned
# marker. These attempts must fail before creating any deployment path.
bad_root="$temporary/bad-root"
install -d "$bad_root"
expect_failure \
  'test root without marker was accepted' \
  env AGENT_OS_DEPLOY_TEST_MODE=1 AGENT_OS_DEPLOY_TEST_ROOT="$bad_root" \
  AGENT_OS_DEPLOY_TEST_NONCE=missingmarker000000000000000000000000 \
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" bash "$HUB_ROOT/bootstrap-admin.sh"
symlink_target="$temporary/symlink-root-target"
install -d "$symlink_target"
printf '%s\n' symlinknonce000000000000000000000000 >"$symlink_target/.agent-os-deploy-test-root"
chmod 0600 "$symlink_target/.agent-os-deploy-test-root"
ln -s "$symlink_target" "$temporary/symlink-test-root"
expect_failure \
  'test root containing a symlink was accepted' \
  env AGENT_OS_DEPLOY_TEST_MODE=1 AGENT_OS_DEPLOY_TEST_ROOT="$temporary/symlink-test-root" \
  AGENT_OS_DEPLOY_TEST_NONCE=symlinknonce000000000000000000000000 \
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" bash "$HUB_ROOT/bootstrap-admin.sh"
expect_failure \
  'test root containing dot traversal was accepted' \
  env AGENT_OS_DEPLOY_TEST_MODE=1 AGENT_OS_DEPLOY_TEST_ROOT="$TEMPORARY_PARENT/.." \
  AGENT_OS_DEPLOY_TEST_NONCE=dotpathnonce0000000000000000000000000 \
  AGENT_OS_NODE_BIN="$REAL_NODE_BIN" bash "$HUB_ROOT/bootstrap-admin.sh"

# Fully auditable process mocks for non-root transaction testing.
mock_state="$temporary/mock-state"
install -d "$mock_state"
systemctl_mock="$temporary/systemctl"
cat >"$systemctl_mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
command_name=${1:-}
shift || true
printf '%s %s\n' "$command_name" "$*" >>"$AGENT_OS_MOCK_SYSTEMCTL_LOG"
unit=${!#:-agent-os-hub.service}
active_path="$AGENT_OS_MOCK_STATE/active.$unit"
enabled_path="$AGENT_OS_MOCK_STATE/enabled.$unit"
current_revision() {
  local link="$AGENT_OS_DEPLOY_TEST_ROOT/opt/agent-os/current" target
  [[ -L "$link" ]] || return 0
  target="$(readlink "$link")"
  printf '%s\n' "${target#releases/}"
}
case "$command_name" in
  daemon-reload)
    if [[ -f "$AGENT_OS_MOCK_FAIL_DAEMON_ONCE" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_DAEMON_ONCE"
      exit 1
    fi
    ;;
  start)
    if [[ "$unit" == agent-os-hub-candidate@*.service && -f "$AGENT_OS_MOCK_FAIL_CANDIDATE_REVISION" ]]; then
      candidate=${unit#agent-os-hub-candidate@}
      candidate=${candidate%.service}
      if [[ "$(cat "$AGENT_OS_MOCK_FAIL_CANDIDATE_REVISION")" == "$candidate" ]]; then exit 1; fi
    fi
    if [[ "$unit" == agent-os-hub-candidate@*.service ]]; then
      candidate=${unit#agent-os-hub-candidate@}
      candidate=${candidate%.service}
      candidate_env="$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-candidates/$candidate.env"
      if grep -Eq 'test-only-(runner|human|claude|grok|kimi|codex)-' "$candidate_env"; then
        : >"$AGENT_OS_MOCK_CANDIDATE_TOKEN_LEAK"
        exit 1
      fi
      : >"$AGENT_OS_MOCK_CANDIDATE_TOKEN_ISOLATED"
    fi
    if [[ "$unit" == agent-os-hub.service && -f "$AGENT_OS_MOCK_FAIL_START_REVISION" ]] &&
      [[ "$(cat "$AGENT_OS_MOCK_FAIL_START_REVISION")" == "$(current_revision)" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_START_REVISION"
      exit 1
    fi
    pid=417300
    [[ "$unit" == agent-os-hub-candidate@*.service ]] && pid=141730
    printf '%s\n' "$pid" >"$active_path"
    ;;
  stop)
    if [[ "$unit" == agent-os-hub-candidate@*.service && -f "$AGENT_OS_MOCK_FAIL_CANDIDATE_STOP_REVISION" ]]; then
      candidate=${unit#agent-os-hub-candidate@}
      candidate=${candidate%.service}
      if [[ "$(cat "$AGENT_OS_MOCK_FAIL_CANDIDATE_STOP_REVISION")" == "$candidate" ]]; then exit 1; fi
    fi
    if [[ -f "$AGENT_OS_MOCK_FAIL_STOP_ONCE" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_STOP_ONCE"
      exit 1
    fi
    rm -f -- "$active_path"
    ;;
  is-active)
    [[ -f "$active_path" ]]
    ;;
  show)
    if [[ -f "$active_path" ]]; then cat "$active_path"; else printf '%s\n' 0; fi
    ;;
  enable)
    if [[ -f "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION" ]] &&
      [[ "$(cat "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION")" == "$(current_revision)" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION"
      rm -f -- "$enabled_path"
      exit 1
    fi
    : >"$enabled_path"
    ;;
  disable)
    if [[ -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
      exit 1
    fi
    rm -f -- "$enabled_path"
    ;;
  is-enabled) [[ -f "$enabled_path" ]] ;;
esac
MOCK
chmod 0755 "$systemctl_mock"

ss_mock="$temporary/ss"
cat >"$ss_mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$*" in
  *':14173'*)
    port=14173
    active=
    for candidate in "$AGENT_OS_MOCK_STATE"/active.agent-os-hub-candidate@*.service; do
      [[ -f "$candidate" ]] || continue
      active=$candidate
      break
    done
    ;;
  *) port=4173; active="$AGENT_OS_MOCK_STATE/active.agent-os-hub.service" ;;
esac
[[ -n "${active:-}" && -f "$active" ]] || exit 0
pid="$(cat "$active")"
if [[ -f "$AGENT_OS_MOCK_WRONG_LISTENER_ONCE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_WRONG_LISTENER_ONCE"
  pid=$((pid + 1))
fi
printf 'LISTEN 0 511 127.0.0.1:%s 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "$port" "$pid"
MOCK
chmod 0755 "$ss_mock"

curl_mock="$temporary/curl"
cat >"$curl_mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
url=
for argument in "$@"; do url=$argument; done
current_revision() {
  local link="$AGENT_OS_DEPLOY_TEST_ROOT/opt/agent-os/current" target
  [[ -L "$link" ]] || return 0
  target="$(readlink "$link")"
  printf '%s\n' "${target#releases/}"
}
if [[ -f "$AGENT_OS_MOCK_WRONG_BODY_ONCE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_WRONG_BODY_ONCE"
  printf '%s\n%s' '{"status":"unexpected"}' 200
  exit 0
fi
revision="$(current_revision)"
if [[ "$url" == *':4173/health/'* && -f "$AGENT_OS_MOCK_CORRUPT_MAINTENANCE_REVISION" ]] &&
  [[ "$(cat "$AGENT_OS_MOCK_CORRUPT_MAINTENANCE_REVISION")" == "$revision" ]]; then
  rm -f -- "$AGENT_OS_MOCK_CORRUPT_MAINTENANCE_REVISION"
  rm -f -- "$AGENT_OS_MOCK_MAINTENANCE"
  mkdir "$AGENT_OS_MOCK_MAINTENANCE"
fi
if [[ "$url" == *':4173/health/'* && -f "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION" ]] &&
  [[ "$(cat "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION")" == "$revision" ]]; then
  if [[ -f "$AGENT_OS_MOCK_MUTATE_STATE_ONCE" ]]; then
    rm -f -- "$AGENT_OS_MOCK_MUTATE_STATE_ONCE"
    printf '%s\n' mutated >>"$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os/hub/state-sentinel"
  fi
  printf '%s\n%s' '{"status":"not_ready"}' 503
  exit 0
fi
if [[ "$url" == *':4173/health/'* && -f "$AGENT_OS_MOCK_DROP_SERVICE_ONCE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_DROP_SERVICE_ONCE"
  rm -f -- "$AGENT_OS_MOCK_STATE/active.agent-os-hub.service"
fi
case "$url" in
  */health/live) printf '%s\n%s' '{"status":"ok"}' 200 ;;
  */health/ready) printf '%s\n%s' '{"status":"not_ready"}' 503 ;;
  *) printf '%s\n%s' '{"status":"missing"}' 404 ;;
esac
MOCK
chmod 0755 "$curl_mock"

flock_mock="$temporary/flock"
cat >"$flock_mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$AGENT_OS_MOCK_FLOCK_LOG"
if [[ -f "$AGENT_OS_MOCK_FAIL_FLOCK_ONCE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_FAIL_FLOCK_ONCE"
  exit 1
fi
MOCK
chmod 0755 "$flock_mock"

node_mock="$temporary/node"
cat >"$node_mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -p && "${2:-}" == process.versions.node ]]; then
  printf '%s\n' 24.19.0
  exit 0
fi
if [[ "${1:-}" == -e && "${2:-}" == *renameSync* ]]; then
  destination=${4:-}
  if [[ -f "$AGENT_OS_MOCK_FAIL_RENAME_ONCE" ]]; then
    rm -f -- "$AGENT_OS_MOCK_FAIL_RENAME_ONCE"
    exit 1
  fi
  if [[ "$destination" == */previous && -f "$AGENT_OS_MOCK_FAIL_PREVIOUS_ONCE" ]]; then
    rm -f -- "$AGENT_OS_MOCK_FAIL_PREVIOUS_ONCE"
    exit 1
  fi
fi
exec "$AGENT_OS_REAL_NODE_BIN" "$@"
MOCK
chmod 0755 "$node_mock"

test_root="$temporary/root"
test_nonce=testrootnonce0000000000000000000000001
install -d "$test_root"
printf '%s\n' "$test_nonce" >"$test_root/.agent-os-deploy-test-root"
chmod 0600 "$test_root/.agent-os-deploy-test-root"

export AGENT_OS_DEPLOY_TEST_MODE=1
export AGENT_OS_DEPLOY_TEST_ROOT="$test_root"
export AGENT_OS_DEPLOY_TEST_NONCE="$test_nonce"
export AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock"
export AGENT_OS_CURL_BIN="$curl_mock"
export AGENT_OS_SS_BIN="$ss_mock"
export AGENT_OS_FLOCK_BIN="$flock_mock"
export AGENT_OS_NODE_BIN="$node_mock"
export AGENT_OS_REAL_NODE_BIN="$REAL_NODE_BIN"
export AGENT_OS_HEALTH_ATTEMPTS=1
export AGENT_OS_HEALTH_INTERVAL=0
export AGENT_OS_MOCK_STATE="$mock_state"
export AGENT_OS_MOCK_SYSTEMCTL_LOG="$temporary/systemctl.log"
export AGENT_OS_MOCK_FLOCK_LOG="$temporary/flock.log"
export AGENT_OS_MOCK_FAIL_DAEMON_ONCE="$temporary/fail-daemon"
export AGENT_OS_MOCK_FAIL_START_REVISION="$temporary/fail-start-revision"
export AGENT_OS_MOCK_FAIL_CANDIDATE_REVISION="$temporary/fail-candidate-revision"
export AGENT_OS_MOCK_FAIL_CANDIDATE_STOP_REVISION="$temporary/fail-candidate-stop-revision"
export AGENT_OS_MOCK_FAIL_ENABLE_REVISION="$temporary/fail-enable-revision"
export AGENT_OS_MOCK_FAIL_STOP_ONCE="$temporary/fail-stop"
export AGENT_OS_MOCK_FAIL_DISABLE_ONCE="$temporary/fail-disable"
export AGENT_OS_DEPLOY_FAIL_PUBLISH_ONCE="$temporary/fail-publish"
export AGENT_OS_MOCK_FAIL_FLOCK_ONCE="$temporary/fail-flock"
export AGENT_OS_MOCK_WRONG_LISTENER_ONCE="$temporary/wrong-listener"
export AGENT_OS_MOCK_WRONG_BODY_ONCE="$temporary/wrong-body"
export AGENT_OS_MOCK_FAIL_HEALTH_REVISION="$temporary/fail-health-revision"
export AGENT_OS_MOCK_MUTATE_STATE_ONCE="$temporary/mutate-state"
export AGENT_OS_MOCK_CORRUPT_MAINTENANCE_REVISION="$temporary/corrupt-maintenance-revision"
export AGENT_OS_MOCK_FAIL_RENAME_ONCE="$temporary/fail-rename"
export AGENT_OS_MOCK_FAIL_PREVIOUS_ONCE="$temporary/fail-previous"
export AGENT_OS_MOCK_MAINTENANCE="$test_root/run/agent-os/hub-maintenance"
export AGENT_OS_MALICIOUS_MARKER="$temporary/malicious-executed"
export AGENT_OS_MOCK_CANDIDATE_TOKEN_LEAK="$temporary/candidate-token-leak"
export AGENT_OS_MOCK_CANDIDATE_TOKEN_ISOLATED="$temporary/candidate-token-isolated"
export AGENT_OS_MOCK_DROP_SERVICE_ONCE="$temporary/drop-service"

bash "$HUB_ROOT/bootstrap-admin.sh" >/dev/null
bash "$HUB_ROOT/bootstrap-admin.sh" >/dev/null
fixed_root="$test_root/usr/libexec/agent-os/hub"
fixed_bin="$fixed_root/bin"
[[ -x "$fixed_bin/admin-entry-guard.sh" && -x "$fixed_bin/install.sh" && \
  -x "$fixed_bin/health-check.sh" ]] ||
  fail 'bootstrap did not install the fixed admin kit'

wrong_version_node="$temporary/wrong-version-node"
cat >"$wrong_version_node" <<'WRONG_VERSION_NODE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -p && "${2:-}" == process.versions.node ]]; then
  printf '%s\n' 24.18.0
  exit 0
fi
exec "$AGENT_OS_REAL_NODE_BIN" "$@"
WRONG_VERSION_NODE
chmod 0755 "$wrong_version_node"
expect_failure \
  'deployment configuration accepted the wrong full Node version' \
  env AGENT_OS_NODE_BIN="$wrong_version_node" \
  /bin/bash -p "$fixed_bin/validate-config.sh" "$good_env"

# Account validation is exercised with a deterministic passwd/group facade.
# The library itself is sourced before PATH changes so the test-root ownership
# gate still observes the real caller identity.
identity_mock_dir="$temporary/identity-mocks"
install -d -m 0700 "$identity_mock_dir"
cat >"$identity_mock_dir/id" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
option=${1:-}
account=${2:-}
case "$account" in
  agent-os)
    uid=$MOCK_LIVE_UID
    gid=$MOCK_LIVE_GID
    group=agent-os
    ;;
  agent-os-candidate)
    uid=$MOCK_CANDIDATE_UID
    gid=$MOCK_CANDIDATE_GID
    group=agent-os-candidate
    ;;
  *) exit 1 ;;
esac
case "$option" in
  -u) printf '%s\n' "$uid" ;;
  -g) printf '%s\n' "$gid" ;;
  -gn) printf '%s\n' "$group" ;;
  -G) printf '%s\n' "$gid" ;;
  *) exit 2 ;;
esac
MOCK
cat >"$identity_mock_dir/getent" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
database=${1:-}
key=${2:-}
live_entry="agent-os:x:$MOCK_LIVE_UID:$MOCK_LIVE_GID::/var/lib/agent-os:/usr/sbin/nologin"
candidate_entry="agent-os-candidate:x:$MOCK_CANDIDATE_UID:$MOCK_CANDIDATE_GID::/var/lib/agent-os/hub-candidates:/usr/sbin/nologin"
case "$database:$key" in
  group:agent-os) printf 'agent-os:x:%s:\n' "$MOCK_LIVE_GID" ;;
  group:agent-os-candidate) printf 'agent-os-candidate:x:%s:\n' "$MOCK_CANDIDATE_GID" ;;
  passwd:agent-os) printf '%s\n' "$live_entry" ;;
  passwd:agent-os-candidate) printf '%s\n' "$candidate_entry" ;;
  passwd:)
    printf '%s\n%s\n' "$live_entry" "$candidate_entry"
    if [[ "$MOCK_DUPLICATE_LIVE_UID" == 1 ]]; then
      printf 'duplicate-live:x:%s:2999::/nonexistent:/usr/sbin/nologin\n' "$MOCK_LIVE_UID"
    fi
    ;;
  *) exit 2 ;;
esac
MOCK
cat >"$identity_mock_dir/passwd" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == -S && -n "${2:-}" ]] || exit 2
printf '%s L 01/01/1970 0 99999 7 -1\n' "$2"
MOCK
chmod 0755 "$identity_mock_dir/id" "$identity_mock_dir/getent" "$identity_mock_dir/passwd"

export MOCK_LIVE_UID=2101
export MOCK_LIVE_GID=2101
export MOCK_CANDIDATE_UID=2102
export MOCK_CANDIDATE_GID=2102
export MOCK_DUPLICATE_LIVE_UID=0

validate_mock_identities() (
  AGENT_OS_ID_BIN="$identity_mock_dir/id"
  # shellcheck source=/dev/null
  source "$fixed_bin/lib.sh"
  PATH="$identity_mock_dir:$PATH"
  validate_existing_identity agent-os agent-os /var/lib/agent-os
  validate_existing_identity \
    agent-os-candidate agent-os-candidate /var/lib/agent-os/hub-candidates
  validate_identity_separation
)

validate_mock_identity_separation() (
  AGENT_OS_ID_BIN="$identity_mock_dir/id"
  # shellcheck source=/dev/null
  source "$fixed_bin/lib.sh"
  PATH="$identity_mock_dir:$PATH"
  validate_identity_separation
)

validate_mode_policy() (
  # shellcheck source=/dev/null
  source "$fixed_bin/lib.sh"
  mode_is_safe 0555 || exit 1
  if mode_is_safe 0575; then exit 1; fi
  if mode_is_safe 0557; then exit 1; fi
  [[ "$(stat_value '%a' '%Lp' "$portable_stat_probe")" == 600 ]]
  [[ "$(stat_value '%u' '%u' "$portable_stat_probe")" == "$EUID" ]]
  [[ "$(stat_value '%h' '%l' "$portable_stat_probe")" == 1 ]]
)

portable_stat_probe="$temporary/portable-stat-probe"
: >"$portable_stat_probe"
chmod 0600 "$portable_stat_probe"
validate_mode_policy || fail 'mode policy did not accept 0555 and reject 0575/0557'
validate_mock_identities
MOCK_LIVE_UID=0 expect_failure 'service account validation accepted UID zero' validate_mock_identities
MOCK_LIVE_UID=2101 MOCK_LIVE_GID=0 \
  expect_failure 'service account validation accepted GID zero' validate_mock_identities
MOCK_DUPLICATE_LIVE_UID=1 \
  expect_failure 'service account validation accepted a duplicate passwd UID' validate_mock_identities
MOCK_CANDIDATE_UID=2101 \
  expect_failure 'live and candidate identities shared a numeric UID' \
  validate_mock_identity_separation
MOCK_CANDIDATE_GID=2101 \
  expect_failure 'live and candidate identities shared a numeric GID' \
  validate_mock_identity_separation

expect_failure \
  'application/source install helper ran outside the fixed admin kit' \
  bash "$HUB_ROOT/bin/install.sh" --archive "$archive" --sha256 "$checksum" \
  --revision source-rejected --env-file "$good_env"

invalid_archive="$temporary/admin-content.tar.gz"
invalid_checksum="$(sha256_file "$invalid_archive")"
expect_failure \
  'install accepted a wrong checksum' \
  bash "$fixed_bin/install.sh" --archive "$archive" \
  --sha256 0000000000000000000000000000000000000000000000000000000000000000 \
  --revision bad-checksum --env-file "$good_env"
expect_failure \
  'install accepted an unsafe archive with a valid checksum' \
  bash "$fixed_bin/install.sh" --archive "$invalid_archive" --sha256 "$invalid_checksum" \
  --revision bad-archive --env-file "$good_env"
expect_failure \
  'install accepted an invalid credential file' \
  bash "$fixed_bin/install.sh" --archive "$archive" --sha256 "$checksum" \
  --revision bad-config --env-file "$temporary/short.env"
cp "$good_env" "$temporary/hardlinked-env"
ln "$temporary/hardlinked-env" "$temporary/hardlinked-env-peer"
expect_failure \
  'install accepted a multiply-linked credential source' \
  bash "$fixed_bin/install.sh" --archive "$archive" --sha256 "$checksum" \
  --revision bad-config-hardlink --env-file "$temporary/hardlinked-env"
[[ ! -e "$test_root/etc/agent-os/hub.env" && ! -e "$test_root/opt/agent-os/current" ]] ||
  fail 'offline install rejection committed configuration or a pointer'

ln -s releases/legacy-history "$test_root/opt/agent-os/previous"
expect_failure \
  'fresh install accepted an existing previous pointer' \
  bash "$fixed_bin/install.sh" --archive "$archive" --sha256 "$checksum" \
  --revision previous-rejected --env-file "$good_env"
[[ "$(readlink "$test_root/opt/agent-os/previous")" == releases/legacy-history ]] ||
  fail 'fresh install rejection changed an existing previous pointer'
rm -f -- "$test_root/opt/agent-os/previous"

# Every install commit boundary must leave the same verified immutable release
# reusable while removing all published configuration, pointers and unit state.
install_revision_one() {
  bash "$fixed_bin/install.sh" --archive "$archive" --sha256 "$checksum" \
    --revision revision-1 --env-file "$good_env"
}

assert_install_retry_clean() {
  local label=$1 path
  [[ -d "$test_root/opt/agent-os/releases/revision-1" ]] ||
    fail "$label discarded its verified immutable release"
  for path in \
    "$test_root/etc/agent-os/hub.env" \
    "$test_root/etc/agent-os/hub.env.example" \
    "$test_root/etc/systemd/system/agent-os-hub.service" \
    "$test_root/etc/systemd/system/agent-os-hub-candidate@.service" \
    "$test_root/etc/nginx/sites-available/agent-os-hub.conf.example" \
    "$test_root/etc/nginx/conf.d/agent-os-hub-limits.conf.example" \
    "$test_root/opt/agent-os/current" \
    "$test_root/opt/agent-os/previous"; do
    [[ ! -e "$path" && ! -L "$path" ]] || fail "$label was not retry-clean"
  done
  [[ ! -f "$mock_state/active.agent-os-hub.service" && \
    ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label left the service active or enabled"
  [[ ! -e "$test_root/run/agent-os/hub-maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "$label incorrectly entered maintenance"
}

for publish_boundary in \
  environment \
  unit \
  candidate-unit \
  nginx \
  nginx-limits \
  environment-example; do
  printf '%s\n' "$publish_boundary" >"$AGENT_OS_DEPLOY_FAIL_PUBLISH_ONCE"
  : >"$AGENT_OS_MOCK_FAIL_STOP_ONCE"
  : >"$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
  expect_failure \
    "install accepted $publish_boundary publication failure" \
    install_revision_one
  assert_install_retry_clean "install $publish_boundary publication failure"
  [[ -f "$AGENT_OS_MOCK_FAIL_STOP_ONCE" && -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]] ||
    fail "install $publish_boundary publication failure invoked stop or disable before start/enable"
  rm -f -- "$AGENT_OS_MOCK_FAIL_STOP_ONCE" "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
done

: >"$AGENT_OS_MOCK_FAIL_DAEMON_ONCE"
: >"$AGENT_OS_MOCK_FAIL_STOP_ONCE"
: >"$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
expect_failure 'install accepted daemon-reload failure' install_revision_one
assert_install_retry_clean 'install daemon-reload failure'
[[ -f "$AGENT_OS_MOCK_FAIL_STOP_ONCE" && -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]] ||
  fail 'install daemon-reload failure invoked stop or disable before start/enable'
rm -f -- "$AGENT_OS_MOCK_FAIL_STOP_ONCE" "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"

: >"$AGENT_OS_MOCK_FAIL_RENAME_ONCE"
: >"$AGENT_OS_MOCK_FAIL_STOP_ONCE"
: >"$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
expect_failure 'install accepted activation-pointer failure' install_revision_one
assert_install_retry_clean 'install activation-pointer failure'
[[ -f "$AGENT_OS_MOCK_FAIL_STOP_ONCE" && -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]] ||
  fail 'install pointer failure invoked stop or disable before start/enable'
rm -f -- "$AGENT_OS_MOCK_FAIL_STOP_ONCE" "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"

printf '%s\n' revision-1 >"$AGENT_OS_MOCK_FAIL_START_REVISION"
: >"$AGENT_OS_MOCK_FAIL_STOP_ONCE"
: >"$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
expect_failure 'install accepted a failed service start' install_revision_one
assert_install_retry_clean 'install start failure'
[[ ! -f "$AGENT_OS_MOCK_FAIL_STOP_ONCE" && -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]] ||
  fail 'install start failure did not attempt only the required inactive proof cleanup'
rm -f -- "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"

: >"$AGENT_OS_MOCK_WRONG_BODY_ONCE"
expect_failure 'install accepted a service with the wrong liveness body' install_revision_one
assert_install_retry_clean 'install health failure'

printf '%s\n' revision-1 >"$AGENT_OS_MOCK_FAIL_ENABLE_REVISION"
: >"$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
expect_failure 'install accepted enable failure' install_revision_one
assert_install_retry_clean 'install enable failure'
[[ ! -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]] ||
  fail 'install enable failure did not attempt to prove boot disablement'

install_revision_one >/dev/null
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 ]] ||
  fail 'initial release pointer is wrong'
[[ -f "$mock_state/active.agent-os-hub.service" && -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'successful install is not active and enabled'
[[ -f "$test_root/etc/nginx/conf.d/agent-os-hub-limits.conf.example" ]] ||
  fail 'install omitted the scoped Nginx limit zones'
[[ ! -e "$test_root/opt/agent-os/releases/revision-1/deploy" ]] ||
  fail 'installed application release contains admin content'
[[ ! -e "$AGENT_OS_MALICIOUS_MARKER" ]] || fail 'application release executed a malicious admin helper'

admin_health_hash="$(sha256_file "$fixed_bin/health-check.sh")"
AGENT_OS_NODE_BIN="$node_mock" AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
  AGENT_OS_SS_BIN="$ss_mock" AGENT_OS_CURL_BIN="$curl_mock" \
  "$fixed_bin/health-check.sh" --config "$test_root/etc/agent-os/hub.env" \
  --unit agent-os-hub.service --live >/dev/null
expect_failure \
  'readiness passed without a connected Worker' \
  env AGENT_OS_NODE_BIN="$node_mock" AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
  AGENT_OS_SS_BIN="$ss_mock" AGENT_OS_CURL_BIN="$curl_mock" \
  "$fixed_bin/health-check.sh" --config "$test_root/etc/agent-os/hub.env" \
  --unit agent-os-hub.service --ready
: >"$AGENT_OS_MOCK_WRONG_LISTENER_ONCE"
expect_failure \
  'health accepted a listener owned by the wrong PID' \
  env AGENT_OS_NODE_BIN="$node_mock" AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
  AGENT_OS_SS_BIN="$ss_mock" AGENT_OS_CURL_BIN="$curl_mock" \
  "$fixed_bin/health-check.sh" --config "$test_root/etc/agent-os/hub.env" \
  --unit agent-os-hub.service --live
: >"$AGENT_OS_MOCK_WRONG_BODY_ONCE"
expect_failure \
  'health accepted a non-exact JSON body' \
  env AGENT_OS_NODE_BIN="$node_mock" AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
  AGENT_OS_SS_BIN="$ss_mock" AGENT_OS_CURL_BIN="$curl_mock" \
  "$fixed_bin/health-check.sh" --config "$test_root/etc/agent-os/hub.env" \
  --unit agent-os-hub.service --live
: >"$AGENT_OS_MOCK_DROP_SERVICE_ONCE"
expect_failure \
  'health accepted a process that exited immediately after its response' \
  env AGENT_OS_NODE_BIN="$node_mock" AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
  AGENT_OS_SS_BIN="$ss_mock" AGENT_OS_CURL_BIN="$curl_mock" \
  "$fixed_bin/health-check.sh" --config "$test_root/etc/agent-os/hub.env" \
  --unit agent-os-hub.service --live
"$systemctl_mock" start agent-os-hub.service

state_sentinel="$test_root/var/lib/agent-os/hub/state-sentinel"
printf '%s\n' stable >"$state_sentinel"
snapshot_hook_source="$temporary/pre-upgrade-snapshot-source"
cat >"$snapshot_hook_source" <<'HOOK'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f "$AGENT_OS_MOCK_MAINTENANCE" ]]
[[ ! -f "$AGENT_OS_MOCK_STATE/active.agent-os-hub.service" ]]
[[ -d "$1" && ! -e "$2" ]]
mkdir -p "$2"
cp -R "$1/." "$2/"
printf '%s\n' complete >"$2/SNAPSHOT_COMPLETE"
if [[ -f "$AGENT_OS_MOCK_FAIL_SNAPSHOT_ONCE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_FAIL_SNAPSHOT_ONCE"
  exit 1
fi
if [[ -f "$AGENT_OS_MOCK_MUTATE_SNAPSHOT_SOURCE_ONCE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_MUTATE_SNAPSHOT_SOURCE_ONCE"
  printf '%s\n' snapshot-hook-mutated >>"$1/state-sentinel"
fi
if [[ -f "$AGENT_OS_MOCK_ARM_DAEMON_FAILURE" ]]; then
  rm -f -- "$AGENT_OS_MOCK_ARM_DAEMON_FAILURE"
  : >"$AGENT_OS_MOCK_FAIL_DAEMON_ONCE"
fi
HOOK
chmod 0555 "$snapshot_hook_source"
snapshot_hook="$fixed_root/pre-upgrade-snapshot"
chmod u+w "$fixed_root"
install -m 0555 "$snapshot_hook_source" "$snapshot_hook"
chmod u-w "$fixed_root"
export AGENT_OS_MOCK_ARM_DAEMON_FAILURE="$temporary/arm-daemon-failure"
export AGENT_OS_MOCK_FAIL_SNAPSHOT_ONCE="$temporary/fail-snapshot"
export AGENT_OS_MOCK_MUTATE_SNAPSHOT_SOURCE_ONCE="$temporary/mutate-snapshot-source"

upgrade() {
  local revision=$1
  bash "$fixed_bin/upgrade.sh" --archive "$archive" --sha256 "$checksum" \
    --revision "$revision"
}

upgrade_with_snapshot_hook() {
  local revision=$1 hook=$2
  bash "$fixed_bin/upgrade.sh" --archive "$archive" --sha256 "$checksum" \
    --revision "$revision" --snapshot-hook "$hook"
}

outside_snapshot_hook="$temporary/outside-snapshot-hook"
install -m 0555 "$snapshot_hook_source" "$outside_snapshot_hook"
expect_failure \
  'test upgrade accepted a snapshot hook outside the owned test root' \
  upgrade_with_snapshot_hook snapshot-outside "$outside_snapshot_hook"
snapshot_hook_symlink="$test_root/snapshot-hook-symlink"
ln -s "$snapshot_hook" "$snapshot_hook_symlink"
expect_failure \
  'upgrade accepted a symbolic-link snapshot hook' \
  upgrade_with_snapshot_hook snapshot-symlink "$snapshot_hook_symlink"
rm -f -- "$snapshot_hook_symlink"
snapshot_hook_hardlink="$test_root/snapshot-hook-hardlink"
ln "$snapshot_hook" "$snapshot_hook_hardlink"
expect_failure \
  'upgrade accepted a multiply-linked fixed snapshot hook' \
  upgrade_with_snapshot_hook snapshot-hardlink "$snapshot_hook"
rm -f -- "$snapshot_hook_hardlink"
writable_snapshot_root="$test_root/writable-snapshot-root"
install -d -m 0777 "$writable_snapshot_root"
install -m 0555 "$snapshot_hook_source" "$writable_snapshot_root/hook"
expect_failure \
  'upgrade accepted a snapshot hook below a writable ancestor' \
  upgrade_with_snapshot_hook snapshot-writable "$writable_snapshot_root/hook"
chmod 0700 "$writable_snapshot_root"
group_writable_snapshot_hook="$test_root/group-writable-snapshot-hook"
install -m 0575 "$snapshot_hook_source" "$group_writable_snapshot_hook"
expect_failure \
  'upgrade accepted a group-writable snapshot hook' \
  upgrade_with_snapshot_hook snapshot-group-writable "$group_writable_snapshot_hook"
world_writable_snapshot_hook="$test_root/world-writable-snapshot-hook"
install -m 0557 "$snapshot_hook_source" "$world_writable_snapshot_hook"
expect_failure \
  'upgrade accepted a world-writable snapshot hook' \
  upgrade_with_snapshot_hook snapshot-world-writable "$world_writable_snapshot_hook"
for revision in \
  snapshot-outside \
  snapshot-symlink \
  snapshot-hardlink \
  snapshot-writable \
  snapshot-group-writable \
  snapshot-world-writable; do
  [[ ! -e "$test_root/opt/agent-os/releases/$revision" ]] ||
    fail 'snapshot-hook trust rejection staged an application release'
done

assert_recovered() {
  local expected_current=$1 expected_previous=$2 failed_revision=$3
  [[ "$(readlink "$test_root/opt/agent-os/current")" == "releases/$expected_current" ]] ||
    fail "failed $failed_revision did not restore current"
  [[ "$(readlink "$test_root/opt/agent-os/previous")" == "releases/$expected_previous" ]] ||
    fail "failed $failed_revision did not restore previous exactly"
  [[ -f "$mock_state/active.agent-os-hub.service" && -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "failed $failed_revision did not fully sign off the recovered service"
  [[ ! -e "$test_root/run/agent-os/hub-maintenance" && ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "failed $failed_revision left maintenance after a signed-off recovery"
  [[ ! -d "$test_root/opt/agent-os/releases/$failed_revision" ]] ||
    fail "failed $failed_revision remains in the active release pool"
  find "$test_root/opt/agent-os/quarantine" -maxdepth 1 -type d \
    -name "$failed_revision-*" -print -quit | grep -q . ||
    fail "failed $failed_revision was not quarantined"
}

upgrade revision-2 >/dev/null || fail 'first valid upgrade failed after snapshot-hook trust checks'
[[ -f "$AGENT_OS_MOCK_CANDIDATE_TOKEN_ISOLATED" && ! -e "$AGENT_OS_MOCK_CANDIDATE_TOKEN_LEAK" ]] ||
  fail 'candidate process received a production bearer instead of one-time credentials'
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-2 ]] ||
  fail 'successful upgrade did not activate revision-2'
[[ "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-1 ]] ||
  fail 'successful upgrade did not record revision-1'
[[ ! -e "$test_root/run/agent-os/hub-maintenance" ]] ||
  fail 'successful upgrade left maintenance enabled'

bash "$fixed_bin/rollback.sh" >/dev/null
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 ]] ||
  fail 'rollback did not restore revision-1'
[[ "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-2 ]] ||
  fail 'rollback did not record revision-2'

assert_rollback_recovered() {
  local label=$1
  [[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
    "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-2 ]] ||
    fail "$label did not restore both rollback pointers"
  [[ -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label did not fully sign off the recovered service"
  [[ ! -e "$test_root/run/agent-os/hub-maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "$label left maintenance after safe rollback recovery"
}

# A failed first stop has no stopped-state fingerprint. Recovery therefore
# cannot infer that state is unchanged and must remain inactive + fail-closed.
: >"$AGENT_OS_MOCK_FAIL_STOP_ONCE"
expect_failure 'rollback accepted an unverified stop failure' bash "$fixed_bin/rollback.sh"
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
  "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-2 ]] ||
  fail 'rollback stop failure changed pointer history'
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'rollback stop failure did not leave the service inactive and disabled'
[[ -f "$test_root/run/agent-os/hub-maintenance" && \
  -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'rollback stop failure did not block every proxied namespace'

# Test-only explicit recovery after the fail-closed stop evidence.
rm -f -- "$test_root/run/agent-os/hub-maintenance" "$test_root/run/agent-os/hub-maintenance-hard"
"$systemctl_mock" start agent-os-hub.service
"$systemctl_mock" enable agent-os-hub.service

: >"$AGENT_OS_MOCK_FAIL_RENAME_ONCE"
expect_failure 'rollback accepted activation-pointer failure' bash "$fixed_bin/rollback.sh"
assert_rollback_recovered 'rollback activation-pointer failure'

: >"$AGENT_OS_MOCK_FAIL_DAEMON_ONCE"
expect_failure 'rollback accepted daemon-reload failure' bash "$fixed_bin/rollback.sh"
assert_rollback_recovered 'rollback daemon-reload failure'

printf '%s\n' revision-2 >"$AGENT_OS_MOCK_FAIL_START_REVISION"
expect_failure 'rollback accepted target start failure' bash "$fixed_bin/rollback.sh"
assert_rollback_recovered 'rollback target start failure'

printf '%s\n' revision-2 >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
expect_failure 'rollback accepted a target with failed liveness' bash "$fixed_bin/rollback.sh"
rm -f -- "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
assert_rollback_recovered 'rollback target health failure'

printf '%s\n' revision-2 >"$AGENT_OS_MOCK_FAIL_ENABLE_REVISION"
expect_failure 'rollback accepted enable failure' bash "$fixed_bin/rollback.sh"
assert_rollback_recovered 'rollback enable failure'

: >"$AGENT_OS_MOCK_FAIL_PREVIOUS_ONCE"
expect_failure 'rollback accepted previous-pointer failure' bash "$fixed_bin/rollback.sh"
assert_rollback_recovered 'rollback previous-pointer failure'

: >"$AGENT_OS_MOCK_FAIL_FLOCK_ONCE"
expect_failure 'upgrade bypassed a held deployment lock' upgrade lock-rejected
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 ]] ||
  fail 'lock rejection changed current'

: >"$AGENT_OS_MOCK_FAIL_RENAME_ONCE"
activation_failure_output=
if activation_failure_output="$(upgrade revision-3 2>&1)"; then
  fail 'upgrade accepted an activation pointer failure'
fi
if [[ -d "$test_root/opt/agent-os/releases/revision-3" ]]; then
  printf '%s\n' "$activation_failure_output" >&2
fi
assert_recovered revision-1 revision-2 revision-3

# The quarantined logical revision is retryable because staging verifies the
# same trusted artifact again instead of treating failed code as previous.
upgrade revision-3 >/dev/null
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-3 ]] ||
  fail 'same revision did not retry after quarantine'
bash "$fixed_bin/rollback.sh" --revision revision-1 >/dev/null
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 ]] ||
  fail 'post-retry rollback did not restore the baseline'
# The successful rollback now records revision-3; use this exact history for
# every subsequent failure compensation assertion.
expected_previous=revision-3

# A release already signed off as `previous` is not a candidate newly
# introduced by this operation. A failed attempt to re-activate it must retain
# both the pointer and immutable release instead of moving trusted rollback
# material into quarantine.
previous_quarantine_before="$(find "$test_root/opt/agent-os/quarantine" -maxdepth 1 \
  -type d -name 'revision-3-*' | awk 'END { print NR + 0 }')"
printf '%s\n' revision-3 >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
expect_failure \
  'upgrade accepted failed liveness while targeting the recorded previous release' \
  upgrade revision-3
rm -f -- "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
previous_quarantine_after="$(find "$test_root/opt/agent-os/quarantine" -maxdepth 1 \
  -type d -name 'revision-3-*' | awk 'END { print NR + 0 }')"
[[ "$previous_quarantine_after" == "$previous_quarantine_before" ]] ||
  fail 'failed previous-release activation quarantined already signed-off rollback material'
[[ -d "$test_root/opt/agent-os/releases/revision-3" && \
  "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
  "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-3 ]] ||
  fail 'failed previous-release activation did not restore pointer history and release pool'
[[ -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'failed previous-release activation did not recover the signed-off live service'
[[ ! -e "$test_root/run/agent-os/hub-maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'failed previous-release activation left maintenance after safe recovery'

: >"$AGENT_OS_MOCK_FAIL_SNAPSHOT_ONCE"
expect_failure 'upgrade accepted a non-zero snapshot hook' upgrade revision-snapshot-exit
assert_recovered revision-1 "$expected_previous" revision-snapshot-exit

: >"$AGENT_OS_MOCK_MUTATE_SNAPSHOT_SOURCE_ONCE"
expect_failure \
  'upgrade accepted a snapshot hook that changed stopped source state' \
  upgrade revision-snapshot-mutation
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
  "$(readlink "$test_root/opt/agent-os/previous")" == "releases/$expected_previous" ]] ||
  fail 'snapshot source mutation changed pointer history'
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'snapshot source mutation left the service active or enabled'
[[ -f "$test_root/run/agent-os/hub-maintenance" && \
  -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'snapshot source mutation did not block every proxied namespace'
grep -Fq snapshot-hook-mutated "$state_sentinel" ||
  fail 'snapshot source mutation fault did not execute'
[[ ! -d "$test_root/opt/agent-os/releases/revision-snapshot-mutation" ]] ||
  fail 'snapshot source mutation left its failed release in the active pool'

# Test-only state restore after the fail-closed source-mutation evidence.
printf '%s\n' stable >"$state_sentinel"
rm -f -- "$test_root/run/agent-os/hub-maintenance" "$test_root/run/agent-os/hub-maintenance-hard"
"$systemctl_mock" start agent-os-hub.service
"$systemctl_mock" enable agent-os-hub.service

: >"$AGENT_OS_MOCK_ARM_DAEMON_FAILURE"
expect_failure 'upgrade accepted daemon-reload failure' upgrade revision-4
assert_recovered revision-1 "$expected_previous" revision-4

printf '%s\n' revision-5 >"$AGENT_OS_MOCK_FAIL_START_REVISION"
expect_failure 'upgrade accepted shared-state start failure' upgrade revision-5
assert_recovered revision-1 "$expected_previous" revision-5

printf '%s\n' revision-6 >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
expect_failure 'upgrade accepted shared-state health failure' upgrade revision-6
rm -f -- "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
assert_recovered revision-1 "$expected_previous" revision-6

printf '%s\n' revision-7 >"$AGENT_OS_MOCK_FAIL_ENABLE_REVISION"
expect_failure 'upgrade accepted enable failure' upgrade revision-7
assert_recovered revision-1 "$expected_previous" revision-7

: >"$AGENT_OS_MOCK_FAIL_PREVIOUS_ONCE"
previous_failure_output=
if previous_failure_output="$(upgrade revision-8 2>&1)"; then
  fail 'upgrade accepted previous-pointer failure'
fi
if [[ ! -f "$mock_state/active.agent-os-hub.service" ]]; then
  printf '%s\n' "$previous_failure_output" >&2
fi
assert_recovered revision-1 "$expected_previous" revision-8

printf '%s\n' revision-candidate-fail >"$AGENT_OS_MOCK_FAIL_CANDIDATE_REVISION"
candidate_failure_output=
if candidate_failure_output="$(upgrade revision-candidate-fail 2>&1)"; then
  fail 'upgrade accepted an isolated candidate start failure'
fi
rm -f -- "$AGENT_OS_MOCK_FAIL_CANDIDATE_REVISION"
if [[ -e "$test_root/run/agent-os/hub-maintenance" ]]; then
  printf '%s\n' "$candidate_failure_output" >&2
fi
assert_recovered revision-1 "$expected_previous" revision-candidate-fail
[[ ! -e "$test_root/run/agent-os/hub-candidates/revision-candidate-fail.env" ]] ||
  fail 'failed candidate left its secret environment behind'
[[ ! -e "$test_root/var/lib/agent-os/hub-candidates/revision-candidate-fail" ]] ||
  fail 'failed candidate left isolated state behind'

# A candidate that cannot be stopped keeps its secret env, state and release as
# diagnostics, hard-blocks ingress, and prevents another deployment until the
# operator proves the unit inactive.
printf '%s\n' revision-candidate-stop >"$AGENT_OS_MOCK_FAIL_CANDIDATE_STOP_REVISION"
expect_failure 'candidate cleanup ignored a stop failure' upgrade revision-candidate-stop
candidate_stop_unit=agent-os-hub-candidate@revision-candidate-stop.service
[[ -f "$mock_state/active.$candidate_stop_unit" ]] ||
  fail 'candidate stop fault did not leave the diagnostic unit active'
[[ -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'preflight-only candidate stop fault changed the signed-off live service'
[[ -f "$test_root/run/agent-os/hub-candidates/revision-candidate-stop.env" ]] ||
  fail 'unsafe candidate cleanup deleted its credential diagnostic'
[[ -d "$test_root/var/lib/agent-os/hub-candidates/revision-candidate-stop" ]] ||
  fail 'unsafe candidate cleanup deleted its state diagnostic'
[[ -d "$test_root/opt/agent-os/releases/revision-candidate-stop" ]] ||
  fail 'unsafe candidate cleanup moved the release while its process was active'
[[ -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'candidate orphan did not hard-block ingress'
expect_failure 'deployment ignored an existing hard-maintenance state' upgrade hard-state-rejected
[[ ! -e "$test_root/opt/agent-os/releases/hard-state-rejected" ]] ||
  fail 'hard-maintenance rejection staged a new release'

# Test-only operator cleanup after the fail-closed assertions above.
rm -f -- "$AGENT_OS_MOCK_FAIL_CANDIDATE_STOP_REVISION"
"$systemctl_mock" stop "$candidate_stop_unit"
rm -f -- "$test_root/run/agent-os/hub-candidates/revision-candidate-stop.env"
rmdir "$test_root/var/lib/agent-os/hub-candidates/revision-candidate-stop"
rm -f -- "$test_root/run/agent-os/hub-maintenance" "$test_root/run/agent-os/hub-maintenance-hard"

# Fail the final maintenance removal without changing state. Recovery must not
# leave a process running merely because old code itself is healthy.
printf '%s\n' revision-maintenance-fail >"$AGENT_OS_MOCK_CORRUPT_MAINTENANCE_REVISION"
expect_failure 'upgrade accepted maintenance sentinel failure' upgrade revision-maintenance-fail
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
  "$(readlink "$test_root/opt/agent-os/previous")" == "releases/$expected_previous" ]] ||
  fail 'maintenance failure did not restore pointers'
[[ ! -f "$mock_state/active.agent-os-hub.service" && ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'maintenance failure left the service active or enabled'
[[ -d "$test_root/run/agent-os/hub-maintenance" && -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'maintenance failure did not enter hard fail-closed mode'

# Test-only explicit recovery after proving fail-closed behavior.
rmdir "$test_root/run/agent-os/hub-maintenance"
rm -f -- "$test_root/run/agent-os/hub-maintenance-hard"
"$systemctl_mock" start agent-os-hub.service
"$systemctl_mock" enable agent-os-hub.service

# A candidate that changes shared state and then fails is never auto-started
# under old code. The stopped snapshot and both pointers remain available for
# an explicit SVR-03 restore decision.
printf '%s\n' revision-state-change >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
: >"$AGENT_OS_MOCK_MUTATE_STATE_ONCE"
expect_failure 'upgrade auto-recovered after shared state changed' upgrade revision-state-change
rm -f -- "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
  "$(readlink "$test_root/opt/agent-os/previous")" == "releases/$expected_previous" ]] ||
  fail 'state-changing failure did not preserve pointer history'
[[ ! -f "$mock_state/active.agent-os-hub.service" && ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'state-changing failure left the service active or boot-enabled'
[[ -f "$test_root/run/agent-os/hub-maintenance" && -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'state-changing failure did not block every public namespace'
grep -Fq mutated "$state_sentinel" || fail 'state-change fault injection did not execute'
[[ "$(sha256_file "$fixed_bin/health-check.sh")" == "$admin_health_hash" ]] ||
  fail 'an application release updated the fixed privileged admin kit'
[[ ! -e "$AGENT_OS_MALICIOUS_MARKER" ]] || fail 'a release helper executed with administrator authority'
grep -Fq -- '-n 9' "$AGENT_OS_MOCK_FLOCK_LOG" || fail 'deployment operations did not use the global lock'

owned_temporary=$temporary
cleanup || fail 'owned temporary test root could not be removed'
[[ ! -e "$owned_temporary" ]] || fail 'owned temporary test root remains after cleanup'
printf '%s\n' 'hub deploy gate: PASS'
