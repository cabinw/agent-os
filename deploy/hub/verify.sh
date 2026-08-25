#!/bin/bash -p
set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly HUB_ROOT="$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(CDPATH= cd -- "$HUB_ROOT/../.." && pwd -P)"
readonly REAL_NODE_BIN=/usr/bin/node
readonly REAL_COREPACK_BIN=/usr/bin/corepack
readonly TEMPORARY_PARENT="$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)"
readonly VERIFY_FOCUS="${AGENT_OS_VERIFY_FOCUS:-full}"
temporary=

case "$VERIFY_FOCUS" in
  full | rollback-stop-parent-restore | restore-faults-rollback-stop-parent-restore | \
    migration-forward-maintenance-off-fsync | \
    migration-rollback-maintenance-off-fsync | \
    upgrade-maintenance-token-parent-restore) ;;
  *)
    printf 'hub deploy gate failed: unsupported focused gate %s\n' "$VERIFY_FOCUS" >&2
    exit 2
    ;;
esac

if [[ "$VERIFY_FOCUS" == migration-forward-maintenance-off-fsync ]]; then
  trap 'status=$?; printf "hub deploy focused gate internal failure: line=%s status=%s\n" "$LINENO" "$status" >&2' ERR
fi

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

# Namespace inventory used by recovery-focused gates.  Keep this outside the
# migration-only fixture scope so every restore focus can prove rejection is
# byte- and metadata-preserving without enabling the expensive migration tree.
state_fixture_inventory() {
  local root=$1
  (
    cd "$root"
    find . -xdev -printf 'meta\t%P\t%y\t%D\t%i\t%m\t%U\t%G\t%n\t%s\t%T@\n' |
      LC_ALL=C sort
    find . -xdev -type f -exec sha256sum {} + |
      sed 's/^/sha256\t/' | LC_ALL=C sort
  )
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

/bin/bash -p -c '
  source "$1"
  source "$1"
  [[ "$AGENT_OS_HUB_DEPLOY_LIB_INITIALIZED" == v1 && \
    "$LEGACY_ADMIN_PRODUCTION_SHA256" == \
      1f064246a0f547571aa832b374baae377a8bbfb3b8b10733ed530b459d168220 && \
    "$LEGACY_RUNTIME_PRODUCTION_SHA256" == \
      a9f4727b3331d4ed3f2aeb8ea51da730a26507946259d64c352453528d677fea ]]
' _ "$HUB_ROOT/bin/lib.sh" ||
  fail 'trusted deployment library was not idempotently sourceable'
for preset_contract_name in \
  LEGACY_ADMIN_PRODUCTION_SHA256 \
  LEGACY_RUNTIME_PRODUCTION_SHA256; do
  expect_failure \
    "deployment library accepted preset $preset_contract_name" \
    env "$preset_contract_name=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    /bin/bash -p -c 'source "$1"' _ "$HUB_ROOT/bin/lib.sh"
done

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
  'RequiresMountsFor=/opt/agent-os /var/lib/agent-os/hub /var/lib/agent-os-ops /var/backups/agent-os/hub' \
  'Slice=system.slice' \
  'User=agent-os' \
  'Group=agent-os' \
  'EnvironmentFile=/etc/agent-os/hub.env' \
  'ExecStartPre=+/usr/libexec/agent-os/hub/bin/recovery-start-gate.sh' \
  'ExecStartPre=+/usr/libexec/agent-os/hub/bin/validate-config.sh /etc/agent-os/hub.env' \
  'ExecStartPre=+/usr/bin/node /usr/libexec/agent-os/hub/bin/capacity-check.mjs --state /var/lib/agent-os/hub --backup /var/backups/agent-os/hub' \
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
  'RequiresMountsFor=/opt/agent-os /var/lib/agent-os/hub-candidates' \
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
  'open_file_cache off;' \
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
[[ "$(grep -Fc '/var/lib/agent-os-ops/hub-block)' "$nginx")" == 3 ]] ||
  fail 'persistent recovery block must block every proxied namespace'
[[ "$(grep -Fc 'return 503;' "$nginx")" == 9 ]] ||
  fail 'each normal, hard and persistent ingress guard must return 503'
runner_location="$(sed -n '/location \^~ \/runner\/v1\//,/^    }/p' "$nginx")"
[[ "$runner_location" == *'/run/agent-os/hub-maintenance)'* ]] ||
  fail 'normal maintenance does not block Runner reconnect'
[[ "$runner_location" == *'/run/agent-os/hub-maintenance-hard)'* ]] ||
  fail 'hard maintenance does not block Runner reconnect'
[[ "$(grep -Fc 'return 404;' "$nginx")" == 3 ]] ||
  fail 'all public health routes must terminate locally with 404'
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
normal_remove_line="$(grep -nF 'rm -f -- "$MAINTENANCE_PATH"' "$HUB_ROOT/bin/lib.sh" | cut -d: -f1 || true)"
hard_remove_line="$(grep -nF 'rm -f -- "$FAIL_CLOSED_PATH"' "$HUB_ROOT/bin/lib.sh" | cut -d: -f1 || true)"
block_remove_line="$(grep -nF 'rm -f -- "$DURABLE_BLOCK_PATH"' "$HUB_ROOT/bin/lib.sh" | tail -n 1 | cut -d: -f1 || true)"
block_fsync_line="$(grep -nF 'fsync_path "$OPS_ROOT"' "$HUB_ROOT/bin/lib.sh" | tail -n 1 | cut -d: -f1 || true)"
runtime_fsync_line="$(grep -nF 'fsync_path "$RUNTIME_ROOT"' "$HUB_ROOT/bin/lib.sh" | tail -n 1 | cut -d: -f1 || true)"
[[ "$normal_remove_line" =~ ^[1-9][0-9]*$ && \
  "$hard_remove_line" =~ ^[1-9][0-9]*$ && \
  "$block_remove_line" =~ ^[1-9][0-9]*$ && \
  "$block_fsync_line" =~ ^[1-9][0-9]*$ && \
  "$runtime_fsync_line" =~ ^[1-9][0-9]*$ ]] ||
  fail 'maintenance cleanup ordering anchors are missing from the audited library'
((hard_remove_line < normal_remove_line && normal_remove_line < runtime_fsync_line && \
  runtime_fsync_line < block_remove_line && block_remove_line < block_fsync_line)) ||
  fail 'maintenance removal does not durably clear runtime guards before the persistent block'
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
assert_contains "$HUB_ROOT/bin/upgrade.sh" \
  '/bin/bash -p "$SNAPSHOT_HOOK_COPY" "$STATE_ROOT" "$snapshot_path"'
assert_contains "$HUB_ROOT/bin/lib.sh" 'chmod 0400 "$copy"'
assert_contains "$HUB_ROOT/bin/lib.sh" 'validate_snapshot_hook_copy "$copy"'
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
assert_contains "$HUB_ROOT/bin/health-check.sh" 'quiescent)'
assert_contains "$HUB_ROOT/bin/health-check.sh" "expected_body='{\"status\":\"quiescent\"}'"
recovery_pre_line="$(grep -nF 'ExecStartPre=+/usr/libexec/agent-os/hub/bin/recovery-start-gate.sh' "$unit" | cut -d: -f1)"
config_pre_line="$(grep -nF 'ExecStartPre=+/usr/libexec/agent-os/hub/bin/validate-config.sh' "$unit" | cut -d: -f1)"
capacity_pre_line="$(grep -nF 'ExecStartPre=+/usr/bin/node /usr/libexec/agent-os/hub/bin/capacity-check.mjs' "$unit" | cut -d: -f1)"
((recovery_pre_line < config_pre_line && config_pre_line < capacity_pre_line)) ||
  fail 'Hub unit recovery, configuration and capacity preflights are out of order'
for admin_relative in \
  bin/recovery-start-gate.sh \
  bin/state-admin.sh \
  bin/state-forensic.mjs \
  bin/state-open-files.mjs \
  bin/state-snapshot.mjs \
  bin/tree-digest.mjs \
  bin/capacity-check.mjs \
  pre-upgrade-snapshot; do
  assert_contains "$HUB_ROOT/bin/lib.sh" "$admin_relative"
done
assert_contains "$HUB_ROOT/bin/lib.sh" 'cleanup_restore_journal_temporaries() {'
assert_contains "$HUB_ROOT/bin/lib.sh" "stat_value '%g' '%g'"
assert_contains "$HUB_ROOT/bin/lib.sh" 'restore journal temporary ownership, mode or link count is unsafe'
assert_contains "$HUB_ROOT/bootstrap-admin.sh" \
  'bootstrap-admin.sh --migrate-installed --expected-current-sha256 HEX [--rollback]'
assert_contains "$HUB_ROOT/bin/lib.sh" 'stop_and_prove_admin_migration_writer_stopped() {'
migration_allowlist="$(sed -n \
  '/^admin_migration_entry_name_is_valid()/,/^}/p' "$HUB_ROOT/bin/lib.sh")"
[[ "$migration_allowlist" == *'intent | metadata | disabled | blocked | stopped | prepared | runtime_activated | admin_activated | daemon_reloaded | started | verified | enabled | committed | rollback_started | rolled_back | finalized) return 0 ;;'* ]] ||
  fail 'admin migration durable-entry allowlist is incomplete or widened'
assert_contains "$HUB_ROOT/bin/lib.sh" \
  'phases=(disabled blocked stopped prepared runtime_activated admin_activated daemon_reloaded started verified enabled committed finalized)'
for admin_entry in install upgrade rollback state-admin validate-config; do
  assert_contains "$HUB_ROOT/bin/$admin_entry.sh" 'readonly ADMIN_ENTRY_GUARD='
done
grep -Eq 'stat -f .*\|\| stat -c' "$HUB_ROOT/bin/lib.sh" &&
  fail 'portable stat fallback can contaminate GNU stat output'
[[ "$(grep -Ec '^[[:space:]]*mode_is_safe "\$' "$HUB_ROOT/bin/lib.sh")" == 12 ]] ||
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
runtime_influence_variables=(
  NODE_OPTIONS
  NODE_PATH
  NODE_EXTRA_CA_CERTS
  NODE_TLS_REJECT_UNAUTHORIZED
  OPENSSL_CONF
  OPENSSL_CONF_INCLUDE
  OPENSSL_ENGINES
  OPENSSL_MODULES
  SSL_CERT_FILE
  SSL_CERT_DIR
)
package_influence_variables=(
  "${runtime_influence_variables[@]}"
  COREPACK_HOME
  COREPACK_DEFAULT_TO_LATEST
  COREPACK_ENABLE_AUTO_PIN
  COREPACK_ENABLE_DOWNLOAD_PROMPT
  COREPACK_ENABLE_NETWORK
  COREPACK_ENABLE_PROJECT_SPEC
  COREPACK_ENABLE_STRICT
  COREPACK_ENV_FILE
  COREPACK_INTEGRITY_KEYS
  COREPACK_NPM_REGISTRY
  COREPACK_NPM_TOKEN
  COREPACK_NPM_USERNAME
  COREPACK_NPM_PASSWORD
  COREPACK_ROOT
  COREPACK_USE_LATEST
)
for influence in "${runtime_influence_variables[@]}"; do
  expect_failure_message \
    "deployment library accepted empty set-state for $influence" \
    "Hub deployment failed: deployment runtime rejects inherited variable $influence" \
    env "$influence=" /bin/bash -p -c 'source "$1"' _ "$HUB_ROOT/bin/lib.sh"
  empty_snapshot_destination="$temporary/empty-influence-snapshot-$influence"
  expect_failure_message \
    "snapshot helper accepted empty set-state for $influence" \
    "Hub state snapshot failed: inherited runtime variable is forbidden: $influence" \
    env "$influence=" /bin/bash -p "$HUB_ROOT/pre-upgrade-snapshot" \
    "$fixture" "$empty_snapshot_destination"
  [[ ! -e "$empty_snapshot_destination" && ! -L "$empty_snapshot_destination" ]] ||
    fail "$influence empty set-state reached snapshot publication"
done
for influence in "${package_influence_variables[@]}"; do
  empty_package_output="$temporary/empty-influence-package-$influence.tar.gz"
  expect_failure_message \
    "package builder accepted empty set-state for $influence" \
    "Hub deployment failed: release packaging rejects inherited variable $influence" \
    env "$influence=" /bin/bash -p "$HUB_ROOT/bin/package-release.sh" \
    --source "$fixture" --output "$empty_package_output"
  [[ ! -e "$empty_package_output" && ! -L "$empty_package_output" && \
    ! -e "$empty_package_output.sha256" && ! -L "$empty_package_output.sha256" ]] ||
    fail "$influence empty set-state reached package publication"
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
for entry_name in install.sh upgrade.sh rollback.sh state-admin.sh validate-config.sh; do
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
for entry_name in install.sh upgrade.sh rollback.sh state-admin.sh validate-config.sh; do
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
for entry_name in install.sh upgrade.sh rollback.sh state-admin.sh validate-config.sh; do
  cp "$HUB_ROOT/bin/$entry_name" "$fixed_untrusted_bin/$entry_name"
  chmod 0755 "$fixed_untrusted_bin/$entry_name"
done
cat >"$fixed_untrusted_bin/admin-entry-guard.sh" <<'UNTRUSTED_FIXED_GUARD'
: >"${UNTRUSTED_FIXED_GUARD_MARKER:?}"
exit 97
UNTRUSTED_FIXED_GUARD
chmod 0777 "$fixed_untrusted_bin/admin-entry-guard.sh"
for entry_name in install.sh upgrade.sh rollback.sh state-admin.sh validate-config.sh; do
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
property=
for argument in "$@"; do
  case "$argument" in
    --property=*) property=${argument#--property=} ;;
  esac
done
current_revision() {
  local link="$AGENT_OS_DEPLOY_TEST_ROOT/opt/agent-os/current" target
  [[ -L "$link" ]] || return 0
  target="$(readlink "$link")"
  printf '%s\n' "${target#releases/}"
}
case "$command_name" in
  daemon-reload)
    if [[ -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
      "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-daemon ]]; then
      printf '%s\n' rollback-daemon >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED"
      rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
      kill -KILL "$PPID"
      exit 137
    fi
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
      : >"$AGENT_OS_MOCK_CANDIDATE_START_MARKER"
    fi
    if [[ "$unit" == agent-os-hub.service && -f "$AGENT_OS_MOCK_FAIL_START_REVISION" ]] &&
      [[ "$(cat "$AGENT_OS_MOCK_FAIL_START_REVISION")" == "$(current_revision)" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_START_REVISION"
      exit 1
    fi
    if [[ "$unit" == agent-os-hub.service ]]; then
      installed_unit="$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub.service"
      if grep -Fq \
        'ExecStartPre=+/usr/libexec/agent-os/hub/bin/recovery-start-gate.sh' \
        "$installed_unit"; then
        /bin/bash -p \
          "$AGENT_OS_DEPLOY_TEST_ROOT/usr/libexec/agent-os/hub/bin/recovery-start-gate.sh" \
          >/dev/null
      fi
    fi
    pid=417300
    [[ "$unit" == agent-os-hub-candidate@*.service ]] && pid=141730
    printf '%s\n' "$pid" >"$active_path"
    if [[ "$unit" == agent-os-hub.service && \
      -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
      "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-health ]]; then
      printf '%s\n' service-started >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
    fi
    if [[ "$unit" == agent-os-hub.service && \
      -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
      "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-start ]]; then
      printf '%s\n' rollback-start >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED"
      rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
      kill -KILL "$PPID"
      exit 137
    fi
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
    if [[ "$unit" == agent-os-hub.service && \
      -n "${AGENT_OS_MOCK_STOP_PROC_PATH:-}" ]]; then
      [[ "${AGENT_OS_MOCK_STOP_PROC_PATH%/*}" == \
          "$AGENT_OS_DEPLOY_TEST_ROOT/proc" && \
        "${AGENT_OS_MOCK_STOP_PROC_PATH##*/}" =~ ^[1-9][0-9]*$ && \
        "${AGENT_OS_MOCK_STOP_CONTEXT_PATH%/*}" == \
          "$AGENT_OS_DEPLOY_TEST_ROOT/process-context" && \
        "${AGENT_OS_MOCK_STOP_CONTEXT_PATH##*/}" == \
          "${AGENT_OS_MOCK_STOP_PROC_PATH##*/}" && \
        "$AGENT_OS_MOCK_STOP_CGROUP_EVENTS" == \
          "$AGENT_OS_DEPLOY_TEST_ROOT/cgroup/system.slice/agent-os-hub.service/cgroup.events" && \
        "$AGENT_OS_MOCK_STOP_PROC_REACHED" == \
          "$AGENT_OS_MOCK_STATE/stop-proc-reached" ]] || exit 2
      rm -rf -- \
        "$AGENT_OS_MOCK_STOP_PROC_PATH" \
        "$AGENT_OS_MOCK_STOP_CONTEXT_PATH"
      printf 'populated 0\nfrozen 0\n' \
        >"$AGENT_OS_MOCK_STOP_CGROUP_EVENTS"
      chmod 0600 "$AGENT_OS_MOCK_STOP_CGROUP_EVENTS"
      printf '%s\n' "${AGENT_OS_MOCK_STOP_PROC_PATH##*/}" \
        >"$AGENT_OS_MOCK_STOP_PROC_REACHED"
    fi
    ;;
  is-active)
    if [[ -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
      "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-health ]]; then
      if [[ -f "$active_path" ]]; then
        printf 'systemctl-is-active:unit=%s:active=yes\n' "$unit" \
          >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
      else
        printf 'systemctl-is-active:unit=%s:active=no\n' "$unit" \
          >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
      fi
    fi
    [[ -f "$active_path" ]]
    ;;
  show)
    if [[ "$unit" == agent-os-hub.service && "$property" == MainPID && \
      -f "${AGENT_OS_MOCK_FAIL_INACTIVE_SHOW_ONCE:-}" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_INACTIVE_SHOW_ONCE"
      exit 1
    fi
    case "$property" in
      MainPID)
        if [[ -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
          "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-health ]]; then
          if [[ -f "$active_path" ]]; then
            printf 'systemctl-mainpid:unit=%s:value=%s\n' \
              "$unit" "$(<"$active_path")" \
              >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
          else
            printf 'systemctl-mainpid:unit=%s:value=0\n' "$unit" \
              >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
          fi
        fi
        if [[ "$unit" == agent-os-hub.service && \
          -f "${AGENT_OS_MOCK_EMPTY_MAINPID_ONCE:-}" ]]; then
          rm -f -- "$AGENT_OS_MOCK_EMPTY_MAINPID_ONCE"
        elif [[ "$unit" == agent-os-hub.service && \
          -f "${AGENT_OS_MOCK_NONZERO_MAINPID_ONCE:-}" ]]; then
          rm -f -- "$AGENT_OS_MOCK_NONZERO_MAINPID_ONCE"
          printf '%s\n' 999999
        elif [[ -f "$active_path" ]]; then
          cat "$active_path"
        else
          printf '%s\n' 0
        fi
        ;;
      ActiveState)
        if [[ "$unit" == agent-os-hub.service && \
          -f "${AGENT_OS_MOCK_NONINACTIVE_STATE_ONCE:-}" ]]; then
          rm -f -- "$AGENT_OS_MOCK_NONINACTIVE_STATE_ONCE"
          printf '%s\n' deactivating
        elif [[ -f "$active_path" ]]; then
          printf '%s\n' active
        else
          printf '%s\n' inactive
        fi
        ;;
      ControlGroup)
        if [[ -f "$active_path" ]]; then printf '/system.slice/%s\n' "$unit"; fi
        ;;
      FragmentPath)
        if [[ "$unit" == agent-os-hub.service ]]; then
          if [[ -f "$AGENT_OS_MOCK_BAD_LIVE_FRAGMENT" ]]; then
            printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/redirected-agent-os-hub.service"
          else
            printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub.service"
          fi
        elif [[ -f "$AGENT_OS_MOCK_BAD_CANDIDATE_FRAGMENT" ]]; then
          printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/redirected-agent-os-hub-candidate@.service"
        else
          printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub-candidate@.service"
        fi
        ;;
      DropInPaths)
        if [[ "$unit" == agent-os-hub.service && -f "$AGENT_OS_MOCK_LIVE_DROPIN" ]]; then
          printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub.service.d/override.conf"
        elif [[ "$unit" == agent-os-hub-candidate@*.service && \
          -f "$AGENT_OS_MOCK_CANDIDATE_TEMPLATE_DROPIN" ]]; then
          printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub-candidate@.service.d/override.conf"
        elif [[ "$unit" == agent-os-hub-candidate@*.service && \
          -f "$AGENT_OS_MOCK_CANDIDATE_INSTANCE_DROPIN" ]]; then
          printf '%s\n' "$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/$unit.d/override.conf"
        fi
        ;;
      NeedDaemonReload)
        if [[ "$unit" == agent-os-hub.service && -f "$AGENT_OS_MOCK_LIVE_RELOAD_REQUIRED" ]] ||
          [[ "$unit" == agent-os-hub-candidate@*.service && \
            -f "$AGENT_OS_MOCK_CANDIDATE_RELOAD_REQUIRED" ]]; then
          printf '%s\n' yes
        else
          printf '%s\n' no
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  reset-failed)
    if [[ -f "${AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE:-}" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE"
      exit 1
    fi
    ;;
  enable)
    if [[ -f "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION" ]] &&
      [[ "$(cat "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION")" == "$(current_revision)" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION"
      rm -f -- "$enabled_path"
      exit 1
    fi
    : >"$enabled_path"
    if [[ "$unit" == agent-os-hub.service && \
      -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
      "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-enable ]]; then
      printf '%s\n' rollback-enable >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED"
      rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
      kill -KILL "$PPID"
      exit 137
    fi
    ;;
  disable)
    if [[ -f "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_DISABLE_ONCE"
      exit 1
    fi
    rm -f -- "$enabled_path"
    ;;
  is-enabled)
    if [[ "$unit" == agent-os-hub.service && \
      -f "${AGENT_OS_MOCK_IS_ENABLED_NOT_FOUND_ONCE:-}" ]]; then
      rm -f -- "$AGENT_OS_MOCK_IS_ENABLED_NOT_FOUND_ONCE"
      exit 4
    fi
    [[ -f "$enabled_path" ]]
    ;;
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
if [[ "$port" == 4173 && \
  -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
  "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-health ]]; then
  printf '%s\n' health-ss-entered \
    >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
fi
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
if [[ -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" ]]; then
  rollback_health_armed_value="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")"
  if [[ "$rollback_health_armed_value" == rollback-health ]]; then
    rollback_health_armed_class=exact-rollback-health
  else
    rollback_health_armed_class=other
  fi
  case "$url" in
    *':4173/health/live') rollback_health_url_class=port-4173-probe-live ;;
    *':4173/health/ready') rollback_health_url_class=port-4173-probe-ready ;;
    *':4173/health/'*) rollback_health_url_class=port-4173-probe-other ;;
    *'/health/'*) rollback_health_url_class=other-port-health ;;
    *) rollback_health_url_class=non-health ;;
  esac
  printf 'curl-entered:url=%s:armed=%s\n' \
    "$rollback_health_url_class" "$rollback_health_armed_class" \
    >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
fi
if [[ "$url" == *':4173/health/live' && \
  -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" && \
  "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")" == rollback-health ]]; then
  rollback_health_reason="$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.reason"
  : >"$rollback_health_reason"
  chmod 0600 "$rollback_health_reason"
  rollback_health_fail() {
    printf '%s\n' "$1" >"$rollback_health_reason"
    exit 2
  }
  rollback_health_block="$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops/hub-block"
  [[ -f "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-maintenance" ]] ||
    rollback_health_fail normal-maintenance-missing
  [[ ! -e "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-maintenance-hard" ]] ||
    rollback_health_fail hard-maintenance-present
  [[ -f "$rollback_health_block" && ! -L "$rollback_health_block" ]] ||
    rollback_health_fail durable-block-missing-or-unsafe
  rollback_health_value="$(<"$rollback_health_block")"
  rollback_health_transaction=${rollback_health_value#agent-os-hub-recovery-block-v1:}
  [[ "$rollback_health_transaction" != "$rollback_health_value" && \
    "$rollback_health_value" == \
      "agent-os-hub-recovery-block-v1:$rollback_health_transaction" ]] ||
    rollback_health_fail durable-block-value-invalid
  [[ -f "$AGENT_OS_MOCK_STATE/active.agent-os-hub.service" ]] ||
    rollback_health_fail service-not-active
  [[ ! -f "$AGENT_OS_MOCK_STATE/enabled.agent-os-hub.service" ]] ||
    rollback_health_fail service-still-enabled
  [[ "$PPID" =~ ^[1-9][0-9]*$ && "$PPID" != 1 ]] ||
    rollback_health_fail curl-parent-invalid
  rollback_health_tree="$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.process-tree"
  : >"$rollback_health_tree"
  chmod 0600 "$rollback_health_tree"
  printf '%s\n' tree-created >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  rollback_health_cursor=$PPID
  printf '%s\n' cursor-set >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  rollback_health_target=
  rollback_health_depth=0
  [[ ${AGENT_OS_MOCK_MIGRATION_SOURCE_ROOT+x} == x ]] ||
    rollback_health_fail env-source-root-missing
  [[ ${AGENT_OS_MOCK_MIGRATION_DIGEST+x} == x ]] ||
    rollback_health_fail env-digest-missing
  printf '%s\n' env-source-root-defined >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  printf '%s\n' env-digest-defined >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  rollback_health_expected="/bin/bash -p $AGENT_OS_MOCK_MIGRATION_SOURCE_ROOT/bootstrap-admin.sh --migrate-installed --expected-current-sha256 $AGENT_OS_MOCK_MIGRATION_DIGEST --rollback"
  printf '%s\n' expected-built-defined >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  printf '%s\n' loop-enter >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  while ((rollback_health_depth < 8)); do
    printf '%s\n' ps-before >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
    rollback_health_sample=
    if rollback_health_sample="$(
      /bin/ps \
        -o pid= \
        -o ppid= \
        -o stat= \
        -o args= \
        -p "$rollback_health_cursor"
    )"; then
      rollback_health_ps_rc=0
    else
      rollback_health_ps_rc=$?
    fi
    printf 'ps-after:rc=%s:bytes=%s\n' \
      "$rollback_health_ps_rc" "${#rollback_health_sample}" \
      >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
    if ((rollback_health_ps_rc != 0)); then
      rollback_health_fail process-sample-unavailable
    fi
    [[ -n "$rollback_health_sample" && \
      "$rollback_health_sample" != *$'\n'* ]] ||
      rollback_health_fail process-sample-invalid
    printf '%s\n' sample-valid >>"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
    printf 'sample=%s\n' "$rollback_health_sample" >>"$rollback_health_tree"
    read -r \
      rollback_health_pid \
      rollback_health_parent \
      rollback_health_stat \
      rollback_health_args <<<"$rollback_health_sample" ||
      rollback_health_fail process-sample-unparseable
    [[ "$rollback_health_pid" == "$rollback_health_cursor" && \
      "$rollback_health_parent" =~ ^[1-9][0-9]*$ && \
      -n "$rollback_health_stat" && -n "$rollback_health_args" ]] ||
      rollback_health_fail process-sample-fields-invalid
    if [[ "$rollback_health_args" == "$rollback_health_expected" ]]; then
      rollback_health_target=$rollback_health_pid
      break
    fi
    [[ "$rollback_health_parent" != 1 && \
      "$rollback_health_parent" != "$rollback_health_cursor" ]] || break
    rollback_health_cursor=$rollback_health_parent
    rollback_health_depth=$((rollback_health_depth + 1))
  done
  [[ "$rollback_health_target" =~ ^[1-9][0-9]*$ && \
    "$rollback_health_target" != 1 ]] ||
    rollback_health_fail migration-process-not-found
  kill -0 "$rollback_health_target" 2>/dev/null ||
    rollback_health_fail migration-process-exited-before-kill
  printf '%s\n' rollback-health >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED"
  rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
  kill -KILL "$rollback_health_target" ||
    rollback_health_fail migration-process-kill-failed
  exit 137
fi
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
  */health/quiescent) printf '%s\n%s' '{"status":"quiescent"}' 200 ;;
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
if [[ -f "${AGENT_OS_MOCK_MIGRATION_GAP_AFTER_PREFLIGHT_ONCE:-}" ]]; then
  rm -f -- "$AGENT_OS_MOCK_MIGRATION_GAP_AFTER_PREFLIGHT_ONCE"
  migration_gap_root="$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops/private/upgrade-admin-migration-${AGENT_OS_MOCK_MIGRATION_DIGEST}-attempt-000002"
  install -d -m 0755 "$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops"
  install -d -m 0700 \
    "$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops/private" \
    "$migration_gap_root"
fi
if [[ -f "${AGENT_OS_MOCK_MIGRATION_TAMPER_AFTER_PREFLIGHT_ONCE:-}" ]]; then
  rm -f -- "$AGENT_OS_MOCK_MIGRATION_TAMPER_AFTER_PREFLIGHT_ONCE"
  migration_tamper_intent=${AGENT_OS_MOCK_MIGRATION_TAMPER_INTENT:?}
  chmod 0600 "$migration_tamper_intent"
  printf '%s\n' tampered >>"$migration_tamper_intent"
  chmod 0400 "$migration_tamper_intent"
  printf '%s\n' reached >"${AGENT_OS_MOCK_MIGRATION_TAMPER_REACHED:?}"
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
if [[ "${1:-}" == */state-open-files.mjs && \
  -n "${AGENT_OS_MOCK_OPEN_FILES_REACHED:-}" && \
  -n "${AGENT_OS_MOCK_OPEN_FILES_CASE:-}" ]]; then
  printf '%s\n' "$AGENT_OS_MOCK_OPEN_FILES_CASE" \
    >"$AGENT_OS_MOCK_OPEN_FILES_REACHED"
fi
if [[ "${1:-}" == */state-open-files.mjs && \
  -n "${AGENT_OS_MOCK_OPEN_FILES_CAPTURE:-}" ]]; then
  if "$AGENT_OS_REAL_NODE_BIN" "$@" \
    >"$AGENT_OS_MOCK_OPEN_FILES_CAPTURE.out" \
    2>"$AGENT_OS_MOCK_OPEN_FILES_CAPTURE.err"; then
    open_files_status=0
  else
    open_files_status=$?
  fi
  cat "$AGENT_OS_MOCK_OPEN_FILES_CAPTURE.out"
  cat "$AGENT_OS_MOCK_OPEN_FILES_CAPTURE.err" >&2
  exit "$open_files_status"
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_MIGRATION_KILL_ONCE:-}" ]]; then
  migration_kill_spec="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE")"
  migration_kill_path=${3:-}
  migration_copy_target=${4:-}
  migration_copy_source=
  migration_copy_temporary=
  migration_kill_match=false
  migration_fsync_before_kill=false
  migration_copy_boundary=
  migration_admin_parent="$AGENT_OS_DEPLOY_TEST_ROOT/usr/libexec/agent-os"
  migration_short=${AGENT_OS_MOCK_MIGRATION_DIGEST:0:32}
  migration_recovery_root="$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops/private"
  migration_transaction="upgrade-admin-migration-$AGENT_OS_MOCK_MIGRATION_DIGEST-attempt-000001"
  migration_legacy_transaction="upgrade-admin-migration-$migration_short"
  if [[ -d "$migration_recovery_root/$migration_legacy_transaction" ]]; then
    migration_transaction=$migration_legacy_transaction
  else
    shopt -s nullglob
    migration_transaction_candidates=(
      "$migration_recovery_root"/upgrade-admin-migration-*
      "$migration_recovery_root"/.upgrade-admin-migration-*.tmp
    )
    shopt -u nullglob
    if ((${#migration_transaction_candidates[@]} > 0)); then
      migration_transaction_candidate=${migration_transaction_candidates[$((${#migration_transaction_candidates[@]} - 1))]##*/}
      migration_transaction_candidate=${migration_transaction_candidate#.}
      migration_transaction_candidate=${migration_transaction_candidate%-*-*.tmp}
      migration_transaction=$migration_transaction_candidate
    fi
  fi
  migration_artifact_id=${migration_transaction#upgrade-admin-migration-}
  migration_stage="$migration_admin_parent/.hub-admin-migration-$migration_artifact_id"
  migration_previous="$migration_admin_parent/hub.legacy-$migration_artifact_id"
  migration_failed="$migration_admin_parent/hub.failed-migration-$migration_artifact_id"
  migration_failed_stage="$migration_admin_parent/hub.failed-migration-stage-$migration_artifact_id"
  if [[ "$migration_transaction" == "$migration_legacy_transaction" ]]; then
    migration_previous="$migration_admin_parent/hub.legacy-$AGENT_OS_MOCK_MIGRATION_DIGEST"
  fi
  migration_current="$migration_admin_parent/hub"
  case "$migration_kill_spec" in
    copy-partial:* | copy-complete:*)
      migration_copy_boundary=${migration_kill_spec%%:*}
      migration_copy_kind=${migration_kill_spec#*:}
      if [[ "${2:-}" == *short_write* ]]; then
        case "$migration_copy_kind" in
          admin-stage)
            [[ "$migration_copy_target" == \
              "$migration_admin_parent"/.hub-admin-migration-*/*.admin-migration.tmp ]] &&
              migration_kill_match=true
            ;;
          old-runtime)
            [[ "$migration_copy_target" == \
              */var/lib/agent-os-ops/private/upgrade-admin-migration-*/old-runtime/*.admin-migration.tmp ]] &&
              migration_kill_match=true
            ;;
          new-runtime)
            [[ "$migration_copy_target" == \
              */var/lib/agent-os-ops/private/upgrade-admin-migration-*/new-runtime/*.admin-migration.tmp ]] &&
              migration_kill_match=true
            ;;
          installed-runtime)
            [[ "${3:-}" == */new-runtime/* && \
              "$migration_copy_target" == \
              */.agent-os-admin-migration-*.tmp ]] &&
              migration_kill_match=true
            ;;
          installed-runtime-old)
            [[ "${3:-}" == */old-runtime/* && \
              "$migration_copy_target" == \
              */.agent-os-admin-migration-*.tmp ]] &&
              migration_kill_match=true
            ;;
        esac
      fi
      ;;
    copy-published:*)
      migration_copy_boundary=copy-published
      migration_copy_kind=${migration_kill_spec#copy-published:}
      migration_journal="$migration_recovery_root/$migration_transaction"
      case "$migration_copy_kind" in
        admin-stage)
          migration_copy_source="$AGENT_OS_MOCK_MIGRATION_SOURCE_ROOT/bin/admin-entry-guard.sh"
          migration_copy_target="$migration_stage/bin/admin-entry-guard.sh"
          migration_copy_temporary="$migration_copy_target.admin-migration.tmp"
          migration_copy_mode=0555
          ;;
        old-runtime)
          migration_copy_source="$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub.service"
          migration_copy_target="$migration_journal/old-runtime/hub-unit"
          migration_copy_temporary="$migration_copy_target.admin-migration.tmp"
          migration_copy_mode=0400
          ;;
        new-runtime)
          migration_copy_source="$AGENT_OS_MOCK_MIGRATION_SOURCE_ROOT/systemd/agent-os-hub.service"
          migration_copy_target="$migration_journal/new-runtime/hub-unit"
          migration_copy_temporary="$migration_copy_target.admin-migration.tmp"
          migration_copy_mode=0400
          ;;
        installed-runtime)
          migration_copy_source="$migration_journal/new-runtime/hub-unit"
          migration_copy_target="$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub.service"
          migration_copy_temporary="$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/.agent-os-admin-migration-$migration_artifact_id-hub-unit.tmp"
          migration_copy_mode=0644
          ;;
        installed-runtime-old)
          migration_copy_source="$migration_journal/old-runtime/hub-unit"
          migration_copy_target="$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/agent-os-hub.service"
          migration_copy_temporary="$AGENT_OS_DEPLOY_TEST_ROOT/etc/systemd/system/.agent-os-admin-migration-$migration_artifact_id-hub-unit.tmp"
          migration_copy_mode=0644
          ;;
        *) exit 2 ;;
      esac
      [[ "$migration_kill_path" == "$(dirname -- "$migration_copy_target")" && \
        -f "$migration_copy_source" && -f "$migration_copy_target" && \
        ! -e "$migration_copy_temporary" ]] && \
        /usr/bin/cmp -s "$migration_copy_source" "$migration_copy_target" && \
        migration_kill_match=true
      ;;
    intent-temp)
      [[ "$migration_kill_path" == \
        */var/lib/agent-os-ops/private/.upgrade-admin-migration-*.tmp/.intent-*.tmp ]] &&
        migration_kill_match=true
      ;;
    intent-stage-dir)
      [[ "$migration_kill_path" == \
          */var/lib/agent-os-ops/private/.upgrade-admin-migration-*.tmp && \
        -f "$migration_kill_path/intent" ]] && migration_kill_match=true
      ;;
    intent-final-root)
      migration_final_root="$migration_recovery_root/$migration_transaction"
      [[ "$migration_kill_path" == "$migration_recovery_root" && \
        -f "$migration_final_root/intent" ]] && migration_kill_match=true
      ;;
    phase-temp:*)
      migration_phase=${migration_kill_spec#phase-temp:}
      [[ "$migration_kill_path" == \
        */var/lib/agent-os-ops/private/upgrade-admin-migration-*/."$migration_phase"-*.tmp ]] &&
        migration_kill_match=true
      ;;
    phase-dir:*)
      migration_phase=${migration_kill_spec#phase-dir:}
      [[ "$migration_kill_path" == \
          */var/lib/agent-os-ops/private/upgrade-admin-migration-* && \
        -f "$migration_kill_path/$migration_phase" ]] &&
        migration_kill_match=true
      ;;
    rollback-new-isolated)
      [[ "$migration_kill_path" == "$migration_admin_parent" && \
        ! -e "$migration_current" && -d "$migration_previous" && \
        -d "$migration_failed" && ! -e "$migration_stage" && \
        ! -e "$migration_failed_stage" ]] && migration_kill_match=true
      ;;
    rollback-legacy-restored)
      [[ "$migration_kill_path" == "$migration_admin_parent" && \
        -d "$migration_current" && ! -e "$migration_previous" && \
        -d "$migration_failed" && ! -e "$migration_stage" && \
        ! -e "$migration_failed_stage" ]] && migration_kill_match=true
      ;;
    rollback-stage-isolated)
      [[ "$migration_kill_path" == "$migration_admin_parent" && \
        -d "$migration_current" && ! -e "$migration_previous" && \
        ! -e "$migration_failed" && ! -e "$migration_stage" && \
        -d "$migration_failed_stage" ]] && migration_kill_match=true
      ;;
    forward-legacy-preserved)
      [[ "$migration_kill_path" == "$migration_admin_parent" && \
        ! -e "$migration_current" && -d "$migration_previous" && \
        -d "$migration_stage" && ! -e "$migration_failed" && \
        ! -e "$migration_failed_stage" ]] && migration_kill_match=true
      ;;
    forward-candidate-activated)
      [[ "$migration_kill_path" == "$migration_admin_parent" && \
        -d "$migration_current" && -d "$migration_previous" && \
        ! -e "$migration_stage" && ! -e "$migration_failed" && \
        ! -e "$migration_failed_stage" ]] && migration_kill_match=true
      ;;
    rollback-maintenance-runtime-before | rollback-maintenance-runtime-after | \
      forward-maintenance-runtime-before | forward-maintenance-runtime-after)
      [[ "$migration_kill_path" == "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os" && \
        ! -e "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-maintenance" && \
        ! -e "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-maintenance-hard" && \
        -f "$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops/hub-block" ]] && \
        migration_kill_match=true
      [[ "$migration_kill_spec" == *-after ]] && \
        migration_fsync_before_kill=true
      ;;
    rollback-maintenance-ops-before | rollback-maintenance-ops-after | \
      forward-maintenance-ops-before | forward-maintenance-ops-after)
      [[ "$migration_kill_path" == "$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops" && \
        ! -e "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-maintenance" && \
        ! -e "$AGENT_OS_DEPLOY_TEST_ROOT/run/agent-os/hub-maintenance-hard" && \
        ! -e "$AGENT_OS_DEPLOY_TEST_ROOT/var/lib/agent-os-ops/hub-block" ]] && \
        migration_kill_match=true
      [[ "$migration_kill_spec" == *-after ]] && \
        migration_fsync_before_kill=true
      ;;
  esac
  if [[ "$migration_kill_match" == true ]]; then
    if [[ "$migration_copy_boundary" == copy-partial ]]; then
      umask 0377
      printf 'partial\n' >"$migration_copy_target"
      chmod "${5:-0000}" "$migration_copy_target"
    elif [[ "$migration_copy_boundary" == copy-complete ]]; then
      "$AGENT_OS_REAL_NODE_BIN" "$@"
    fi
    if [[ "$migration_fsync_before_kill" == true ]]; then
      "$AGENT_OS_REAL_NODE_BIN" "$@"
    fi
    printf '%s\n' "$migration_kill_spec" \
      >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED"
    if [[ -n "$migration_copy_boundary" ]]; then
      [[ -n "$migration_copy_source" ]] || migration_copy_source=${3:-}
      [[ -n "$migration_copy_temporary" ]] || migration_copy_temporary=$migration_copy_target
      [[ -n "${migration_copy_mode:-}" ]] || migration_copy_mode=${5:-}
      printf '%s\n' "$migration_copy_source" \
        >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.source"
      printf '%s\n' "$migration_copy_target" \
        >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.target"
      printf '%s\n' "$migration_copy_temporary" \
        >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.temporary"
      printf '%s\n' "$migration_copy_mode" \
        >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.mode"
    fi
    rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
    kill -KILL "$PPID"
    exit 137
  fi
fi
if [[ "${1:-}" == */capacity-check.mjs && \
  -f "${AGENT_OS_MOCK_CAPACITY_STATFS_ONCE:-}" ]]; then
  if [[ " $* " != *' --required-bytes '* || \
    " $* " != *' --required-state-bytes '* ]]; then
    exec "$AGENT_OS_REAL_NODE_BIN" "$@"
  fi
  injected_statfs="$(<"$AGENT_OS_MOCK_CAPACITY_STATFS_ONCE")"
  rm -f -- "$AGENT_OS_MOCK_CAPACITY_STATFS_ONCE"
  exec "$AGENT_OS_REAL_NODE_BIN" "$@" --test-statfs-json "$injected_statfs"
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_KILL_RECOVER_OLD_BOUNDARY:-}" && \
  "${3:-}" == */var/lib/agent-os ]]; then
  recover_old_boundary="$(<"$AGENT_OS_MOCK_KILL_RECOVER_OLD_BOUNDARY")"
  recover_old_block="${3:-}-ops/hub-block"
  recover_old_transaction=
  if [[ -f "$recover_old_block" && ! -L "$recover_old_block" ]]; then
    recover_old_transaction="$(<"$recover_old_block")"
    recover_old_transaction=${recover_old_transaction#agent-os-hub-recovery-block-v1:}
  fi
  recover_old_aborted_present=false
  recover_old_retired_present=false
  [[ "$recover_old_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
    -d "${3:-}/hub.aborted-new-$recover_old_transaction" ]] &&
    recover_old_aborted_present=true
  [[ "$recover_old_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
    -d "${3:-}/hub.pre-restore-$recover_old_transaction" ]] &&
    recover_old_retired_present=true
  recover_old_journal="${3:-}-ops/private/$recover_old_transaction"
  recover_old_phase=invalid
  if [[ -f "$recover_old_journal/new_activated" ]]; then
    recover_old_phase=activated
  elif [[ -f "$recover_old_journal/old_moved" ]]; then
    recover_old_phase=old_moved
  elif [[ -f "$recover_old_journal/staged" ]]; then
    recover_old_phase=staged
  fi
  recover_old_state_present=false
  [[ -d "${3:-}/hub" && ! -L "${3:-}/hub" ]] && recover_old_state_present=true
  recover_old_kill_match=false
  if [[ "$recover_old_boundary" == staged-target-isolated && \
    "$recover_old_phase" == staged && \
    "$recover_old_aborted_present" == true && \
    "$recover_old_retired_present" == false && \
    "$recover_old_state_present" == true ]]; then
    recover_old_kill_match=true
  elif [[ "$recover_old_boundary" == old-moved-target-isolated && \
    "$recover_old_phase" == old_moved && \
    "$recover_old_aborted_present" == true && \
    "$recover_old_retired_present" == true && \
    "$recover_old_state_present" == false ]]; then
    recover_old_kill_match=true
  elif [[ "$recover_old_boundary" == old-state-reactivated && \
    "$recover_old_phase" == old_moved && \
    "$recover_old_aborted_present" == true && \
    "$recover_old_retired_present" == false && \
    "$recover_old_state_present" == true ]]; then
    recover_old_kill_match=true
  elif [[ "$recover_old_boundary" == active-target-isolated && \
    "$recover_old_phase" == activated && \
    "$recover_old_aborted_present" == true && \
    "$recover_old_retired_present" == true && \
    "$recover_old_state_present" == false ]]; then
    recover_old_kill_match=true
  elif [[ "$recover_old_boundary" == activated-old-state-reactivated && \
    "$recover_old_phase" == activated && \
    "$recover_old_aborted_present" == true && \
    "$recover_old_retired_present" == false && \
    "$recover_old_state_present" == true ]]; then
    recover_old_kill_match=true
  fi
  if [[ "$recover_old_kill_match" == true ]]; then
    "$AGENT_OS_REAL_NODE_BIN" "$@"
    printf '%s\n' "$recover_old_boundary" >"$AGENT_OS_MOCK_KILL_RECOVER_OLD_REACHED"
    rm -f -- "$AGENT_OS_MOCK_KILL_RECOVER_OLD_BOUNDARY"
    kill -KILL "$PPID"
    exit 137
  fi
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_PAUSE_AFTER_JOURNAL_PUBLICATION:-}" && \
  "${3:-}" == */var/lib/agent-os-ops/private/restore-* ]]; then
  journal_pause_phase="$(<"$AGENT_OS_MOCK_PAUSE_AFTER_JOURNAL_PUBLICATION")"
  if [[ "$journal_pause_phase" =~ ^(intent|metadata|prepared)$ && \
    -f "${3:-}/$journal_pause_phase" ]]; then
    "$AGENT_OS_REAL_NODE_BIN" "$@"
    printf '%s\n' "${3##*/}" >"$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED"
    while [[ ! -e "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_RELEASE" ]]; do
      sleep 0.01
    done
    rm -f -- \
      "$AGENT_OS_MOCK_PAUSE_AFTER_JOURNAL_PUBLICATION" \
      "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_RELEASE"
    exit 0
  fi
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_KILL_AFTER_JOURNAL_PUBLICATION:-}" && \
  "${3:-}" == */var/lib/agent-os-ops/private/restore-* ]]; then
  journal_kill_phase="$(<"$AGENT_OS_MOCK_KILL_AFTER_JOURNAL_PUBLICATION")"
  if [[ "$journal_kill_phase" == metadata && -f "${3:-}/metadata" && \
    ! -e "${3:-}/prepared" ]]; then
    "$AGENT_OS_REAL_NODE_BIN" "$@"
    printf '%s\n' "${3##*/}" >"$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED"
    rm -f -- "$AGENT_OS_MOCK_KILL_AFTER_JOURNAL_PUBLICATION"
    kill -KILL "$PPID"
    exit 137
  fi
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_KILL_RESTORE_JOURNAL_TEMP:-}" ]]; then
  journal_temp_probe="$(<"$AGENT_OS_MOCK_KILL_RESTORE_JOURNAL_TEMP")"
  journal_temp_phase=${journal_temp_probe%%:*}
  journal_temp_boundary=${journal_temp_probe#*:}
  if [[ "$journal_temp_phase" =~ ^(intent|metadata|aborted|prepared|staged|old_moved|new_activated|verified|committed|rolled_back)$ && \
    "$journal_temp_boundary" =~ ^(before-fsync|after-fsync)$ && \
    "${3:-}" == */var/lib/agent-os-ops/private/restore-*/."$journal_temp_phase"-*.tmp ]]; then
    printf '%s\n' "${3:-}" >"$AGENT_OS_MOCK_RESTORE_JOURNAL_TEMP_PATH"
    if [[ "$journal_temp_boundary" == after-fsync ]]; then
      "$AGENT_OS_REAL_NODE_BIN" "$@"
    fi
    rm -f -- "$AGENT_OS_MOCK_KILL_RESTORE_JOURNAL_TEMP"
    kill -KILL "$PPID"
    exit 137
  fi
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_INVALID_COMMITTED_MARKER:-}" && \
  "${3:-}" == */var/lib/agent-os-ops/private/restore-* && \
  -f "${3:-}/committed" ]]; then
  invalid_committed_kind="$(<"$AGENT_OS_MOCK_INVALID_COMMITTED_MARKER")"
  printf '%s\n' "${3##*/}" >"$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
  rm -f -- "$AGENT_OS_MOCK_INVALID_COMMITTED_MARKER"
  case "$invalid_committed_kind" in
    mode) chmod 0600 "${3:-}/committed" ;;
    hardlink) ln "${3:-}/committed" "${3:-}/committed-invalid-peer" ;;
    body)
      chmod 0600 "${3:-}/committed"
      printf '%s\n' invalid-committed-body >"${3:-}/committed"
      chmod 0400 "${3:-}/committed"
      ;;
    *) exit 2 ;;
  esac
  exit 1
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_COMMITTED_PHASE_FSYNC:-}" && \
  "${3:-}" == */var/lib/agent-os-ops/private/restore-* && \
  -f "${3:-}/committed" ]]; then
  committed_phase_fault="$(<"$AGENT_OS_MOCK_COMMITTED_PHASE_FSYNC")"
  printf '%s\n' "${3##*/}" >"$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
  rm -f -- "$AGENT_OS_MOCK_COMMITTED_PHASE_FSYNC"
  case "$committed_phase_fault" in
    fail) exit 1 ;;
    term)
      kill -TERM "$PPID"
      exit 143
      ;;
    *) exit 2 ;;
  esac
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  ( -f "${AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC:-}" || \
    -f "${AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC:-}" ) ]]; then
  if [[ "${3:-}" == */var/lib/agent-os-ops/private/restore-* && \
    -f "${3:-}/committed" ]]; then
    printf '%s\n' "${3##*/}" >"$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
  elif [[ -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]]; then
    cleanup_boundary=
    if [[ "${3:-}" == */run/agent-os && \
      ! -e "${3:-}/hub-maintenance" && \
      ! -e "${3:-}/hub-maintenance-hard" && \
      ! -e "${3:-}/hub-recovery-start" ]]; then
      cleanup_boundary=runtime
    fi
    [[ "${3:-}" == */var/lib/agent-os-ops ]] && cleanup_boundary=ops
    requested_boundary=
    if [[ -f "$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC" ]]; then
      requested_boundary="$(<"$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC")"
    elif [[ -f "$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC" ]]; then
      requested_boundary="$(<"$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC")"
    fi
    if [[ -n "$cleanup_boundary" && "$cleanup_boundary" == "$requested_boundary" && \
      -f "$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC"
      exit 1
    fi
    if [[ -n "$cleanup_boundary" && "$cleanup_boundary" == "$requested_boundary" ]]; then
      "$AGENT_OS_REAL_NODE_BIN" "$@"
      rm -f -- "$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC"
      kill -KILL "$PPID"
      exit 137
    fi
  fi
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -n "${AGENT_OS_MOCK_FSYNC_PATH_TRACE:-}" ]]; then
  fsync_trace_class=other
  [[ "${3:-}" == */run/agent-os ]] && fsync_trace_class=runtime-root
  fsync_trace_armed=false
  [[ -f "${AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE:-}" ]] && fsync_trace_armed=true
  fsync_trace_token=false
  fsync_trace_normal=false
  fsync_trace_hard=false
  fsync_trace_block=false
  [[ -e "${AGENT_OS_DEPLOY_TEST_ROOT:-}/run/agent-os/hub-recovery-start" ]] && fsync_trace_token=true
  [[ -e "${AGENT_OS_DEPLOY_TEST_ROOT:-}/run/agent-os/hub-maintenance" ]] && fsync_trace_normal=true
  [[ -e "${AGENT_OS_DEPLOY_TEST_ROOT:-}/run/agent-os/hub-maintenance-hard" ]] && fsync_trace_hard=true
  [[ -e "${AGENT_OS_DEPLOY_TEST_ROOT:-}/var/lib/agent-os-ops/hub-block" ]] && fsync_trace_block=true
  printf 'ordinal=%s class=%s marker_armed=%s token=%s normal=%s hard=%s block=%s\n' \
    "$(( $(wc -l <"$AGENT_OS_MOCK_FSYNC_PATH_TRACE") + 1 ))" \
    "$fsync_trace_class" "$fsync_trace_armed" "$fsync_trace_token" \
    "$fsync_trace_normal" "$fsync_trace_hard" "$fsync_trace_block" \
    >>"$AGENT_OS_MOCK_FSYNC_PATH_TRACE"
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE:-}" ]]; then
  fsync_fault_spec="$(<"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE")"
  if [[ "$fsync_fault_spec" == $'version=2\npath='* ]]; then
    fsync_fault_path="$(sed -n '2s/^path=//p' \
      "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE")"
    fsync_fault_ordinal="$(sed -n '3s/^ordinal=//p' \
      "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE")"
    [[ "$fsync_fault_path" == /* && \
      "$fsync_fault_ordinal" =~ ^[1-9][0-9]{0,3}$ && \
      -n "${AGENT_OS_MOCK_FSYNC_PATH_TRACE:-}" ]] || exit 2
    fsync_fault_seen="$(grep -c ' class=runtime-root ' \
      "$AGENT_OS_MOCK_FSYNC_PATH_TRACE" || true)"
    if [[ "${3:-}" == "$fsync_fault_path" && \
      "$fsync_fault_seen" == "$fsync_fault_ordinal" ]]; then
      rm -f -- "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
      exit 1
    fi
  elif [[ "${3:-}" == "$fsync_fault_spec" ]]; then
    rm -f -- "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
    exit 1
  fi
fi
if [[ "${1:-}" == -e && "${2:-}" == *fsyncSync* && \
  -f "${AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE:-}" ]]; then
  kill_phase="$(<"$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE")"
  if [[ "$kill_phase" =~ ^(prepared|staged|old_moved|new_activated|verified|committed)$ && \
    "${3:-}" == */var/lib/agent-os-ops/private/restore-* && \
    -f "${3:-}/$kill_phase" ]]; then
    "$AGENT_OS_REAL_NODE_BIN" "$@"
    rm -f -- "$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE"
    kill -KILL "$PPID"
    exit 137
  fi
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
printf '%s' "$test_nonce" >"$test_root/.agent-os-deploy-test-root"
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
export AGENT_OS_MOCK_CAPACITY_STATFS_ONCE="$temporary/capacity-statfs-once"
export AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE="$temporary/fail-fsync-path-once"
export AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE="$temporary/kill-after-restore-phase"
export AGENT_OS_MOCK_KILL_RESTORE_JOURNAL_TEMP="$temporary/kill-restore-journal-temp"
export AGENT_OS_MOCK_RESTORE_JOURNAL_TEMP_PATH="$temporary/restore-journal-temp-path"
export AGENT_OS_MOCK_PAUSE_AFTER_JOURNAL_PUBLICATION="$temporary/pause-after-journal-publication"
export AGENT_OS_MOCK_KILL_AFTER_JOURNAL_PUBLICATION="$temporary/kill-after-journal-publication"
export AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED="$temporary/journal-publication-reached"
export AGENT_OS_MOCK_JOURNAL_PUBLICATION_RELEASE="$temporary/journal-publication-release"
export AGENT_OS_MOCK_INVALID_COMMITTED_MARKER="$temporary/invalid-committed-marker"
export AGENT_OS_MOCK_COMMITTED_PHASE_FSYNC="$temporary/committed-phase-fsync"
export AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC="$temporary/fail-committed-cleanup-fsync"
export AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC="$temporary/kill-after-committed-cleanup-fsync"
export AGENT_OS_MOCK_KILL_RECOVER_OLD_BOUNDARY="$temporary/kill-recover-old-boundary"
export AGENT_OS_MOCK_KILL_RECOVER_OLD_REACHED="$temporary/kill-recover-old-reached"
export AGENT_OS_MOCK_COMMITTED_TRANSACTION="$temporary/committed-transaction"
export AGENT_OS_MOCK_RESTORE_TOKEN_TRACE="$test_root/restore-token.trace"
install -m 0600 /dev/null "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE"
restore_token_call_sequence=0
last_restore_token_call_label=none

record_restore_token_harness_checkpoint() {
  local stage=$1 call_label=${2:-harness} present=false type=missing
  local uid=unavailable gid=unavailable mode=unavailable links=unavailable
  local value_sha256=unavailable token="$test_root/run/agent-os/hub-recovery-start"
  [[ "$stage" =~ ^[a-z][a-z0-9-]{0,47}$ && \
    "$call_label" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ && \
    -f "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE" && \
    ! -L "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE" ]] ||
    fail 'restore token harness checkpoint is unsafe'
  if [[ -e "$token" || -L "$token" ]]; then
    present=true
    type="$(stat -c '%F' "$token" 2>/dev/null || printf unavailable)"
    uid="$(stat -c '%u' "$token" 2>/dev/null || printf unavailable)"
    gid="$(stat -c '%g' "$token" 2>/dev/null || printf unavailable)"
    mode="$(stat -c '%a' "$token" 2>/dev/null || printf unavailable)"
    links="$(stat -c '%h' "$token" 2>/dev/null || printf unavailable)"
    if [[ -f "$token" && ! -L "$token" ]]; then
      value_sha256="$(sha256_file "$token" 2>/dev/null || printf unavailable)"
    fi
  fi
  printf 'stage=%s call_label=%s pid=%s ppid=%s present=%s type=%s uid=%s gid=%s mode=%s links=%s value_sha256=%s\n' \
    "$stage" "$call_label" "$$" "$PPID" "$present" "$type" "$uid" \
    "$gid" "$mode" "$links" "$value_sha256" \
    >>"$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE"
}
export AGENT_OS_MOCK_BAD_LIVE_FRAGMENT="$temporary/bad-live-fragment"
export AGENT_OS_MOCK_BAD_CANDIDATE_FRAGMENT="$temporary/bad-candidate-fragment"
export AGENT_OS_MOCK_LIVE_DROPIN="$temporary/live-dropin"
export AGENT_OS_MOCK_CANDIDATE_TEMPLATE_DROPIN="$temporary/candidate-template-dropin"
export AGENT_OS_MOCK_CANDIDATE_INSTANCE_DROPIN="$temporary/candidate-instance-dropin"
export AGENT_OS_MOCK_LIVE_RELOAD_REQUIRED="$temporary/live-reload-required"
export AGENT_OS_MOCK_CANDIDATE_RELOAD_REQUIRED="$temporary/candidate-reload-required"
export AGENT_OS_MOCK_CANDIDATE_START_MARKER="$temporary/candidate-started"
export AGENT_OS_MOCK_FAIL_INACTIVE_SHOW_ONCE="$temporary/fail-inactive-show"
export AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE="$temporary/fail-reset-not-loaded"
export AGENT_OS_MOCK_EMPTY_MAINPID_ONCE="$temporary/empty-mainpid"
export AGENT_OS_MOCK_NONZERO_MAINPID_ONCE="$temporary/nonzero-mainpid"
export AGENT_OS_MOCK_NONINACTIVE_STATE_ONCE="$temporary/noninactive-state"
export AGENT_OS_MOCK_IS_ENABLED_NOT_FOUND_ONCE="$temporary/is-enabled-not-found"
export AGENT_OS_MOCK_MIGRATION_KILL_ONCE="$temporary/migration-kill-once"
export AGENT_OS_MOCK_MIGRATION_KILL_REACHED="$temporary/migration-kill-reached"

install_proc_mount_namespace_fixture() {
  local root=$1 task_root=$2 namespace=${3:-4026532223}
  local identity_root="$root/namespace-identities"
  local backing="$identity_root/mnt-$namespace-stable"
  local local_target="$task_root/ns/mnt:[$namespace]"
  install -d -m 0700 "$identity_root" "$task_root/ns"
  if [[ ! -e "$backing" ]]; then
    printf '%s\n' 'mount namespace fixture' >"$backing"
    chmod 0600 "$backing"
  fi
  ln "$backing" "$local_target"
  ln -s "mnt:[$namespace]" "$task_root/ns/mnt"
}

# Reproduce the exact pre-SVR-03 installed contract from Git, then exercise the
# explicit migration entry in isolated roots. The fixture is built from the
# audited historical commit; current-source files are never copied into the
# legacy admin tree.
if [[ "$VERIFY_FOCUS" == full || \
  "$VERIFY_FOCUS" == migration-forward-maintenance-off-fsync || \
  "$VERIFY_FOCUS" == migration-rollback-maintenance-off-fsync ]]; then
readonly LEGACY_ADMIN_COMMIT=658cd6cb97af03b3f341a3bba270e28c17e73dcc
readonly LEGACY_ADMIN_ARCHIVE_SHA256=f99684ba0bcabbc16599d07e90171bc63660ff11e7cd12219b89f09d70a1d65a
readonly LEGACY_SERVER_SHA256=9aa52cb59c508239316baf1fbc4eca083cbce578624bc891a2dfd4d121df1df5
legacy_admin_archive="$temporary/legacy-admin.tar"
legacy_admin_checkout="$temporary/legacy-admin-checkout"
install -d -m 0700 "$legacy_admin_checkout"
if [[ -n "${AGENT_OS_LEGACY_ADMIN_ARCHIVE:-}" ]]; then
  legacy_external_archive=$AGENT_OS_LEGACY_ADMIN_ARCHIVE
  [[ "$legacy_external_archive" == /tmp/* && \
    "$legacy_external_archive" == "$(/usr/bin/realpath -e -- "$legacy_external_archive")" && \
    -f "$legacy_external_archive" && ! -L "$legacy_external_archive" && \
    "$(/usr/bin/stat -c '%u' -- "$legacy_external_archive")" == "$EUID" && \
    "$(/usr/bin/stat -c '%h' -- "$legacy_external_archive")" == 1 && \
    $((8#$(/usr/bin/stat -c '%a' -- "$legacy_external_archive") & 8#022)) == 0 && \
    "$(sha256_file "$legacy_external_archive")" == \
      "$LEGACY_ADMIN_ARCHIVE_SHA256" ]] ||
    fail 'external legacy admin archive is unsafe or not the exact pinned fixture'
  /usr/bin/install -m 0400 -- "$legacy_external_archive" "$legacy_admin_archive" ||
    fail 'could not stage the exact external legacy admin archive'
else
  [[ -x /usr/bin/git ]] || fail 'legacy admin migration gate requires /usr/bin/git'
  /usr/bin/git -C "$REPOSITORY_ROOT" archive --format=tar \
    --output="$legacy_admin_archive" "$LEGACY_ADMIN_COMMIT" \
    deploy/hub apps/chat-spike/src/server.mjs ||
    fail 'could not archive the exact legacy admin commit'
  [[ "$(sha256_file "$legacy_admin_archive")" == \
    "$LEGACY_ADMIN_ARCHIVE_SHA256" ]] ||
    fail 'Git produced a legacy admin archive outside the pinned fixture'
fi
/usr/bin/tar -xf "$legacy_admin_archive" -C "$legacy_admin_checkout" ||
  fail 'could not extract the exact legacy admin archive'
legacy_admin_source="$legacy_admin_checkout/deploy/hub"

legacy_admin_file_list() {
  printf '%s\n' \
    bin/admin-entry-guard.sh \
    bin/copy-artifact.mjs \
    bin/extract-release.mjs \
    bin/health-check.sh \
    bin/install.sh \
    bin/lib.sh \
    bin/rollback.sh \
    bin/state-hash.mjs \
    bin/upgrade.sh \
    bin/validate-config.mjs \
    bin/validate-config.sh \
    bin/verify-release.mjs \
    env.example \
    nginx/agent-os-hub.conf \
    nginx/agent-os-hub-limits.conf \
    systemd/agent-os-hub.service \
    systemd/agent-os-hub-candidate@.service
}

readonly EXPECTED_LEGACY_ADMIN_PRODUCTION_SHA256=1f064246a0f547571aa832b374baae377a8bbfb3b8b10733ed530b459d168220
readonly EXPECTED_LEGACY_RUNTIME_PRODUCTION_SHA256=a9f4727b3331d4ed3f2aeb8ea51da730a26507946259d64c352453528d677fea
[[ "$(sha256_file "$legacy_admin_checkout/apps/chat-spike/src/server.mjs")" == \
  "$LEGACY_SERVER_SHA256" ]] ||
  fail 'legacy archive did not contain the exact pinned server blob'

legacy_virtual_admin="$temporary/legacy-virtual-admin"
legacy_virtual_runtime="$temporary/legacy-virtual-runtime"
install -d -m 0700 \
  "$legacy_virtual_admin/bin" \
  "$legacy_virtual_admin/nginx" \
  "$legacy_virtual_admin/systemd" \
  "$legacy_virtual_runtime"
while IFS= read -r legacy_relative; do
  install -m 0600 \
    "$legacy_admin_source/$legacy_relative" \
    "$legacy_virtual_admin/$legacy_relative"
done < <(legacy_admin_file_list)
install -m 0600 "$legacy_admin_source/systemd/agent-os-hub.service" \
  "$legacy_virtual_runtime/hub-unit"
install -m 0600 "$legacy_admin_source/systemd/agent-os-hub-candidate@.service" \
  "$legacy_virtual_runtime/candidate-unit"
install -m 0600 "$legacy_admin_source/nginx/agent-os-hub.conf" \
  "$legacy_virtual_runtime/nginx-example"
install -m 0600 "$legacy_admin_source/nginx/agent-os-hub-limits.conf" \
  "$legacy_virtual_runtime/nginx-limits"
install -m 0600 "$legacy_admin_source/env.example" \
  "$legacy_virtual_runtime/env-example"
legacy_virtual_summary="$($REAL_NODE_BIN -e '
  const { createHash } = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  function frame(hash, type, relative, mode, size) {
    const value = Buffer.from(JSON.stringify([type, relative, mode, "0", "0", size]));
    hash.update(Buffer.from(`${value.length}:`, "ascii"));
    hash.update(value);
  }
  function digest(root, directoryMode, fileMode) {
    const hash = createHash("sha256");
    let entryCount = 0;
    let fileCount = 0;
    let totalBytes = 0;
    function walk(directory, relative) {
      frame(hash, "directory", relative, directoryMode, 0);
      for (const name of fs.readdirSync(directory).sort()) {
        entryCount += 1;
        const target = path.join(directory, name);
        const child = relative ? `${relative}/${name}` : name;
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) {
          walk(target, child);
        } else if (stat.isFile() && stat.nlink === 1) {
          const contents = fs.readFileSync(target);
          frame(hash, "file", child, fileMode(child), contents.length);
          hash.update(contents);
          fileCount += 1;
          totalBytes += contents.length;
        } else {
          process.exit(2);
        }
      }
    }
    walk(root, "");
    return { entryCount, fileCount, totalBytes, treeSha256: hash.digest("hex") };
  }
  process.stdout.write(JSON.stringify({
    admin: digest(process.argv[1], 0o555, (name) => name.endsWith(".sh") ? 0o555 : 0o444),
    runtime: digest(process.argv[2], 0o500, () => 0o400),
  }));
' "$legacy_virtual_admin" "$legacy_virtual_runtime")" ||
  fail 'could not calculate canonical legacy migration digests'
"$REAL_NODE_BIN" -e '
  const value = JSON.parse(process.argv[1]);
  const [adminDigest, runtimeDigest] = process.argv.slice(2);
  if (value.admin.entryCount !== 20 || value.admin.fileCount !== 17 ||
      value.admin.totalBytes !== 126227 || value.admin.treeSha256 !== adminDigest ||
      value.runtime.entryCount !== 5 || value.runtime.fileCount !== 5 ||
      value.runtime.totalBytes !== 8233 || value.runtime.treeSha256 !== runtimeDigest) {
    process.exit(1);
  }
' "$legacy_virtual_summary" \
  "$EXPECTED_LEGACY_ADMIN_PRODUCTION_SHA256" \
  "$EXPECTED_LEGACY_RUNTIME_PRODUCTION_SHA256" ||
  fail 'pinned legacy archive canonical digests do not match the production allowlist'

current_admin_file_list() {
  printf '%s\n' \
    bin/admin-entry-guard.sh \
    bin/copy-artifact.mjs \
    bin/extract-release.mjs \
    bin/health-check.sh \
    bin/install.sh \
    bin/lib.sh \
    bin/rollback.sh \
    bin/recovery-start-gate.sh \
    bin/state-admin.sh \
    bin/state-forensic.mjs \
    bin/state-hash.mjs \
    bin/state-open-files.mjs \
    bin/state-snapshot.mjs \
    bin/tree-digest.mjs \
    bin/capacity-check.mjs \
    bin/upgrade.sh \
    bin/validate-config.mjs \
    bin/validate-config.sh \
    bin/verify-release.mjs \
    env.example \
    nginx/agent-os-hub.conf \
    nginx/agent-os-hub-limits.conf \
    systemd/agent-os-hub.service \
    systemd/agent-os-hub-candidate@.service \
    pre-upgrade-snapshot
}

migration_id_mock="$temporary/migration-id"
cat >"$migration_id_mock" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
option=${1:-}
account=${2:-}
if [[ -z "$account" ]]; then
  case "$option" in
    -u) printf '%s\n' "$MIGRATION_CALLER_UID" ;;
    -g | -G) printf '%s\n' "$MIGRATION_CALLER_GID" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
case "$account" in
  agent-os) uid=$MIGRATION_SERVICE_UID; gid=$MIGRATION_SERVICE_GID ;;
  agent-os-candidate) uid=$MIGRATION_CANDIDATE_UID; gid=$MIGRATION_CANDIDATE_GID ;;
  *) exit 1 ;;
esac
case "$option" in
  -u) printf '%s\n' "$uid" ;;
  -g | -G) printf '%s\n' "$gid" ;;
  -gn) printf '%s\n' "$account" ;;
  *) exit 2 ;;
esac
MOCK
chmod 0755 "$migration_id_mock"
migration_caller_uid=$EUID
migration_caller_gid="$(/usr/bin/id -g)"
migration_candidate_uid=$((EUID + 1))
migration_candidate_gid=$((migration_caller_gid + 1))
migration_service_uid=$((EUID + 2))
migration_service_gid=$((migration_caller_gid + 2))
((migration_service_uid <= 4294967295 && migration_service_gid <= 4294967295)) ||
  fail 'migration fixture could not allocate distinct virtual service ownership'

write_migration_proc_process() {
  local root=$1 pid=$2 uid=$3 cgroup_path=$4
  local pid_root="$root/proc/$pid" task_root context_root field=1
  local stat_line="$pid (fixture $pid) S"
  task_root="$pid_root/task/$pid"
  context_root="$root/process-context/$pid"
  install -d -m 0700 \
    "$task_root/fd" "$task_root/fdinfo" \
    "$context_root/cwd" "$context_root/root"
  while ((field < 19)); do stat_line="$stat_line 0"; field=$((field + 1)); done
  printf '%s 1000\n' "$stat_line" >"$pid_root/stat"
  printf '%s 1000\n' "$stat_line" >"$task_root/stat"
  printf 'Name:\tfixture\nUid:\t%s\t%s\t%s\t%s\n' \
    "$uid" "$uid" "$uid" "$uid" >"$task_root/status"
  printf '0::%s\n' "$cgroup_path" >"$task_root/cgroup"
  printf '1 0 0:42 / %s rw - ext4 /dev/vda2 rw\n260 1 0:4 mnt:[4026532223] %s/run/snapd/ns/lxd.mnt rw - nsfs nsfs rw\n' \
    "$root" "$root" >"$task_root/mountinfo"
  : >"$task_root/maps"
  : >"$task_root/smaps"
  ln -s "$context_root/cwd" "$task_root/cwd"
  ln -s "$context_root/root" "$task_root/root"
  install_proc_mount_namespace_fixture "$root" "$task_root"
  chmod 0600 \
    "$pid_root/stat" "$task_root/stat" "$task_root/status" \
    "$task_root/cgroup" "$task_root/mountinfo" \
    "$task_root/maps" "$task_root/smaps"
}

write_migration_proc_fixture() {
  local root=$1
  write_migration_proc_process \
    "$root" 999 0 /system.slice/fixture-inspector.service
  write_migration_proc_process \
    "$root" 417300 "$migration_service_uid" \
    /system.slice/agent-os-hub.service
  write_migration_proc_process \
    "$root" 417301 0 /system.slice/unrelated-churn.service
  install -d -m 0700 "$root/cgroup/system.slice/agent-os-hub.service"
  printf 'populated 1\nfrozen 0\n' \
    >"$root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
  chmod 0600 "$root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
}

write_migration_state_fixture() {
  local state=$1 lifecycle=${2:-quiescent} request_id=migration-request-1
  local request_hash ledger_root
  request_hash="$(
    "$REAL_NODE_BIN" -e '
      process.stdout.write(
        require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"),
      );
    ' "$request_id"
  )" || fail 'migration state fixture could not hash its request ID'
  [[ "$request_hash" =~ ^[a-f0-9]{64}$ ]] ||
    fail 'migration state fixture produced an invalid request hash'
  install -d -m 0700 "$state"
  case "$lifecycle" in
    quiescent)
      cat >"$state/events.jsonl" <<'EVENTS'
{"id":"migration-event-1","type":"task.created","seq":1,"project":"project-migration","actor":{"kind":"system","id":"runtime"},"subject":{"kind":"task","id":"migration-task-1"},"at":"2026-08-24T00:00:01.000Z","payload":{"task":"migration-task-1","title":"migration fixture","requires":[]}}
{"id":"migration-event-2","type":"task.completed","seq":2,"project":"project-migration","actor":{"kind":"system","id":"runtime"},"subject":{"kind":"task","id":"migration-task-1"},"at":"2026-08-24T00:00:02.000Z","payload":{"task":"migration-task-1","acceptedBy":"human"}}
EVENTS
      ;;
    active)
      cat >"$state/events.jsonl" <<'EVENTS'
{"id":"migration-event-1","type":"task.created","seq":1,"project":"project-migration","actor":{"kind":"system","id":"runtime"},"subject":{"kind":"task","id":"migration-task-1"},"at":"2026-08-24T00:00:01.000Z","payload":{"task":"migration-task-1","title":"migration fixture","requires":[]}}
{"id":"migration-event-2","type":"task.assigned","seq":2,"project":"project-migration","actor":{"kind":"system","id":"runtime"},"subject":{"kind":"task","id":"migration-task-1"},"at":"2026-08-24T00:00:02.000Z","payload":{"task":"migration-task-1","executor":"grok"}}
EVENTS
      ;;
    *) fail 'unknown migration state lifecycle fixture' ;;
  esac
  cat >"$state/remote-placement.json" <<'PLACEMENT'
{
  "version": 1,
  "placements": {
    "[\"migration-user\",\"project-migration\",\"grok\"]": {
      "user": "migration-user",
      "project": "project-migration",
      "agent": "grok",
      "hostId": "migration-worker",
      "updatedAt": "2026-08-24T00:00:00.000Z"
    }
  }
}
PLACEMENT
  ledger_root="$state/remote-placement.json.requests"
  install -d -m 0700 "$ledger_root"
  cat >"$ledger_root/$request_hash.json" <<'LEDGER'
{
  "version": 1,
  "request": {
    "requestId": "migration-request-1",
    "fingerprint": "78d5e55a0fe7b9d2540d2caa26ad9b669c6c47406016f1ff11486a820078bde8",
    "state": "completed",
    "events": [
      {
        "requestId": "migration-request-1",
        "sequence": 1,
        "at": "2026-08-24T00:00:01.000Z",
        "kind": "started",
        "fresh": false
      },
      {
        "requestId": "migration-request-1",
        "sequence": 2,
        "at": "2026-08-24T00:00:02.000Z",
        "kind": "completed",
        "result": {
          "requestId": "migration-request-1",
          "text": "done",
          "sessionId": "migration-session",
          "ms": 10,
          "fresh": false
        }
      }
    ],
    "updatedAt": "2026-08-24T00:00:02.000Z",
    "result": {
      "requestId": "migration-request-1",
      "text": "done",
      "sessionId": "migration-session",
      "ms": 10,
      "fresh": false
    }
  }
}
LEDGER
  chmod 0600 \
    "$state/events.jsonl" \
    "$state/remote-placement.json" \
    "$ledger_root/$request_hash.json"
}

create_legacy_migration_fixture() {
  local root=$1 nonce=$2 state=$3
  local admin relative mode destination summary canonical_summary legacy_release
  [[ ! -e "$root" && ! -e "$state" ]] ||
    fail 'legacy migration fixture root was reused'
  admin="$root/usr/libexec/agent-os/hub"
  install -d -m 0755 "$root"
  printf '%s' "$nonce" >"$root/.agent-os-deploy-test-root"
  chmod 0600 "$root/.agent-os-deploy-test-root"
  install -d -m 0755 "$root/usr/libexec/agent-os"
  install -d -m 0700 "$admin/bin" "$admin/nginx" "$admin/systemd"
  while IFS= read -r relative; do
    mode=0444
    [[ "$relative" == *.sh ]] && mode=0555
    destination="$admin/$relative"
    install -m "$mode" "$legacy_admin_source/$relative" "$destination"
  done < <(legacy_admin_file_list)
  find "$admin" -type d -exec chmod 0555 {} +

  install -d -m 0700 "$root/etc/agent-os"
  install -d -m 0755 \
    "$root/etc/systemd/system" \
    "$root/etc/nginx/sites-available" \
    "$root/etc/nginx/conf.d" \
    "$root/opt/agent-os/releases" \
    "$root/var/lib/agent-os/hub" \
    "$root/run/agent-os"
  legacy_release="$root/opt/agent-os/releases/legacy-release"
  install -d -m 0700 \
    "$legacy_release/apps/chat-spike/src" \
    "$root/opt/agent-os/releases/previous-release/apps/chat-spike/src"
  install -m 0444 \
    "$legacy_admin_checkout/apps/chat-spike/src/server.mjs" \
    "$legacy_release/apps/chat-spike/src/server.mjs"
  install -m 0444 \
    "$legacy_admin_checkout/apps/chat-spike/src/server.mjs" \
    "$root/opt/agent-os/releases/previous-release/apps/chat-spike/src/server.mjs"
  find "$legacy_release" -type d -exec chmod 0555 {} +
  find "$root/opt/agent-os/releases/previous-release" \
    -type d -exec chmod 0555 {} +
  install -m 0644 "$legacy_admin_source/systemd/agent-os-hub.service" \
    "$root/etc/systemd/system/agent-os-hub.service"
  install -m 0644 "$legacy_admin_source/systemd/agent-os-hub-candidate@.service" \
    "$root/etc/systemd/system/agent-os-hub-candidate@.service"
  install -m 0644 "$legacy_admin_source/nginx/agent-os-hub.conf" \
    "$root/etc/nginx/sites-available/agent-os-hub.conf.example"
  install -m 0644 "$legacy_admin_source/nginx/agent-os-hub-limits.conf" \
    "$root/etc/nginx/conf.d/agent-os-hub-limits.conf.example"
  install -m 0600 "$legacy_admin_source/env.example" \
    "$root/etc/agent-os/hub.env.example"
  install -m 0600 "$good_env" "$root/etc/agent-os/hub.env"
  ln -s releases/legacy-release "$root/opt/agent-os/current"
  ln -s releases/previous-release "$root/opt/agent-os/previous"
  write_migration_state_fixture "$root/var/lib/agent-os/hub"
  write_migration_proc_fixture "$root"

  install -d -m 0700 "$state"
  printf '%s\n' 417300 >"$state/active.agent-os-hub.service"
  : >"$state/enabled.agent-os-hub.service"
  : >"$state/systemctl.log"
  : >"$state/flock.log"
  for migration_control_file in \
    stop-proc-reached \
    open-files-reached \
    open-files-proof.out \
    open-files-proof.err; do
    : >"$state/$migration_control_file"
    chmod 0600 "$state/$migration_control_file"
  done
  summary="$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" "$admin")" ||
    fail 'legacy migration fixture could not be fingerprinted'
  LEGACY_MIGRATION_CALLER_DIGEST="$(
    "$REAL_NODE_BIN" -e '
      const value = JSON.parse(process.argv[1]);
      if (!/^[a-f0-9]{64}$/u.test(value.treeSha256)) process.exit(1);
      process.stdout.write(value.treeSha256);
    ' "$summary"
  )" || fail 'legacy migration fixture emitted an invalid caller-owned digest'
  canonical_summary="$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
    --canonical-root-owner "$admin")" ||
    fail 'legacy migration fixture could not calculate its canonical digest'
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    if (value.entryCount !== 20 || value.fileCount !== 17 ||
        value.totalBytes !== 126227 || value.treeSha256 !== process.argv[2]) {
      process.exit(1);
    }
  ' "$canonical_summary" "$EXPECTED_LEGACY_ADMIN_PRODUCTION_SHA256" ||
    fail 'legacy migration fixture does not match the production canonical digest'
  LEGACY_MIGRATION_DIGEST=$EXPECTED_LEGACY_ADMIN_PRODUCTION_SHA256
}

run_admin_migration_from_source() {
  local source=$1 root=$2 nonce=$3 state=$4 digest=$5
  shift 5
  env \
    AGENT_OS_DEPLOY_TEST_MODE=1 \
    AGENT_OS_DEPLOY_TEST_ROOT="$root" \
    AGENT_OS_DEPLOY_TEST_NONCE="$nonce" \
    AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
    AGENT_OS_CURL_BIN="$curl_mock" \
    AGENT_OS_SS_BIN="$ss_mock" \
    AGENT_OS_FLOCK_BIN="$flock_mock" \
    AGENT_OS_NODE_BIN="$node_mock" \
    AGENT_OS_REAL_NODE_BIN="$REAL_NODE_BIN" \
    AGENT_OS_ID_BIN="$migration_id_mock" \
    AGENT_OS_HEALTH_ATTEMPTS=1 \
    AGENT_OS_HEALTH_INTERVAL=0 \
    AGENT_OS_MOCK_STATE="$state" \
    AGENT_OS_MOCK_SYSTEMCTL_LOG="$state/systemctl.log" \
    AGENT_OS_MOCK_FLOCK_LOG="$state/flock.log" \
    AGENT_OS_MOCK_MIGRATION_DIGEST="$digest" \
    AGENT_OS_MOCK_MIGRATION_SOURCE_ROOT="$source" \
    AGENT_OS_MOCK_RESTORE_TOKEN_TRACE= \
    AGENT_OS_MOCK_RESTORE_TOKEN_CALL_LABEL= \
    AGENT_OS_MOCK_STOP_PROC_PATH="$root/proc/417300" \
    AGENT_OS_MOCK_STOP_CONTEXT_PATH="$root/process-context/417300" \
    AGENT_OS_MOCK_STOP_CGROUP_EVENTS="$root/cgroup/system.slice/agent-os-hub.service/cgroup.events" \
    AGENT_OS_MOCK_STOP_PROC_REACHED="$state/stop-proc-reached" \
    AGENT_OS_MOCK_OPEN_FILES_REACHED="$state/open-files-reached" \
    AGENT_OS_MOCK_OPEN_FILES_CASE=migration-writer-stop \
    AGENT_OS_MOCK_OPEN_FILES_CAPTURE="$state/open-files-proof" \
    MIGRATION_CALLER_UID="$migration_caller_uid" \
    MIGRATION_CALLER_GID="$migration_caller_gid" \
    MIGRATION_SERVICE_UID="$migration_service_uid" \
    MIGRATION_SERVICE_GID="$migration_service_gid" \
    MIGRATION_CANDIDATE_UID="$migration_candidate_uid" \
    MIGRATION_CANDIDATE_GID="$migration_candidate_gid" \
    /bin/bash -p "$source/bootstrap-admin.sh" \
      --migrate-installed --expected-current-sha256 "$digest" "$@"
}

run_admin_migration() {
  run_admin_migration_from_source "$HUB_ROOT" "$@"
}

env AGENT_OS_MOCK_RESTORE_TOKEN_TRACE= AGENT_OS_MOCK_RESTORE_TOKEN_CALL_LABEL= \
  /bin/bash -p -c \
    '[[ -z "${AGENT_OS_MOCK_RESTORE_TOKEN_TRACE:-}" && -z "${AGENT_OS_MOCK_RESTORE_TOKEN_CALL_LABEL:-}" ]]' ||
  fail 'admin migration wrapper does not isolate restore token diagnostics'

fresh_admin_migration_transaction() {
  local digest=$1 attempt=${2:-1}
  printf 'upgrade-admin-migration-%s-attempt-%06d\n' "$digest" "$attempt"
}

admin_migration_artifact_id() {
  local transaction=$1
  printf '%s\n' "${transaction#upgrade-admin-migration-}"
}

assert_current_migration_kit() {
  local root=$1 admin relative mode count
  admin="$root/usr/libexec/agent-os/hub"
  count="$(find "$admin" -type f | awk 'END { print NR + 0 }')"
  [[ "$count" == 25 ]] || fail 'admin migration did not publish exactly 25 files'
  while IFS= read -r relative; do
    [[ -f "$admin/$relative" && ! -L "$admin/$relative" ]] ||
      fail "admin migration omitted current file $relative"
    /usr/bin/cmp -s "$admin/$relative" "$HUB_ROOT/$relative" ||
      fail "admin migration changed current file $relative"
    mode="$(stat -c '%a' "$admin/$relative" 2>/dev/null || \
      stat -f '%Lp' "$admin/$relative")"
    if [[ "$relative" == *.sh || "$relative" == pre-upgrade-snapshot ]]; then
      [[ "$mode" == 555 ]] || fail "admin migration set an unsafe mode on $relative"
    else
      [[ "$mode" == 444 ]] || fail "admin migration set an unsafe mode on $relative"
    fi
  done < <(current_admin_file_list)
}

assert_migration_runtime_set() {
  local root=$1 source=$2
  /usr/bin/cmp -s "$root/etc/systemd/system/agent-os-hub.service" \
    "$source/systemd/agent-os-hub.service" || return 1
  /usr/bin/cmp -s "$root/etc/systemd/system/agent-os-hub-candidate@.service" \
    "$source/systemd/agent-os-hub-candidate@.service" || return 1
  /usr/bin/cmp -s "$root/etc/nginx/sites-available/agent-os-hub.conf.example" \
    "$source/nginx/agent-os-hub.conf" || return 1
  /usr/bin/cmp -s "$root/etc/nginx/conf.d/agent-os-hub-limits.conf.example" \
    "$source/nginx/agent-os-hub-limits.conf" || return 1
  /usr/bin/cmp -s "$root/etc/agent-os/hub.env.example" "$source/env.example"
}

assert_migration_phase() {
  local journal=$1 transaction=$2 phase=$3 path mode
  path="$journal/$phase"
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")" ||
    fail "admin migration phase $phase is missing"
  [[ -f "$path" && ! -L "$path" && "$mode" == 400 && \
    "$(<"$path")" == \
      $'version=1\n'"transaction=$transaction"$'\n'"phase=$phase" ]] ||
    fail "admin migration phase $phase is not an exact private record"
}

assert_migration_attempt_intent() {
  local journal=$1 transaction=$2 attempt=$3 predecessor=$4 predecessor_digest=$5
  local old_digest=$6 intent="$journal/intent" token body mode
  printf -v token '%06d' "$attempt"
  printf -v body \
    'version=2\ntransaction=%s\nattempt=%s\npredecessor_transaction=%s\npredecessor_terminal=%s\npredecessor_journal_sha256=%s\nold_admin_sha256=%s' \
    "$transaction" \
    "$token" \
    "$predecessor" \
    "$([[ "$predecessor" == none ]] && printf none || printf rolled_back)" \
    "$predecessor_digest" \
    "$old_digest"
  mode="$(stat -c '%a' "$intent" 2>/dev/null || stat -f '%Lp' "$intent")" ||
    fail 'admin migration attempt intent is missing'
  [[ -f "$intent" && ! -L "$intent" && "$mode" == 400 && \
    "$(stat -c '%h' "$intent" 2>/dev/null || stat -f '%l' "$intent")" == 1 && \
    "$(<"$intent")" == "$body" ]] ||
    fail 'admin migration attempt intent is not exact or private'
}

write_migration_phase_fixture() {
  local journal=$1 transaction=$2 phase=$3
  printf 'version=1\ntransaction=%s\nphase=%s\n' \
    "$transaction" "$phase" >"$journal/$phase"
  chmod 0400 "$journal/$phase"
}

assert_migration_guards_clean() {
  local root=$1
  [[ ! -e "$root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$root/run/agent-os/hub-maintenance" && \
    ! -e "$root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$root/run/agent-os/hub-recovery-start" ]] ||
    fail 'terminal admin migration left a start or ingress guard'
}

migration_state_contract_fingerprint() {
  local state=$1 mode uid gid links digest
  mode="$(stat -c '%a' "$state" 2>/dev/null || stat -f '%Lp' "$state")" ||
    return 1
  uid="$(stat -c '%u' "$state" 2>/dev/null || stat -f '%u' "$state")" ||
    return 1
  gid="$(stat -c '%g' "$state" 2>/dev/null || stat -f '%g' "$state")" ||
    return 1
  links="$(stat -c '%h' "$state" 2>/dev/null || stat -f '%l' "$state")" ||
    return 1
  digest="$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" "$state")" ||
    return 1
  printf '%s|%s|%s|%s|%s\n' "$digest" "$mode" "$uid" "$gid" "$links"
}

migration_control_state_fingerprint() {
  "$REAL_NODE_BIN" -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const hash = createHash("sha256");
    for (const name of fs.readdirSync(root).sort()) {
      if (name === "systemctl.log" || name === "flock.log") continue;
      const target = path.join(root, name);
      const stat = fs.lstatSync(target, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) process.exit(2);
      hash.update(`${name}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.nlink}\0`);
      hash.update(fs.readFileSync(target));
    }
    process.stdout.write(hash.digest("hex"));
  ' "$1"
}

assert_no_service_mutation_since() {
  local label=$1 state=$2 before_line=$3 after_line new_log
  after_line="$(wc -l <"$state/systemctl.log" | tr -d ' ')"
  new_log="$(sed -n "$((before_line + 1)),${after_line}p" \
    "$state/systemctl.log")"
  if printf '%s\n' "$new_log" | \
    grep -Eq '^(start|stop|enable|disable|reset-failed|daemon-reload)( |$)'; then
    fail "$label mutated service state during terminal validation"
  fi
}

assert_finalized_effective_unit_rejected() {
  local label=$1 root=$2 nonce=$3 state=$4 digest=$5 action=$6 fault=$7
  local fault_path root_before control_before log_before error
  local -a action_arguments=()
  [[ "$action" == forward || "$action" == rollback ]] ||
    fail 'unknown finalized effective-unit action'
  [[ "$action" == rollback ]] && action_arguments=(--rollback)
  case "$fault" in
    fragment) fault_path=$AGENT_OS_MOCK_BAD_LIVE_FRAGMENT ;;
    dropin) fault_path=$AGENT_OS_MOCK_LIVE_DROPIN ;;
    reload) fault_path=$AGENT_OS_MOCK_LIVE_RELOAD_REQUIRED ;;
    *) fail 'unknown finalized effective-unit fault' ;;
  esac
  root_before="$(migration_fixture_fingerprint "$root")"
  control_before="$(migration_control_state_fingerprint "$state")"
  log_before="$(wc -l <"$state/systemctl.log" | tr -d ' ')"
  error="$temporary/finalized-effective-${label//[^A-Za-z0-9_-]/_}.err"
  : >"$fault_path"
  if run_admin_migration \
    "$root" "$nonce" "$state" "$digest" "${action_arguments[@]}" \
    >/dev/null 2>"$error"; then
    fail "$label accepted finalized effective-unit $fault drift"
  fi
  rm -f -- "$fault_path"
  [[ "$(tail -n 1 "$error")" == \
      'Hub deployment failed: finalized admin migration no longer matches its terminal state' && \
    "$(migration_fixture_fingerprint "$root")" == "$root_before" && \
    "$(migration_control_state_fingerprint "$state")" == "$control_before" ]] ||
    fail "$label effective-unit $fault rejection changed terminal state"
  assert_no_service_mutation_since \
    "$label effective-unit $fault rejection" "$state" "$log_before"
}

assert_invalid_migration_journal_preflight() {
  local label=$1 root=$2 nonce=$3 state=$4 digest=$5 action=$6
  local root_before root_after state_before state_after error
  local diagnostic_actual diagnostic_expected diagnostic_bytes
  local root_inventory_before root_inventory_after
  local state_inventory_before state_inventory_after systemctl_before
  local -a action_arguments=()
  [[ "$action" == rollback ]] && action_arguments=(--rollback)
  root_before="$(migration_fixture_fingerprint "$root")"
  state_before="$(migration_fixture_fingerprint "$state")"
  error="$temporary/invalid-migration-journal-${label//[^A-Za-z0-9_-]/_}.err"
  root_inventory_before="$error.root-before"
  root_inventory_after="$error.root-after"
  state_inventory_before="$error.state-before"
  state_inventory_after="$error.state-after"
  systemctl_before="$error.systemctl-before"
  migration_fixture_inventory "$root" >"$root_inventory_before"
  migration_fixture_inventory "$state" >"$state_inventory_before"
  cp "$state/systemctl.log" "$systemctl_before"
  if run_admin_migration \
    "$root" "$nonce" "$state" "$digest" "${action_arguments[@]}" \
    >/dev/null 2>"$error"; then
    fail "$label invalid migration journal was accepted"
  fi
  diagnostic_expected='Hub deployment failed: existing admin migration journal is invalid'
  (($# < 7)) || diagnostic_expected=$7
  diagnostic_actual="$(<"$error")"
  if [[ "$diagnostic_actual" != "$diagnostic_expected" ]]; then
    diagnostic_bytes="$(wc -c <"$error" | tr -d ' ')"
    diagnostic_actual=${diagnostic_actual//$root/<test-root>}
    diagnostic_actual=${diagnostic_actual//$HUB_ROOT/<source-root>}
    diagnostic_actual=${diagnostic_actual//$'\n'/';'}
    if ((${#diagnostic_actual} > 512)) || [[ "$diagnostic_actual" == *$'\r'* ]]; then
      diagnostic_actual="redacted-bytes-$diagnostic_bytes"
    fi
    fail "$label invalid journal diagnostic was not exact: actual=[$diagnostic_actual] expected=[$diagnostic_expected]"
  fi
  root_after="$(migration_fixture_fingerprint "$root")"
  if [[ "$root_after" != "$root_before" ]]; then
    migration_fixture_inventory "$root" >"$root_inventory_after"
    diff -u "$root_inventory_before" "$root_inventory_after" | head -n 16 >&2 || true
    fail "$label invalid journal rejection changed the installation root"
  fi
  state_after="$(migration_fixture_fingerprint "$state")"
  if [[ "$state_after" != "$state_before" ]]; then
    migration_fixture_inventory "$state" >"$state_inventory_after"
    diff -u "$state_inventory_before" "$state_inventory_after" | head -n 16 >&2 || true
    if ! cmp -s "$systemctl_before" "$state/systemctl.log"; then
      diff -u "$systemctl_before" "$state/systemctl.log" | head -n 12 >&2 || true
    fi
    fail "$label invalid journal rejection changed process-control state"
  fi
}

assert_migration_writer_proof() {
  local root=$1 state=$2
  local expected_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":false,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":false,"gate":"observable-reference","inspectionComplete":true,"ok":true,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":false,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":false}'
  [[ ! -e "$root/proc/417300" && \
    ! -e "$root/process-context/417300" && \
    -d "$root/proc/417301/task/417301" && \
    -f "$state/stop-proc-reached" && \
    "$(<"$state/stop-proc-reached")" == 417300 && \
    -f "$state/open-files-reached" && \
    "$(<"$state/open-files-reached")" == migration-writer-stop && \
    "$(<"$state/open-files-proof.out")" == "$expected_json" && \
    ! -s "$state/open-files-proof.err" && \
    "$(<"$root/cgroup/system.slice/agent-os-hub.service/cgroup.events")" == \
      $'populated 0\nfrozen 0' ]] ||
    fail 'admin migration did not prove the stopped service process disappeared while unrelated churn remained observable'
}

migration_fixture_fingerprint() {
  "$REAL_NODE_BIN" -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const hash = createHash("sha256");
    function frame(kind, relative, stat) {
      hash.update(`${kind}\0${relative}\0${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.nlink}\0${stat.size}\0${stat.mtimeNs}\0`);
    }
    function walk(current, relative) {
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink()) {
        frame("link", relative, stat);
        hash.update(fs.readlinkSync(current));
        return;
      }
      if (stat.isDirectory()) {
        frame("directory", relative, stat);
        for (const name of fs.readdirSync(current).sort()) {
          walk(path.join(current, name), relative ? `${relative}/${name}` : name);
        }
        return;
      }
      if (stat.isFile()) {
        frame("file", relative, stat);
        hash.update(fs.readFileSync(current));
        return;
      }
      process.exit(2);
    }
    walk(root, "");
    process.stdout.write(hash.digest("hex"));
  ' "$1"
}

migration_fixture_inventory() {
  local root=$1
  (
    cd "$root"
    find . -xdev -printf 'meta\t%P\t%y\t%D\t%i\t%m\t%U\t%G\t%n\t%s\t%T@\n' |
      LC_ALL=C sort
    find . -xdev -type f -exec sha256sum {} + |
      sed 's/^/sha256\t/' | LC_ALL=C sort
  )
}

migration_journal_contract_fingerprint() {
  "$REAL_NODE_BIN" -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const hash = createHash("sha256");
    function frame(kind, relative, stat) {
      hash.update(`${kind}\0${relative}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.nlink}\0${stat.size}\0`);
    }
    function walk(current, relative) {
      const stat = fs.lstatSync(current, { bigint: true });
      if (stat.isSymbolicLink()) process.exit(2);
      if (stat.isDirectory()) {
        frame("directory", relative, stat);
        for (const name of fs.readdirSync(current).sort()) {
          walk(path.join(current, name), relative ? `${relative}/${name}` : name);
        }
        return;
      }
      if (stat.isFile()) {
        frame("file", relative, stat);
        hash.update(fs.readFileSync(current));
        return;
      }
      process.exit(2);
    }
    walk(root, "");
    process.stdout.write(hash.digest("hex"));
  ' "$1"
}

migration_journal_contract_inventory() {
  local root=$1
  (
    cd "$root"
    find . -xdev -printf 'meta\t%P\t%y\t%m\t%U\t%G\t%n\t%s\n' |
      LC_ALL=C sort
    find . -xdev -type f -exec sha256sum {} + |
      sed 's/^/sha256\t/' | LC_ALL=C sort
  )
}

assert_migration_preflight_rejected_without_mutation() {
  local label=$1 source=$2 root=$3 nonce=$4 state=$5 digest=$6 expected=$7
  local before_root after_root before_state after_state
  local error="$temporary/migration-preflight-${label//[^A-Za-z0-9_-]/_}.err"
  before_root="$(migration_fixture_fingerprint "$root")" ||
    fail "$label could not hash its preflight fixture"
  before_state="$(migration_fixture_fingerprint "$state")" ||
    fail "$label could not hash its process-control fixture"
  if run_admin_migration_from_source \
    "$source" "$root" "$nonce" "$state" "$digest" \
    >/dev/null 2>"$error"; then
    fail "$label was accepted"
  fi
  [[ "$(<"$error")" == "$expected" ]] ||
    fail "$label emitted the wrong rejection reason"
  after_root="$(migration_fixture_fingerprint "$root")" ||
    fail "$label could not hash its rejected fixture"
  after_state="$(migration_fixture_fingerprint "$state")" ||
    fail "$label could not hash its rejected process-control fixture"
  [[ "$after_root" == "$before_root" && "$after_state" == "$before_state" && \
    ! -e "$root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$root/run/agent-os/hub-maintenance" && \
    ! -e "$root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$root/run/agent-os/hub-recovery-start" ]] ||
    fail "$label mutated the installation before locked migration intent"
}

migration_wrong_digest_root="$temporary/migration-wrong-digest-root"
migration_wrong_digest_state="$temporary/migration-wrong-digest-state"
migration_wrong_digest_nonce=migrationwrongdigestnonce00000000000001
create_legacy_migration_fixture \
  "$migration_wrong_digest_root" "$migration_wrong_digest_nonce" \
  "$migration_wrong_digest_state"
migration_wrong_digest=$(printf 'f%.0s' {1..64})
[[ "$migration_wrong_digest" != "$LEGACY_MIGRATION_DIGEST" ]] ||
  migration_wrong_digest=$(printf 'e%.0s' {1..64})
assert_migration_preflight_rejected_without_mutation \
  wrong-digest "$HUB_ROOT" \
  "$migration_wrong_digest_root" "$migration_wrong_digest_nonce" \
  "$migration_wrong_digest_state" "$migration_wrong_digest" \
  'Hub deployment failed: installed admin migration supports only the allowlisted legacy release'

migration_admin_drift_root="$temporary/migration-admin-drift-root"
migration_admin_drift_state="$temporary/migration-admin-drift-state"
migration_admin_drift_nonce=migrationadmindriftnonce000000000000001
create_legacy_migration_fixture \
  "$migration_admin_drift_root" "$migration_admin_drift_nonce" \
  "$migration_admin_drift_state"
chmod u+w "$migration_admin_drift_root/usr/libexec/agent-os/hub/env.example"
printf '\n' >>"$migration_admin_drift_root/usr/libexec/agent-os/hub/env.example"
chmod 0444 "$migration_admin_drift_root/usr/libexec/agent-os/hub/env.example"
migration_admin_drift_summary="$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
  "$migration_admin_drift_root/usr/libexec/agent-os/hub")" ||
  fail 'mutated legacy admin fixture could not be fingerprinted'
migration_admin_drift_digest="$($REAL_NODE_BIN -e '
  const value = JSON.parse(process.argv[1]);
  if (!/^[a-f0-9]{64}$/u.test(value.treeSha256)) process.exit(1);
  process.stdout.write(value.treeSha256);
' "$migration_admin_drift_summary")" ||
  fail 'mutated legacy admin fixture emitted an invalid recomputed pin'
[[ "$migration_admin_drift_digest" != "$LEGACY_MIGRATION_DIGEST" ]] ||
  fail 'mutated legacy admin fixture retained the original digest'
assert_migration_preflight_rejected_without_mutation \
  admin-drift "$HUB_ROOT" \
  "$migration_admin_drift_root" "$migration_admin_drift_nonce" \
  "$migration_admin_drift_state" "$migration_admin_drift_digest" \
  'Hub deployment failed: installed admin migration supports only the allowlisted legacy release'

migration_runtime_drift_root="$temporary/migration-runtime-drift-root"
migration_runtime_drift_state="$temporary/migration-runtime-drift-state"
migration_runtime_drift_nonce=migrationruntimedriftnonce0000000000001
create_legacy_migration_fixture \
  "$migration_runtime_drift_root" "$migration_runtime_drift_nonce" \
  "$migration_runtime_drift_state"
migration_runtime_drift_digest=$LEGACY_MIGRATION_DIGEST
printf '\n# drift\n' \
  >>"$migration_runtime_drift_root/etc/systemd/system/agent-os-hub.service"
assert_migration_preflight_rejected_without_mutation \
  runtime-drift "$HUB_ROOT" \
  "$migration_runtime_drift_root" "$migration_runtime_drift_nonce" \
  "$migration_runtime_drift_state" "$migration_runtime_drift_digest" \
  'Hub deployment failed: installed legacy runtime files do not match the pinned admin kit'

migration_wrong_group_gid=
if ((EUID == 0)); then
  migration_wrong_group_gid=1
else
  for migration_candidate_group in $(/usr/bin/id -G); do
    if [[ "$migration_candidate_group" =~ ^(0|[1-9][0-9]*)$ && \
      "$migration_candidate_group" != "$migration_caller_gid" ]]; then
      migration_wrong_group_gid=$migration_candidate_group
      break
    fi
  done
fi
if [[ -n "$migration_wrong_group_gid" ]]; then
  for migration_wrong_group_case in admin runtime; do
    migration_wrong_group_root="$temporary/migration-wrong-group-$migration_wrong_group_case-root"
    migration_wrong_group_state="$temporary/migration-wrong-group-$migration_wrong_group_case-state"
    migration_wrong_group_nonce="migrationwronggroup${migration_wrong_group_case}nonce0000000000001"
    create_legacy_migration_fixture \
      "$migration_wrong_group_root" "$migration_wrong_group_nonce" \
      "$migration_wrong_group_state"
    migration_wrong_group_digest=$LEGACY_MIGRATION_DIGEST
    case "$migration_wrong_group_case" in
      admin)
        /usr/bin/chgrp "$migration_wrong_group_gid" \
          "$migration_wrong_group_root/usr/libexec/agent-os/hub/env.example"
        migration_wrong_group_expected='Hub deployment failed: installed legacy admin kit does not match the operator-pinned digest'
        ;;
      runtime)
        /usr/bin/chgrp "$migration_wrong_group_gid" \
          "$migration_wrong_group_root/etc/systemd/system/agent-os-hub.service"
        migration_wrong_group_expected='Hub deployment failed: installed legacy runtime files do not match the pinned admin kit'
        ;;
    esac
    assert_migration_preflight_rejected_without_mutation \
      "wrong-group-$migration_wrong_group_case" "$HUB_ROOT" \
      "$migration_wrong_group_root" "$migration_wrong_group_nonce" \
      "$migration_wrong_group_state" "$migration_wrong_group_digest" \
      "$migration_wrong_group_expected"
  done
else
  [[ "$(/usr/bin/uname -s)" != Linux ]] ||
    fail 'Linux migration gate could not construct a non-primary GID fixture'
  : >"$temporary/migration-wrong-group-requires-ubuntu-root"
fi

migration_source_drift_root="$temporary/migration-source-drift-root"
migration_source_drift_state="$temporary/migration-source-drift-state"
migration_source_drift_nonce=migrationsourcedriftnonce00000000000001
create_legacy_migration_fixture \
  "$migration_source_drift_root" "$migration_source_drift_nonce" \
  "$migration_source_drift_state"
migration_source_drift_digest=$LEGACY_MIGRATION_DIGEST
migration_drifted_source="$migration_source_drift_root/audited-source"
cp -R "$HUB_ROOT" "$migration_drifted_source"
rm -f -- "$migration_drifted_source/env.example"
assert_migration_preflight_rejected_without_mutation \
  source-drift "$migration_drifted_source" \
  "$migration_source_drift_root" "$migration_source_drift_nonce" \
  "$migration_source_drift_state" "$migration_source_drift_digest" \
  'Hub deployment failed: admin source is incomplete'

migration_source_hardlink_root="$temporary/migration-source-hardlink-root"
migration_source_hardlink_state="$temporary/migration-source-hardlink-state"
migration_source_hardlink_nonce=migrationsourcehardlinknonce0000000000001
create_legacy_migration_fixture \
  "$migration_source_hardlink_root" "$migration_source_hardlink_nonce" \
  "$migration_source_hardlink_state"
migration_source_hardlink_digest=$LEGACY_MIGRATION_DIGEST
migration_hardlinked_source="$migration_source_hardlink_root/audited-source"
cp -R "$HUB_ROOT" "$migration_hardlinked_source"
/usr/bin/cmp -s \
  "$migration_hardlinked_source/bin/lib.sh" "$HUB_ROOT/bin/lib.sh" ||
  fail 'hardlinked source fixture did not retain current audited bytes'
ln "$migration_hardlinked_source/bin/lib.sh" \
  "$migration_hardlinked_source/bin/lib.sh.peer"
assert_migration_preflight_rejected_without_mutation \
  source-hardlink "$migration_hardlinked_source" \
  "$migration_source_hardlink_root" "$migration_source_hardlink_nonce" \
  "$migration_source_hardlink_state" "$migration_source_hardlink_digest" \
  'Hub deployment failed: admin source files must be single-link regular files'

for migration_env_case in mode hardlink invalid-content; do
  migration_env_root="$temporary/migration-env-$migration_env_case-root"
  migration_env_state="$temporary/migration-env-$migration_env_case-state"
  migration_env_nonce="migrationenv${migration_env_case//-/}nonce0000000000000001"
  create_legacy_migration_fixture \
    "$migration_env_root" "$migration_env_nonce" "$migration_env_state"
  migration_env_digest=$LEGACY_MIGRATION_DIGEST
  migration_env_expected=
  case "$migration_env_case" in
    mode)
      chmod 0644 "$migration_env_root/etc/agent-os/hub.env"
      migration_env_expected='Hub deployment failed: installed legacy Hub environment file is unsafe or invalid'
      ;;
    hardlink)
      ln "$migration_env_root/etc/agent-os/hub.env" \
        "$migration_env_root/etc/agent-os/hub.env.peer"
      migration_env_expected='Hub deployment failed: installed legacy Hub environment file is unsafe or invalid'
      ;;
    invalid-content)
      sed 's/^PORT=.*/PORT=4174/' "$good_env" \
        >"$migration_env_root/etc/agent-os/hub.env"
      chmod 0600 "$migration_env_root/etc/agent-os/hub.env"
      migration_env_expected=$'hub configuration rejected: PORT must be exactly 4173 for this audited deployment unit\nHub deployment failed: installed legacy Hub environment file is unsafe or invalid'
      ;;
  esac
  assert_migration_preflight_rejected_without_mutation \
    "env-$migration_env_case" "$HUB_ROOT" \
    "$migration_env_root" "$migration_env_nonce" "$migration_env_state" \
    "$migration_env_digest" "$migration_env_expected"
done

for migration_release_case in empty unsafe; do
  migration_release_root="$temporary/migration-release-$migration_release_case-root"
  migration_release_state="$temporary/migration-release-$migration_release_case-state"
  migration_release_nonce="migrationrelease${migration_release_case}nonce00000000000001"
  create_legacy_migration_fixture \
    "$migration_release_root" "$migration_release_nonce" \
    "$migration_release_state"
  migration_release_digest=$LEGACY_MIGRATION_DIGEST
  case "$migration_release_case" in
    empty)
      chmod 0755 \
        "$migration_release_root/opt/agent-os/releases/legacy-release/apps/chat-spike/src"
      rm -f -- \
        "$migration_release_root/opt/agent-os/releases/legacy-release/apps/chat-spike/src/server.mjs"
      chmod 0555 \
        "$migration_release_root/opt/agent-os/releases/legacy-release/apps/chat-spike/src"
      ;;
    unsafe)
      chmod 0755 \
        "$migration_release_root/opt/agent-os/releases/legacy-release"
      ;;
  esac
  assert_migration_preflight_rejected_without_mutation \
    "release-$migration_release_case" "$HUB_ROOT" \
    "$migration_release_root" "$migration_release_nonce" \
    "$migration_release_state" "$migration_release_digest" \
    'Hub deployment failed: installed legacy release pointer contract is unsafe or incomplete'
done

for migration_previous_release_case in missing mode intermediate-mode hardlink; do
  migration_previous_release_root="$temporary/migration-previous-release-$migration_previous_release_case-root"
  migration_previous_release_state="$temporary/migration-previous-release-$migration_previous_release_case-state"
  migration_previous_release_nonce="migrationpreviousrelease${migration_previous_release_case}nonce0000000001"
  create_legacy_migration_fixture \
    "$migration_previous_release_root" "$migration_previous_release_nonce" \
    "$migration_previous_release_state"
  migration_previous_release_digest=$LEGACY_MIGRATION_DIGEST
  migration_previous_release_server="$migration_previous_release_root/opt/agent-os/releases/previous-release/apps/chat-spike/src/server.mjs"
  case "$migration_previous_release_case" in
    missing)
      chmod 0755 "$(dirname -- "$migration_previous_release_server")"
      rm -f -- "$migration_previous_release_server"
      chmod 0555 "$(dirname -- "$migration_previous_release_server")"
      ;;
    mode)
      chmod 0644 "$migration_previous_release_server"
      ;;
    intermediate-mode)
      chmod 0755 "$(dirname -- "$migration_previous_release_server")"
      ;;
    hardlink)
      chmod 0755 "$(dirname -- "$migration_previous_release_server")"
      ln "$migration_previous_release_server" \
        "$migration_previous_release_server.peer"
      chmod 0555 "$(dirname -- "$migration_previous_release_server")"
      ;;
  esac
  assert_migration_preflight_rejected_without_mutation \
    "previous-release-$migration_previous_release_case" "$HUB_ROOT" \
    "$migration_previous_release_root" "$migration_previous_release_nonce" \
    "$migration_previous_release_state" "$migration_previous_release_digest" \
    'Hub deployment failed: installed legacy release pointer contract is unsafe or incomplete'
done

if [[ -n "$migration_wrong_group_gid" ]]; then
  migration_previous_release_group_root="$temporary/migration-previous-release-group-root"
  migration_previous_release_group_state="$temporary/migration-previous-release-group-state"
  migration_previous_release_group_nonce=migrationpreviousreleasegroupnonce0000000001
  create_legacy_migration_fixture \
    "$migration_previous_release_group_root" "$migration_previous_release_group_nonce" \
    "$migration_previous_release_group_state"
  migration_previous_release_group_digest=$LEGACY_MIGRATION_DIGEST
  /usr/bin/chgrp "$migration_wrong_group_gid" \
    "$migration_previous_release_group_root/opt/agent-os/releases/previous-release/apps/chat-spike/src/server.mjs"
  assert_migration_preflight_rejected_without_mutation \
    previous-release-group "$HUB_ROOT" \
    "$migration_previous_release_group_root" \
    "$migration_previous_release_group_nonce" \
    "$migration_previous_release_group_state" \
    "$migration_previous_release_group_digest" \
    'Hub deployment failed: installed legacy release pointer contract is unsafe or incomplete'
else
  [[ "$(/usr/bin/uname -s)" != Linux ]] || \
    fail 'Linux migration gate could not construct a previous-release wrong-GID fixture'
  : >"$temporary/migration-previous-release-wrong-group-requires-ubuntu-root"
fi

write_valid_admin_migration_intent_artifact() {
  local root=$1 digest=$2 form=$3 transaction recovery artifact
  transaction="upgrade-admin-migration-${digest:0:32}"
  recovery="$root/var/lib/agent-os-ops/private"
  install -d -m 0755 "$root/var/lib/agent-os-ops"
  install -d -m 0700 "$recovery"
  case "$form" in
    staging) artifact="$recovery/.${transaction}-4242-31337.tmp" ;;
    final) artifact="$recovery/$transaction" ;;
    *) fail 'unknown admin migration intent artifact form' ;;
  esac
  install -d -m 0700 "$artifact"
  printf \
    'version=1\ntransaction=%s\nold_admin_sha256=%s\n' \
    "$transaction" "$digest" >"$artifact/intent"
  chmod 0400 "$artifact/intent"
  [[ "$(stat -c '%a' "$artifact" 2>/dev/null || stat -f '%Lp' "$artifact")" == 700 && \
    "$(stat -c '%a' "$artifact/intent" 2>/dev/null || stat -f '%Lp' "$artifact/intent")" == 400 && \
    "$(stat -c '%h' "$artifact/intent" 2>/dev/null || stat -f '%l' "$artifact/intent")" == 1 && \
    "$(<"$artifact/intent")" == \
      $'version=1\ntransaction='"$transaction"$'\nold_admin_sha256='"$digest" ]] || \
    fail 'admin migration carrier fixture did not create an exact intent artifact'
}

for migration_carrier_case in \
  admin-parent-mode \
  systemd-parent-mode \
  nginx-carrier-symlink \
  opt-canonical-ancestor \
  run-parent-mode \
  run-parent-symlink \
  ops-unsafe-valid-staging \
  recovery-unsafe-valid-final; do
  migration_carrier_root="$temporary/migration-carrier-$migration_carrier_case-root"
  migration_carrier_state="$temporary/migration-carrier-$migration_carrier_case-state"
  migration_carrier_nonce="migrationcarrier${migration_carrier_case//-/}nonce0000000001"
  create_legacy_migration_fixture \
    "$migration_carrier_root" "$migration_carrier_nonce" \
    "$migration_carrier_state"
  migration_carrier_digest=$LEGACY_MIGRATION_DIGEST
  case "$migration_carrier_case" in
    admin-parent-mode)
      chmod 0777 "$migration_carrier_root/usr/libexec/agent-os"
      ;;
    systemd-parent-mode)
      chmod 0777 "$migration_carrier_root/etc/systemd/system"
      ;;
    nginx-carrier-symlink)
      mv "$migration_carrier_root/etc/nginx/conf.d" \
        "$migration_carrier_root/etc/nginx/conf.d.real"
      ln -s conf.d.real "$migration_carrier_root/etc/nginx/conf.d"
      ;;
    opt-canonical-ancestor)
      mv "$migration_carrier_root/opt" "$migration_carrier_root/opt.real"
      ln -s opt.real "$migration_carrier_root/opt"
      ;;
    run-parent-mode)
      chmod 0777 "$migration_carrier_root/run"
      ;;
    run-parent-symlink)
      mv "$migration_carrier_root/run" "$migration_carrier_root/run.real"
      ln -s run.real "$migration_carrier_root/run"
      ;;
    ops-unsafe-valid-staging)
      write_valid_admin_migration_intent_artifact \
        "$migration_carrier_root" "$migration_carrier_digest" staging
      chmod 0777 "$migration_carrier_root/var/lib/agent-os-ops"
      ;;
    recovery-unsafe-valid-final)
      write_valid_admin_migration_intent_artifact \
        "$migration_carrier_root" "$migration_carrier_digest" final
      chmod 0755 "$migration_carrier_root/var/lib/agent-os-ops/private"
      ;;
  esac
  assert_migration_preflight_rejected_without_mutation \
    "carrier-$migration_carrier_case" "$HUB_ROOT" \
    "$migration_carrier_root" "$migration_carrier_nonce" \
    "$migration_carrier_state" "$migration_carrier_digest" \
    'Hub deployment failed: installed legacy migration carrier directories are unsafe'
done

expect_admin_migration_sigkill() {
  local label=$1 spec=$2 root=$3 nonce=$4 state=$5 digest=$6
  local migration_exit reached_value= reason= process_tree= reached_state=no armed_state=no
  local stage=none stderr_summary=empty stderr_line= stderr_bytes=0 candidate_summary=
  local systemctl_summary=empty
  local stdout_path="$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stdout"
  local stderr_path="$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stderr"
  shift 6
  rm -f -- \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.source" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.target" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.temporary" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.mode" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.reason" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.process-tree" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage" \
    "$stdout_path" "$stderr_path"
  : >"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage"
  : >"$stdout_path"
  : >"$stderr_path"
  chmod 0600 \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage" \
    "$stdout_path" "$stderr_path"
  printf '%s\n' "$spec" >"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
  if run_admin_migration "$root" "$nonce" "$state" "$digest" "$@" \
    >"$stdout_path" 2>"$stderr_path"; then
    fail "$label did not terminate at its SIGKILL boundary"
  else
    migration_exit=$?
  fi
  if [[ -f "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" ]]; then
    reached_value="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED")"
  fi
  if [[ "$migration_exit" != 137 || \
    -e "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE" || \
    ! -f "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" || \
    "$reached_value" != "$spec" ]]; then
    if [[ -s "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage" ]]; then
      stage="$(tr '\n' ';' <"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.stage")"
      ((${#stage} <= 1024)) || stage=redacted-too-long
    fi
    if [[ -s "$state/systemctl.log" ]]; then
      systemctl_summary="$(tail -n 6 "$state/systemctl.log" | tr '\n' ';')"
      systemctl_summary=${systemctl_summary//$root/<test-root>}
      systemctl_summary=${systemctl_summary//$HUB_ROOT/<source-root>}
      ((${#systemctl_summary} <= 1024)) || systemctl_summary=redacted-too-long
    fi
    stderr_bytes="$(wc -c <"$stderr_path" | tr -d ' ')"
    if [[ -s "$stderr_path" ]]; then
      stderr_summary=
      while IFS= read -r stderr_line; do
        stderr_line=${stderr_line//$root/<test-root>}
        stderr_line=${stderr_line//$HUB_ROOT/<source-root>}
        if ((${#stderr_line} > 512)) || [[ "$stderr_line" == *$'\r'* ]]; then
          stderr_summary="redacted-bytes-$stderr_bytes"
          break
        fi
        candidate_summary=${stderr_summary:+$stderr_summary' | '}$stderr_line
        if ((${#candidate_summary} > 1024)); then
          stderr_summary="redacted-bytes-$stderr_bytes"
          break
        fi
        stderr_summary=$candidate_summary
      done < <(tail -n 4 "$stderr_path")
      [[ -n "$stderr_summary" ]] || stderr_summary=empty
    fi
    if [[ -s "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.reason" ]]; then
      reason="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.reason")"
      if [[ -f "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.process-tree" ]]; then
        process_tree="$(tr '\n' ';' <"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.process-tree")"
      fi
      fail "$label did not prove the requested SIGKILL boundary: $reason stage=$stage stderr=$stderr_summary systemctl=$systemctl_summary tree=$process_tree"
    fi
    [[ -f "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" ]] && reached_state=yes
    [[ -e "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE" ]] && armed_state=yes
    if [[ -f "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.process-tree" ]]; then
      process_tree="$(tr '\n' ';' <"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.process-tree")"
    fi
    fail "$label did not prove the requested SIGKILL boundary: exit=$migration_exit reached=$reached_state armed=$armed_state stage=$stage stderr=$stderr_summary systemctl=$systemctl_summary tree=$process_tree"
  fi
  [[ "$migration_exit" == 137 && \
    ! -e "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE" && \
    -f "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" && \
    "$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED")" == "$spec" ]]
}

assert_migration_fail_closed_after_kill() {
  local label=$1 root=$2 state=$3 transaction=$4 expected_hard=${5:-absent}
  local block="$root/var/lib/agent-os-ops/hub-block"
  [[ -f "$block" && ! -L "$block" ]] ||
    fail "$label lost its regular durable transaction block"
  [[ "$(<"$block")" == "agent-os-hub-recovery-block-v1:$transaction" ]] ||
    fail "$label durable transaction block changed"
  [[ -f "$root/run/agent-os/hub-maintenance" ]] ||
    fail "$label lost normal maintenance"
  case "$expected_hard" in
    absent)
      [[ ! -e "$root/run/agent-os/hub-maintenance-hard" ]] ||
        fail "$label unexpectedly entered hard maintenance"
      ;;
    present)
      [[ -f "$root/run/agent-os/hub-maintenance-hard" && \
        ! -L "$root/run/agent-os/hub-maintenance-hard" ]] ||
        fail "$label did not retain regular hard maintenance"
      ;;
    *) fail "$label has an invalid hard-maintenance expectation" ;;
  esac
  [[ ! -e "$root/run/agent-os/hub-recovery-start" ]] ||
    fail "$label left recovery-start authorization published"
  [[ ! -f "$state/active.agent-os-hub.service" ]] ||
    fail "$label left the Hub active"
  [[ ! -f "$state/enabled.agent-os-hub.service" ]] ||
    fail "$label left the Hub enabled"
}

assert_migration_forward_completed() {
  local label=$1 root=$2 state=$3 source=${4:-$HUB_ROOT}
  if [[ "$source" == "$HUB_ROOT" ]]; then
    assert_current_migration_kit "$root"
  else
    local relative
    while IFS= read -r relative; do
      /usr/bin/cmp -s \
        "$root/usr/libexec/agent-os/hub/$relative" "$source/$relative" ||
        fail "$label did not publish its selected admin source"
    done < <(current_admin_file_list)
  fi
  assert_migration_runtime_set "$root" "$source" ||
    fail "$label did not publish the exact current runtime set"
  assert_migration_guards_clean "$root"
  [[ -f "$state/active.agent-os-hub.service" && \
    -f "$state/enabled.agent-os-hub.service" ]] ||
    fail "$label did not finish active and enabled"
}

assert_rollback_migration_completed() {
  local label=$1 root=$2 state=$3 transaction=$4 journal
  journal="$root/var/lib/agent-os-ops/private/$transaction"
  assert_migration_phase "$journal" "$transaction" rolled_back
  assert_migration_phase "$journal" "$transaction" finalized
  assert_migration_runtime_set "$root" "$legacy_admin_source" ||
    fail "$label did not restore the exact legacy runtime"
  assert_migration_guards_clean "$root"
  [[ -f "$state/active.agent-os-hub.service" && \
    -f "$state/enabled.agent-os-hub.service" ]] ||
    fail "$label did not finish active and enabled"
}

if [[ "$VERIFY_FOCUS" == migration-forward-maintenance-off-fsync ]]; then
  migration_token_fsync_root="$temporary/migration-token-fsync-failure-root"
  migration_token_fsync_state="$temporary/migration-token-fsync-failure-state"
  migration_token_fsync_nonce=migrationtokenfsyncfailurenonce000000000000001
  create_legacy_migration_fixture \
    "$migration_token_fsync_root" "$migration_token_fsync_nonce" \
    "$migration_token_fsync_state"
  migration_token_fsync_digest=$LEGACY_MIGRATION_DIGEST
  migration_token_fsync_transaction="$(fresh_admin_migration_transaction \
    "$migration_token_fsync_digest")"
  migration_token_fsync_journal="$migration_token_fsync_root/var/lib/agent-os-ops/private/$migration_token_fsync_transaction"
  expect_admin_migration_sigkill \
    'focused token publication fsync failure seed' phase-dir:committed \
    "$migration_token_fsync_root" "$migration_token_fsync_nonce" \
    "$migration_token_fsync_state" "$migration_token_fsync_digest"
  migration_token_fsync_trace="$temporary/migration-token-fsync-failure.trace"
  install -m 0600 /dev/null "$migration_token_fsync_trace"
  export AGENT_OS_MOCK_FSYNC_PATH_TRACE="$migration_token_fsync_trace"
  printf '%s\n' "$migration_token_fsync_root/run/agent-os" \
    >"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
  migration_token_fsync_error="$temporary/migration-token-fsync-failure.err"
  if run_admin_migration \
    "$migration_token_fsync_root" "$migration_token_fsync_nonce" \
    "$migration_token_fsync_state" "$migration_token_fsync_digest" \
    >/dev/null 2>"$migration_token_fsync_error"; then
    fail 'forward migration accepted recovery-token publication fsync failure'
  fi
  unset AGENT_OS_MOCK_FSYNC_PATH_TRACE
  [[ ! -e "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE" && \
    "$(tail -n 1 "$migration_token_fsync_error")" == \
      'Hub deployment failed: recovery start token directory durability failed' && \
    -f "$migration_token_fsync_journal/committed" && \
    ! -e "$migration_token_fsync_journal/finalized" && \
    -f "$migration_token_fsync_root/var/lib/agent-os-ops/hub-block" && \
    "$(<"$migration_token_fsync_root/var/lib/agent-os-ops/hub-block")" == \
      "agent-os-hub-recovery-block-v1:$migration_token_fsync_transaction" && \
    -f "$migration_token_fsync_root/run/agent-os/hub-maintenance" && \
    -f "$migration_token_fsync_root/run/agent-os/hub-maintenance-hard" && \
    -f "$migration_token_fsync_root/run/agent-os/hub-recovery-start" && \
    ! -L "$migration_token_fsync_root/run/agent-os/hub-recovery-start" && \
    "$(stat -c '%a' "$migration_token_fsync_root/run/agent-os/hub-recovery-start")" == 400 && \
    "$(<"$migration_token_fsync_root/run/agent-os/hub-recovery-start")" == \
      "$migration_token_fsync_transaction" && \
    ! -e "$migration_token_fsync_state/active.agent-os-hub.service" && \
    ! -e "$migration_token_fsync_state/enabled.agent-os-hub.service" ]] ||
    fail 'recovery-token publication fsync failure was not exact and resumable'
  run_admin_migration \
    "$migration_token_fsync_root" "$migration_token_fsync_nonce" \
    "$migration_token_fsync_state" "$migration_token_fsync_digest" >/dev/null ||
    fail 'recovery-token publication fsync failure did not converge'
  assert_migration_forward_completed \
    'recovery-token publication fsync retry' \
    "$migration_token_fsync_root" "$migration_token_fsync_state"

  migration_forward_off_failure_root="$temporary/migration-forward-maintenance-off-failure-root"
  migration_forward_off_failure_state="$temporary/migration-forward-maintenance-off-failure-state"
  migration_forward_off_failure_nonce=migrationforwardmaintenanceofffailurenonce00000001
  create_legacy_migration_fixture \
    "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
    "$migration_forward_off_failure_state"
  migration_forward_off_failure_digest=$LEGACY_MIGRATION_DIGEST
  migration_forward_off_failure_transaction="$(fresh_admin_migration_transaction \
    "$migration_forward_off_failure_digest")"
  migration_forward_off_failure_journal="$migration_forward_off_failure_root/var/lib/agent-os-ops/private/$migration_forward_off_failure_transaction"
  expect_admin_migration_sigkill \
    'focused forward maintenance-off failure seed' phase-dir:committed \
    "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
    "$migration_forward_off_failure_state" "$migration_forward_off_failure_digest"
  migration_fsync_trace="$temporary/migration-forward-maintenance-off-fsync.trace"
  install -m 0600 /dev/null "$migration_fsync_trace"
  export AGENT_OS_MOCK_FSYNC_PATH_TRACE="$migration_fsync_trace"
  printf 'version=2\npath=%s\nordinal=2\n' \
    "$migration_forward_off_failure_root/run/agent-os" \
    >"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
  migration_forward_off_failure_error="$temporary/migration-forward-maintenance-off-failure.err"
  if run_admin_migration \
    "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
    "$migration_forward_off_failure_state" "$migration_forward_off_failure_digest" \
    >/dev/null 2>"$migration_forward_off_failure_error"; then
    migration_forward_off_failure_status=0
  else
    migration_forward_off_failure_status=$?
  fi
  unset AGENT_OS_MOCK_FSYNC_PATH_TRACE
  migration_forward_off_failure_error_tail="$(tail -n 3 \
    "$migration_forward_off_failure_error" | \
    sed "s#${migration_forward_off_failure_root//\#/\\#}#<migration-root>#g" | \
    tr '\r\n' ';;' | cut -c 1-1024)"
  printf 'focused-migration-fsync status=%s marker=%s committed=%s finalized=%s block=%s normal=%s hard=%s active=%s enabled=%s\n' \
    "$migration_forward_off_failure_status" \
    "$([[ -e "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE" ]] && echo present || echo consumed)" \
    "$([[ -f "$migration_forward_off_failure_journal/committed" ]] && echo present || echo absent)" \
    "$([[ -f "$migration_forward_off_failure_journal/finalized" ]] && echo present || echo absent)" \
    "$([[ -f "$migration_forward_off_failure_root/var/lib/agent-os-ops/hub-block" ]] && echo present || echo absent)" \
    "$([[ -f "$migration_forward_off_failure_root/run/agent-os/hub-maintenance" ]] && echo present || echo absent)" \
    "$([[ -f "$migration_forward_off_failure_root/run/agent-os/hub-maintenance-hard" ]] && echo present || echo absent)" \
    "$([[ -f "$migration_forward_off_failure_state/active.agent-os-hub.service" ]] && echo present || echo absent)" \
    "$([[ -f "$migration_forward_off_failure_state/enabled.agent-os-hub.service" ]] && echo present || echo absent)"
  printf 'focused-migration-fsync-stderr %q\n' \
    "$migration_forward_off_failure_error_tail"
  tail -n 16 "$migration_fsync_trace" | sed 's/^/focused-migration-fsync-trace /'
  if [[ "$migration_forward_off_failure_status" == 0 ]]; then
    fail 'forward migration accepted maintenance-off runtime fsync failure'
  fi
  [[ ! -e "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE" && \
    "$(tail -n 1 "$migration_forward_off_failure_error")" == \
      'Hub deployment failed: maintenance runtime cleanup durability failed' && \
    -f "$migration_forward_off_failure_journal/committed" && \
    ! -e "$migration_forward_off_failure_journal/finalized" && \
    -f "$migration_forward_off_failure_root/var/lib/agent-os-ops/hub-block" && \
    "$(<"$migration_forward_off_failure_root/var/lib/agent-os-ops/hub-block")" == \
      "agent-os-hub-recovery-block-v1:$migration_forward_off_failure_transaction" && \
    ! -e "$migration_forward_off_failure_root/run/agent-os/hub-maintenance" && \
    -f "$migration_forward_off_failure_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$migration_forward_off_failure_root/run/agent-os/hub-recovery-start" && \
    ! -e "$migration_forward_off_failure_state/active.agent-os-hub.service" && \
    ! -e "$migration_forward_off_failure_state/enabled.agent-os-hub.service" ]] ||
    fail 'maintenance-off runtime fsync failure was not exact and resumable'
  grep -Eq \
    'class=runtime-root marker_armed=true token=false normal=false hard=false block=true$' \
    "$migration_fsync_trace" ||
    fail 'maintenance-off runtime fsync did not reach the exact post-unlink topology'
  run_admin_migration \
    "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
    "$migration_forward_off_failure_state" "$migration_forward_off_failure_digest" \
    >/dev/null || fail 'maintenance-off runtime fsync failure did not converge'
  assert_migration_forward_completed \
    'maintenance-off runtime fsync retry' \
    "$migration_forward_off_failure_root" "$migration_forward_off_failure_state"
  printf '%s\n' 'hub deploy focused gate: PASS migration-forward-maintenance-off-fsync'
  exit 0
fi

if [[ "$VERIFY_FOCUS" == migration-rollback-maintenance-off-fsync ]]; then
  migration_rollback_focus_root="$temporary/migration-rollback-maintenance-off-focus-root"
  migration_rollback_focus_state="$temporary/migration-rollback-maintenance-off-focus-state"
  migration_rollback_focus_nonce=migrationrollbackmaintenanceofffocusnonce00000001
  create_legacy_migration_fixture \
    "$migration_rollback_focus_root" "$migration_rollback_focus_nonce" \
    "$migration_rollback_focus_state"
  migration_rollback_focus_digest=$LEGACY_MIGRATION_DIGEST
  migration_rollback_focus_transaction="$(fresh_admin_migration_transaction \
    "$migration_rollback_focus_digest")"
  migration_rollback_focus_journal="$migration_rollback_focus_root/var/lib/agent-os-ops/private/$migration_rollback_focus_transaction"
  expect_admin_migration_sigkill \
    'focused rollback maintenance-off failure seed' phase-dir:daemon_reloaded \
    "$migration_rollback_focus_root" "$migration_rollback_focus_nonce" \
    "$migration_rollback_focus_state" "$migration_rollback_focus_digest"
  printf '%s\n' "$migration_rollback_focus_root/run/agent-os" \
    >"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
  migration_rollback_focus_error="$temporary/migration-rollback-maintenance-off-focus.err"
  if run_admin_migration \
    "$migration_rollback_focus_root" "$migration_rollback_focus_nonce" \
    "$migration_rollback_focus_state" "$migration_rollback_focus_digest" \
    --rollback >/dev/null 2>"$migration_rollback_focus_error"; then
    fail 'rollback accepted focused maintenance-off runtime fsync failure'
  fi
  [[ ! -e "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE" && \
    "$(tail -n 1 "$migration_rollback_focus_error")" == \
      'Hub deployment failed: maintenance runtime cleanup durability failed' && \
    -f "$migration_rollback_focus_journal/rolled_back" && \
    ! -e "$migration_rollback_focus_journal/finalized" && \
    -f "$migration_rollback_focus_root/var/lib/agent-os-ops/hub-block" && \
    ! -L "$migration_rollback_focus_root/var/lib/agent-os-ops/hub-block" && \
    "$(<"$migration_rollback_focus_root/var/lib/agent-os-ops/hub-block")" == \
      "agent-os-hub-recovery-block-v1:$migration_rollback_focus_transaction" && \
    ! -e "$migration_rollback_focus_root/run/agent-os/hub-maintenance" && \
    -f "$migration_rollback_focus_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$migration_rollback_focus_state/active.agent-os-hub.service" && \
    ! -e "$migration_rollback_focus_state/enabled.agent-os-hub.service" ]] ||
    fail 'focused rollback maintenance-off failure was not exact and resumable'
  run_admin_migration \
    "$migration_rollback_focus_root" "$migration_rollback_focus_nonce" \
    "$migration_rollback_focus_state" "$migration_rollback_focus_digest" \
    --rollback >/dev/null ||
    fail 'focused rollback maintenance-off failure did not converge'
  assert_rollback_migration_completed \
    'focused rollback maintenance-off retry' \
    "$migration_rollback_focus_root" "$migration_rollback_focus_state" \
    "$migration_rollback_focus_transaction"
  printf '%s\n' \
    'hub deploy focused gate: PASS migration-rollback-maintenance-off-fsync'
  exit 0
fi

# A fixed-name v1 intent staging directory can be left by the earliest
# migration bootstrap after publishing its exact intent but before moving the
# journal root. The pre-lock selector and locked recovery must choose and adopt
# that transaction rather than inventing a conflicting v2 attempt-one journal.
migration_legacy_staging_root="$temporary/migration-legacy-staging-root"
migration_legacy_staging_state="$temporary/migration-legacy-staging-state"
migration_legacy_staging_nonce=migrationlegacystagingnonce00000000000001
create_legacy_migration_fixture \
  "$migration_legacy_staging_root" "$migration_legacy_staging_nonce" \
  "$migration_legacy_staging_state"
migration_legacy_staging_digest=$LEGACY_MIGRATION_DIGEST
write_valid_admin_migration_intent_artifact \
  "$migration_legacy_staging_root" "$migration_legacy_staging_digest" staging
migration_legacy_staging_transaction="upgrade-admin-migration-${migration_legacy_staging_digest:0:32}"
migration_legacy_staging_recovery="$migration_legacy_staging_root/var/lib/agent-os-ops/private"
migration_legacy_staging_final="$migration_legacy_staging_recovery/$migration_legacy_staging_transaction"
run_admin_migration \
  "$migration_legacy_staging_root" "$migration_legacy_staging_nonce" \
  "$migration_legacy_staging_state" "$migration_legacy_staging_digest" \
  >/dev/null || fail 'published v1 migration intent staging was not recoverable'
[[ -f "$migration_legacy_staging_final/intent" && \
  "$(<"$migration_legacy_staging_final/intent")" == \
    $'version=1\ntransaction='"$migration_legacy_staging_transaction"$'\nold_admin_sha256='"$migration_legacy_staging_digest" && \
  -z "$(find "$migration_legacy_staging_recovery" -maxdepth 1 \
    -name '.upgrade-admin-migration-*.tmp' -print -quit)" && \
  ! -e "$migration_legacy_staging_recovery/$(fresh_admin_migration_transaction \
    "$migration_legacy_staging_digest")" ]] ||
  fail 'v1 migration staging adoption created an ambiguous journal history'
assert_migration_forward_completed \
  'v1 migration staging adoption' "$migration_legacy_staging_root" \
  "$migration_legacy_staging_state"

migration_disable_proof_root="$temporary/migration-disable-proof-root"
migration_disable_proof_state="$temporary/migration-disable-proof-state"
migration_disable_proof_nonce=migrationdisableproofnonce000000000000001
create_legacy_migration_fixture \
  "$migration_disable_proof_root" "$migration_disable_proof_nonce" \
  "$migration_disable_proof_state"
migration_disable_proof_digest=$LEGACY_MIGRATION_DIGEST
migration_disable_proof_transaction="$(fresh_admin_migration_transaction \
  "$migration_disable_proof_digest")"
migration_disable_proof_journal="$migration_disable_proof_root/var/lib/agent-os-ops/private/$migration_disable_proof_transaction"
migration_disable_proof_state_before="$(migration_state_contract_fingerprint \
  "$migration_disable_proof_root/var/lib/agent-os/hub")"
: >"$AGENT_OS_MOCK_IS_ENABLED_NOT_FOUND_ONCE"
migration_disable_proof_error="$temporary/migration-disable-proof.err"
if run_admin_migration \
  "$migration_disable_proof_root" "$migration_disable_proof_nonce" \
  "$migration_disable_proof_state" "$migration_disable_proof_digest" \
  >/dev/null 2>"$migration_disable_proof_error"; then
  fail 'admin migration accepted systemd is-enabled exit 4 as strict disable proof'
fi
[[ ! -e "$AGENT_OS_MOCK_IS_ENABLED_NOT_FOUND_ONCE" && \
  "$(<"$migration_disable_proof_error")" == \
    'Hub deployment failed: Hub service disable state could not be proved during admin migration' && \
  -f "$migration_disable_proof_journal/intent" && \
  ! -e "$migration_disable_proof_journal/disabled" && \
  ! -e "$migration_disable_proof_root/var/lib/agent-os-ops/hub-block" && \
  ! -e "$migration_disable_proof_root/run/agent-os/hub-maintenance" && \
  ! -e "$migration_disable_proof_root/run/agent-os/hub-maintenance-hard" && \
  -f "$migration_disable_proof_state/active.agent-os-hub.service" && \
  ! -f "$migration_disable_proof_state/enabled.agent-os-hub.service" && \
  "$(migration_state_contract_fingerprint \
    "$migration_disable_proof_root/var/lib/agent-os/hub")" == \
    "$migration_disable_proof_state_before" ]] ||
  fail 'strict disable-proof rejection mutated data or published disabled/blocked state'
assert_migration_runtime_set "$migration_disable_proof_root" "$legacy_admin_source" ||
  fail 'strict disable-proof rejection changed installed runtime files'
run_admin_migration \
  "$migration_disable_proof_root" "$migration_disable_proof_nonce" \
  "$migration_disable_proof_state" "$migration_disable_proof_digest" \
  >/dev/null || fail 'strict disable-proof rejection was not retryable'
assert_migration_forward_completed \
  'strict disable-proof retry' "$migration_disable_proof_root" \
  "$migration_disable_proof_state"

# The migration wrapper must resolve the dedicated service account rather than
# silently scanning for the invoking administrator. Keep one residual process
# after the mocked stop and prove both UID and cgroup wiring fail before any
# payload, admin-kit or live-runtime publication.
for migration_residual_kind in service-uid forbidden-cgroup; do
  migration_residual_root="$temporary/migration-residual-$migration_residual_kind-root"
  migration_residual_state="$temporary/migration-residual-$migration_residual_kind-state"
  migration_residual_nonce="migrationresidual${migration_residual_kind//-/}nonce00000000001"
  create_legacy_migration_fixture \
    "$migration_residual_root" "$migration_residual_nonce" \
    "$migration_residual_state"
  migration_residual_digest=$LEGACY_MIGRATION_DIGEST
  migration_residual_transaction="$(fresh_admin_migration_transaction \
    "$migration_residual_digest")"
  migration_residual_journal="$migration_residual_root/var/lib/agent-os-ops/private/$migration_residual_transaction"
  migration_residual_admin_before="$(migration_fixture_fingerprint \
    "$migration_residual_root/usr/libexec/agent-os/hub")"
  migration_residual_runtime_before="$(migration_fixture_fingerprint \
    "$migration_residual_root/etc")"
  if [[ "$migration_residual_kind" == service-uid ]]; then
    migration_residual_uid=$migration_service_uid
    migration_residual_cgroup=/system.slice/unrelated-residual.service
    migration_residual_expected='Hub state observable-reference gate failed: service uid process detected'
  else
    migration_residual_uid=0
    migration_residual_cgroup=/system.slice/agent-os-hub.service
    migration_residual_expected='Hub state observable-reference gate failed: forbidden cgroup member detected'
  fi
  write_migration_proc_process \
    "$migration_residual_root" 417302 "$migration_residual_uid" \
    "$migration_residual_cgroup"
  migration_residual_error="$temporary/migration-residual-$migration_residual_kind.err"
  if run_admin_migration \
    "$migration_residual_root" "$migration_residual_nonce" \
    "$migration_residual_state" "$migration_residual_digest" \
    >/dev/null 2>"$migration_residual_error"; then
    fail "admin migration accepted a residual $migration_residual_kind process"
  fi
  [[ "$(head -n 1 "$migration_residual_error")" == "$migration_residual_expected" && \
    "$(tail -n 1 "$migration_residual_error")" == \
      'Hub deployment failed: admin migration could not prove the legacy writer stopped' && \
    -f "$migration_residual_state/open-files-reached" && \
    "$(<"$migration_residual_state/open-files-reached")" == migration-writer-stop && \
    -f "$migration_residual_journal/disabled" && \
    -f "$migration_residual_journal/blocked" && \
    ! -e "$migration_residual_journal/stopped" && \
    ! -e "$migration_residual_journal/prepared" && \
    "$(migration_fixture_fingerprint \
      "$migration_residual_root/usr/libexec/agent-os/hub")" == \
      "$migration_residual_admin_before" && \
    "$(migration_fixture_fingerprint "$migration_residual_root/etc")" == \
      "$migration_residual_runtime_before" && \
    -f "$migration_residual_root/var/lib/agent-os-ops/hub-block" && \
    ! -f "$migration_residual_state/active.agent-os-hub.service" && \
    ! -f "$migration_residual_state/enabled.agent-os-hub.service" ]] ||
    fail "residual $migration_residual_kind rejection did not reach the exact observable-reference boundary"
done

# Intent is audit-only. Crashes while writing its private 0400 entry, after the
# entry rename, or after the staging-root rename must leave the legacy service
# active+enabled and every state/admin/runtime/pointer byte unchanged. Recovery
# adopts at most one exact published intent and then proceeds normally.
for migration_intent_boundary in temp stage-dir final-root; do
  migration_intent_label="intent-$migration_intent_boundary"
  migration_intent_root="$temporary/migration-$migration_intent_label-root"
  migration_intent_state="$temporary/migration-$migration_intent_label-state"
  migration_intent_nonce="migrationintent${migration_intent_boundary//-/}nonce0000000000000001"
  create_legacy_migration_fixture \
    "$migration_intent_root" "$migration_intent_nonce" \
    "$migration_intent_state"
  migration_intent_digest=$LEGACY_MIGRATION_DIGEST
  migration_intent_transaction="$(fresh_admin_migration_transaction \
    "$migration_intent_digest")"
  migration_intent_recovery="$migration_intent_root/var/lib/agent-os-ops/private"
  migration_intent_final="$migration_intent_recovery/$migration_intent_transaction"
  migration_intent_state_before="$(migration_state_contract_fingerprint \
    "$migration_intent_root/var/lib/agent-os/hub")" ||
    fail "$migration_intent_label could not fingerprint state"
  migration_intent_admin_before="$($REAL_NODE_BIN \
    "$HUB_ROOT/bin/tree-digest.mjs" --canonical-root-owner \
    "$migration_intent_root/usr/libexec/agent-os/hub")"
  migration_intent_runtime_before="$(migration_fixture_fingerprint \
    "$migration_intent_root/etc")"
  migration_intent_current_before="$(readlink \
    "$migration_intent_root/opt/agent-os/current")"
  migration_intent_previous_before="$(readlink \
    "$migration_intent_root/opt/agent-os/previous")"
  expect_admin_migration_sigkill \
    "$migration_intent_label" "$migration_intent_label" \
    "$migration_intent_root" "$migration_intent_nonce" \
    "$migration_intent_state" "$migration_intent_digest"
  [[ -f "$migration_intent_state/active.agent-os-hub.service" && \
    -f "$migration_intent_state/enabled.agent-os-hub.service" && \
    ! -e "$migration_intent_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$migration_intent_root/run/agent-os/hub-maintenance" && \
    ! -e "$migration_intent_root/run/agent-os/hub-maintenance-hard" && \
    "$(migration_state_contract_fingerprint \
      "$migration_intent_root/var/lib/agent-os/hub")" == \
      "$migration_intent_state_before" && \
    "$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
      --canonical-root-owner \
      "$migration_intent_root/usr/libexec/agent-os/hub")" == \
      "$migration_intent_admin_before" && \
    "$(migration_fixture_fingerprint "$migration_intent_root/etc")" == \
      "$migration_intent_runtime_before" && \
    "$(readlink "$migration_intent_root/opt/agent-os/current")" == \
      "$migration_intent_current_before" && \
    "$(readlink "$migration_intent_root/opt/agent-os/previous")" == \
      "$migration_intent_previous_before" ]] ||
    fail "$migration_intent_label mutated runtime state before disable"
  case "$migration_intent_boundary" in
    temp)
      [[ ! -e "$migration_intent_final" ]] ||
        fail 'intent temp crash published a final journal root'
      shopt -s nullglob
      migration_intent_staging=(
        "$migration_intent_recovery"/."$migration_intent_transaction"-*.tmp
      )
      shopt -u nullglob
      [[ "${#migration_intent_staging[@]}" == 1 ]] ||
        fail 'intent temp crash did not retain exactly one staging root'
      shopt -s nullglob
      migration_intent_temporaries=(
        "${migration_intent_staging[0]}"/.intent-*.tmp
      )
      shopt -u nullglob
      [[ "${#migration_intent_temporaries[@]}" == 1 && \
        ! -e "${migration_intent_staging[0]}/intent" && \
        "$(stat -c '%a' "${migration_intent_temporaries[0]}" 2>/dev/null || \
          stat -f '%Lp' "${migration_intent_temporaries[0]}")" == 400 ]] ||
        fail 'intent temp crash retained an unsafe temporary topology'
      ;;
    stage-dir)
      [[ ! -e "$migration_intent_final" ]] ||
        fail 'intent stage-dir crash published a final journal root'
      shopt -s nullglob
      migration_intent_staging=(
        "$migration_intent_recovery"/."$migration_intent_transaction"-*.tmp
      )
      shopt -u nullglob
      [[ "${#migration_intent_staging[@]}" == 1 && \
        -f "${migration_intent_staging[0]}/intent" ]] ||
        fail 'intent stage-dir crash did not retain one published staging intent'
      ;;
    final-root)
      [[ -f "$migration_intent_final/intent" && \
        -z "$(find "$migration_intent_recovery" -maxdepth 1 \
          -name ".${migration_intent_transaction}-*.tmp" -print -quit)" ]] ||
        fail 'intent final-root crash retained an ambiguous journal topology'
      expect_admin_migration_sigkill \
        'intent final-root parent redurability' intent-final-root \
        "$migration_intent_root" "$migration_intent_nonce" \
        "$migration_intent_state" "$migration_intent_digest"
      [[ -f "$migration_intent_final/intent" && \
        ! -e "$migration_intent_final/disabled" && \
        -f "$migration_intent_state/active.agent-os-hub.service" && \
        -f "$migration_intent_state/enabled.agent-os-hub.service" ]] ||
        fail 'intent final-root retry advanced before re-fsyncing its parent namespace'
      ;;
  esac
  run_admin_migration \
    "$migration_intent_root" "$migration_intent_nonce" \
    "$migration_intent_state" "$migration_intent_digest" >/dev/null ||
    fail "$migration_intent_label did not converge on same-action retry"
  assert_migration_forward_completed \
    "$migration_intent_label" "$migration_intent_root" \
    "$migration_intent_state"
  assert_migration_attempt_intent \
    "$migration_intent_final" "$migration_intent_transaction" 1 \
    none none "$migration_intent_digest"
done

# Unpublished empty or partial intent staging is safe to discard. It must
# never be adopted as the unique journal, and retry must leave no staging root.
for migration_unpublished_kind in empty partial; do
  migration_unpublished_root="$temporary/migration-intent-unpublished-$migration_unpublished_kind-root"
  migration_unpublished_state="$temporary/migration-intent-unpublished-$migration_unpublished_kind-state"
  migration_unpublished_nonce="migrationintentunpublished${migration_unpublished_kind}nonce000000001"
  create_legacy_migration_fixture \
    "$migration_unpublished_root" "$migration_unpublished_nonce" \
    "$migration_unpublished_state"
  migration_unpublished_digest=$LEGACY_MIGRATION_DIGEST
  migration_unpublished_transaction="$(fresh_admin_migration_transaction \
    "$migration_unpublished_digest")"
  migration_unpublished_recovery="$migration_unpublished_root/var/lib/agent-os-ops/private"
  migration_unpublished_staging="$migration_unpublished_recovery/.${migration_unpublished_transaction}-123-456.tmp"
  install -d -m 0755 "$migration_unpublished_root/var/lib/agent-os-ops"
  install -d -m 0700 "$migration_unpublished_recovery"
  install -d -m 0700 "$migration_unpublished_staging"
  if [[ "$migration_unpublished_kind" == partial ]]; then
    printf '%s' partial >"$migration_unpublished_staging/.intent-123-456.tmp"
    chmod 0400 "$migration_unpublished_staging/.intent-123-456.tmp"
  fi
  run_admin_migration \
    "$migration_unpublished_root" "$migration_unpublished_nonce" \
    "$migration_unpublished_state" "$migration_unpublished_digest" >/dev/null ||
    fail "unpublished $migration_unpublished_kind intent staging did not recover"
  [[ ! -e "$migration_unpublished_staging" ]] ||
    fail "unpublished $migration_unpublished_kind intent staging was retained"
  assert_migration_forward_completed \
    "unpublished $migration_unpublished_kind intent" \
    "$migration_unpublished_root" "$migration_unpublished_state"
done

# Both public preflight passes are read-only; the second, lock-held scan is the
# authority. Inject a history gap and an intent mutation from the flock mock to
# prove recovery rescans after lock acquisition and rejects before service or
# installation mutation.
for migration_locked_rescan_case in gap tampered-intent; do
  migration_locked_rescan_root="$temporary/migration-locked-rescan-$migration_locked_rescan_case-root"
  migration_locked_rescan_state="$temporary/migration-locked-rescan-$migration_locked_rescan_case-state"
  migration_locked_rescan_nonce="migrationlockedrescan${migration_locked_rescan_case//-/}nonce00000001"
  create_legacy_migration_fixture \
    "$migration_locked_rescan_root" "$migration_locked_rescan_nonce" \
    "$migration_locked_rescan_state"
  migration_locked_rescan_digest=$LEGACY_MIGRATION_DIGEST
  migration_locked_rescan_transaction="$(fresh_admin_migration_transaction \
    "$migration_locked_rescan_digest")"
  migration_locked_rescan_journal="$migration_locked_rescan_root/var/lib/agent-os-ops/private/$migration_locked_rescan_transaction"
  if [[ "$migration_locked_rescan_case" == tampered-intent ]]; then
    expect_admin_migration_sigkill \
      'locked rescan intent seed' intent-final-root \
      "$migration_locked_rescan_root" "$migration_locked_rescan_nonce" \
      "$migration_locked_rescan_state" "$migration_locked_rescan_digest"
    export AGENT_OS_MOCK_MIGRATION_TAMPER_AFTER_PREFLIGHT_ONCE="$temporary/migration-locked-rescan-tamper-once"
    export AGENT_OS_MOCK_MIGRATION_TAMPER_INTENT="$migration_locked_rescan_journal/intent"
    export AGENT_OS_MOCK_MIGRATION_TAMPER_REACHED="$temporary/migration-locked-rescan-tamper-reached"
    : >"$AGENT_OS_MOCK_MIGRATION_TAMPER_AFTER_PREFLIGHT_ONCE"
    migration_locked_rescan_expected='Hub deployment failed: admin migration history journal is invalid'
  else
    export AGENT_OS_MOCK_MIGRATION_GAP_AFTER_PREFLIGHT_ONCE="$temporary/migration-locked-rescan-gap-once"
    : >"$AGENT_OS_MOCK_MIGRATION_GAP_AFTER_PREFLIGHT_ONCE"
    migration_locked_rescan_expected='Hub deployment failed: admin migration history contains an attempt gap'
  fi
  migration_locked_rescan_admin_before="$(migration_fixture_fingerprint \
    "$migration_locked_rescan_root/usr/libexec/agent-os")"
  migration_locked_rescan_runtime_before="$(migration_fixture_fingerprint \
    "$migration_locked_rescan_root/etc")"
  migration_locked_rescan_state_before="$(migration_state_contract_fingerprint \
    "$migration_locked_rescan_root/var/lib/agent-os/hub")"
  migration_locked_rescan_pointers_before="$(migration_fixture_fingerprint \
    "$migration_locked_rescan_root/opt")"
  migration_locked_rescan_log_before="$(wc -l \
    <"$migration_locked_rescan_state/systemctl.log" | tr -d ' ')"
  migration_locked_rescan_error="$temporary/migration-locked-rescan-$migration_locked_rescan_case.err"
  if run_admin_migration \
    "$migration_locked_rescan_root" "$migration_locked_rescan_nonce" \
    "$migration_locked_rescan_state" "$migration_locked_rescan_digest" \
    >/dev/null 2>"$migration_locked_rescan_error"; then
    fail "locked rescan accepted $migration_locked_rescan_case history drift"
  fi
  unset \
    AGENT_OS_MOCK_MIGRATION_GAP_AFTER_PREFLIGHT_ONCE \
    AGENT_OS_MOCK_MIGRATION_TAMPER_AFTER_PREFLIGHT_ONCE \
    AGENT_OS_MOCK_MIGRATION_TAMPER_INTENT \
    AGENT_OS_MOCK_MIGRATION_TAMPER_REACHED
  if [[ "$migration_locked_rescan_case" == tampered-intent ]]; then
    [[ -f "$temporary/migration-locked-rescan-tamper-reached" && \
      "$(<"$temporary/migration-locked-rescan-tamper-reached")" == reached ]] ||
      fail 'locked tampered-intent injection did not reach the target boundary'
  fi
  migration_locked_rescan_actual="$(tail -n 1 "$migration_locked_rescan_error")"
  [[ "$migration_locked_rescan_actual" == \
    "$migration_locked_rescan_expected" ]] ||
    fail "locked $migration_locked_rescan_case rescan rejection changed: $migration_locked_rescan_actual"
  [[ "$(migration_fixture_fingerprint \
    "$migration_locked_rescan_root/usr/libexec/agent-os")" == \
    "$migration_locked_rescan_admin_before" ]] ||
    fail "locked $migration_locked_rescan_case rescan changed the admin kit"
  [[ "$(migration_fixture_fingerprint "$migration_locked_rescan_root/etc")" == \
    "$migration_locked_rescan_runtime_before" ]] ||
    fail "locked $migration_locked_rescan_case rescan changed installed runtime"
  [[ "$(migration_state_contract_fingerprint \
    "$migration_locked_rescan_root/var/lib/agent-os/hub")" == \
    "$migration_locked_rescan_state_before" ]] ||
    fail "locked $migration_locked_rescan_case rescan changed Hub state"
  [[ "$(migration_fixture_fingerprint "$migration_locked_rescan_root/opt")" == \
    "$migration_locked_rescan_pointers_before" ]] ||
    fail "locked $migration_locked_rescan_case rescan changed release pointers"
  [[ ! -e "$migration_locked_rescan_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$migration_locked_rescan_root/run/agent-os/hub-maintenance" && \
    ! -e "$migration_locked_rescan_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "locked $migration_locked_rescan_case rescan published a migration guard"
  assert_no_service_mutation_since \
    "locked $migration_locked_rescan_case rescan" \
    "$migration_locked_rescan_state" "$migration_locked_rescan_log_before"
done

# `disabled` is the first reboot-safe mutation after the audit-only intent.
# A crash at either journal-publication boundary may leave the old process
# running until reboot, but auto-start is already disabled and no ingress/state
# or admin/runtime payload has changed. A simulated reboot plus same-action
# retry must converge through the later persistent block.
assert_migration_runtime_root_entries() {
  local label=$1 root=$2 maintenance_expected=$3 runtime lock
  local mode uid gid links
  local -a entries=()
  runtime="$root/run/agent-os"
  lock="$runtime/hub-deploy.lock"
  [[ -d "$runtime" && ! -L "$runtime" ]] ||
    fail "$label runtime root is missing or unsafe"
  [[ -f "$lock" && ! -L "$lock" ]] ||
    fail "$label deployment lock is missing or unsafe"
  mode="$(stat -c '%a' "$runtime" 2>/dev/null || stat -f '%Lp' "$runtime")"
  uid="$(stat -c '%u' "$runtime" 2>/dev/null || stat -f '%u' "$runtime")"
  gid="$(stat -c '%g' "$runtime" 2>/dev/null || stat -f '%g' "$runtime")"
  links="$(stat -c '%h' "$lock" 2>/dev/null || stat -f '%l' "$lock")"
  [[ "$mode" == 755 && "$uid" == "$EUID" && \
    "$gid" == "$migration_caller_gid" && \
    "$(stat -c '%a' "$lock" 2>/dev/null || stat -f '%Lp' "$lock")" == 600 && \
    "$(stat -c '%u' "$lock" 2>/dev/null || stat -f '%u' "$lock")" == "$EUID" && \
    "$(stat -c '%g' "$lock" 2>/dev/null || stat -f '%g' "$lock")" == \
      "$migration_caller_gid" && "$links" == 1 ]] ||
    fail "$label runtime root or deployment lock contract is unsafe"
  shopt -s nullglob dotglob
  entries=("$runtime"/*)
  shopt -u nullglob dotglob
  if [[ "$maintenance_expected" == true ]]; then
    [[ "${#entries[@]}" == 2 && \
      -f "$runtime/hub-maintenance" && \
      ! -L "$runtime/hub-maintenance" && \
      "$(stat -c '%a' "$runtime/hub-maintenance" 2>/dev/null || \
        stat -f '%Lp' "$runtime/hub-maintenance")" == 444 && \
      "$(stat -c '%u' "$runtime/hub-maintenance" 2>/dev/null || \
        stat -f '%u' "$runtime/hub-maintenance")" == "$EUID" && \
      "$(stat -c '%g' "$runtime/hub-maintenance" 2>/dev/null || \
        stat -f '%g' "$runtime/hub-maintenance")" == "$migration_caller_gid" && \
      "$(stat -c '%h' "$runtime/hub-maintenance" 2>/dev/null || \
        stat -f '%l' "$runtime/hub-maintenance")" == 1 ]] ||
      fail "$label runtime root contains anything except its owned lock and normal sentinel"
  else
    [[ "${#entries[@]}" == 1 && "${entries[0]}" == "$lock" ]] ||
      fail "$label runtime root contains anything except its owned lock"
  fi
}

for migration_disabled_boundary in temp dir; do
  migration_disabled_label="disabled-$migration_disabled_boundary"
  migration_disabled_root="$temporary/migration-$migration_disabled_label-root"
  migration_disabled_state="$temporary/migration-$migration_disabled_label-state"
  migration_disabled_nonce="migrationdisabled${migration_disabled_boundary}nonce0000000000000001"
  create_legacy_migration_fixture \
    "$migration_disabled_root" "$migration_disabled_nonce" \
    "$migration_disabled_state"
  migration_disabled_digest=$LEGACY_MIGRATION_DIGEST
  migration_disabled_transaction="$(fresh_admin_migration_transaction \
    "$migration_disabled_digest")"
  migration_disabled_journal="$migration_disabled_root/var/lib/agent-os-ops/private/$migration_disabled_transaction"
  migration_disabled_state_before="$(migration_state_contract_fingerprint \
    "$migration_disabled_root/var/lib/agent-os/hub")" ||
    fail "$migration_disabled_label could not fingerprint state"
  migration_disabled_current_before="$(readlink \
    "$migration_disabled_root/opt/agent-os/current")"
  migration_disabled_previous_before="$(readlink \
    "$migration_disabled_root/opt/agent-os/previous")"
  expect_admin_migration_sigkill \
    "$migration_disabled_label" \
    "phase-$migration_disabled_boundary:disabled" \
    "$migration_disabled_root" "$migration_disabled_nonce" \
    "$migration_disabled_state" "$migration_disabled_digest"
  [[ -f "$migration_disabled_state/active.agent-os-hub.service" && \
    ! -f "$migration_disabled_state/enabled.agent-os-hub.service" && \
    ! -e "$migration_disabled_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$migration_disabled_root/run/agent-os/hub-maintenance" && \
    ! -e "$migration_disabled_root/run/agent-os/hub-maintenance-hard" && \
    "$(migration_state_contract_fingerprint \
      "$migration_disabled_root/var/lib/agent-os/hub")" == \
      "$migration_disabled_state_before" && \
    "$(readlink "$migration_disabled_root/opt/agent-os/current")" == \
      "$migration_disabled_current_before" && \
    "$(readlink "$migration_disabled_root/opt/agent-os/previous")" == \
      "$migration_disabled_previous_before" ]] ||
    fail "$migration_disabled_label changed state/pointers or published a guard before disabled durability"
  assert_migration_runtime_set "$migration_disabled_root" "$legacy_admin_source" ||
    fail "$migration_disabled_label changed the installed runtime"
  if [[ "$migration_disabled_boundary" == temp ]]; then
    shopt -s nullglob
    migration_disabled_temporaries=(
      "$migration_disabled_journal"/.disabled-*.tmp
    )
    shopt -u nullglob
    [[ "${#migration_disabled_temporaries[@]}" == 1 && \
      ! -e "$migration_disabled_journal/disabled" && \
      -f "${migration_disabled_temporaries[0]}" && \
      "$(stat -c '%a' "${migration_disabled_temporaries[0]}" 2>/dev/null || \
        stat -f '%Lp' "${migration_disabled_temporaries[0]}")" == 400 && \
      "$(<"${migration_disabled_temporaries[0]}")" == \
        $'version=1\n'"transaction=$migration_disabled_transaction"$'\nphase=disabled' ]] ||
      fail "$migration_disabled_label left an unsafe disabled temporary"
  else
    assert_migration_phase \
      "$migration_disabled_journal" "$migration_disabled_transaction" disabled
  fi
  # `/run`, proc and the transient cgroup topology are cleared at reboot. The
  # durable systemd enablement state must still prevent an automatic writer.
  assert_migration_runtime_root_entries \
    "$migration_disabled_label before reboot" "$migration_disabled_root" false
  rm -f -- "$migration_disabled_state/active.agent-os-hub.service"
  rm -rf -- "$migration_disabled_root/run/agent-os"
  rm -rf -- \
    "$migration_disabled_root/proc/417300" \
    "$migration_disabled_root/process-context/417300"
  printf 'populated 0\nfrozen 0\n' \
    >"$migration_disabled_root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
  if AGENT_OS_MOCK_STATE="$migration_disabled_state" \
    AGENT_OS_MOCK_SYSTEMCTL_LOG="$migration_disabled_state/systemctl.log" \
    "$systemctl_mock" is-enabled --quiet agent-os-hub.service; then
    fail "$migration_disabled_label would auto-start the writer after reboot"
  fi
  run_admin_migration \
    "$migration_disabled_root" "$migration_disabled_nonce" \
    "$migration_disabled_state" "$migration_disabled_digest" >/dev/null ||
    fail "$migration_disabled_label did not converge after simulated reboot"
  assert_migration_forward_completed \
    "$migration_disabled_label" "$migration_disabled_root" \
    "$migration_disabled_state"
  assert_migration_runtime_root_entries \
    "$migration_disabled_label after reboot recovery" \
    "$migration_disabled_root" false
done

for migration_blocked_boundary in temp dir; do
  migration_blocked_label="blocked-$migration_blocked_boundary"
  migration_blocked_root="$temporary/migration-$migration_blocked_label-root"
  migration_blocked_state="$temporary/migration-$migration_blocked_label-state"
  migration_blocked_nonce="migrationblocked${migration_blocked_boundary}nonce0000000000000001"
  create_legacy_migration_fixture \
    "$migration_blocked_root" "$migration_blocked_nonce" \
    "$migration_blocked_state"
  migration_blocked_digest=$LEGACY_MIGRATION_DIGEST
  migration_blocked_transaction="$(fresh_admin_migration_transaction \
    "$migration_blocked_digest")"
  migration_blocked_journal="$migration_blocked_root/var/lib/agent-os-ops/private/$migration_blocked_transaction"
  migration_blocked_state_before="$(migration_state_contract_fingerprint \
    "$migration_blocked_root/var/lib/agent-os/hub")"
  expect_admin_migration_sigkill \
    "$migration_blocked_label" \
    "phase-$migration_blocked_boundary:blocked" \
    "$migration_blocked_root" "$migration_blocked_nonce" \
    "$migration_blocked_state" "$migration_blocked_digest"
  [[ -f "$migration_blocked_state/active.agent-os-hub.service" && \
    ! -f "$migration_blocked_state/enabled.agent-os-hub.service" && \
    -f "$migration_blocked_root/var/lib/agent-os-ops/hub-block" && \
    "$(<"$migration_blocked_root/var/lib/agent-os-ops/hub-block")" == \
      "agent-os-hub-recovery-block-v1:$migration_blocked_transaction" && \
    -f "$migration_blocked_root/run/agent-os/hub-maintenance" && \
    ! -e "$migration_blocked_root/run/agent-os/hub-maintenance-hard" && \
    "$(migration_state_contract_fingerprint \
      "$migration_blocked_root/var/lib/agent-os/hub")" == \
      "$migration_blocked_state_before" ]] ||
    fail "$migration_blocked_label did not retain disabled+blocked pre-stop topology"
  if [[ "$migration_blocked_boundary" == temp ]]; then
    shopt -s nullglob
    migration_blocked_temporaries=(
      "$migration_blocked_journal"/.blocked-*.tmp
    )
    shopt -u nullglob
    [[ "${#migration_blocked_temporaries[@]}" == 1 && \
      ! -e "$migration_blocked_journal/blocked" ]] ||
      fail "$migration_blocked_label did not retain one private blocked temporary"
  else
    assert_migration_phase \
      "$migration_blocked_journal" "$migration_blocked_transaction" blocked
  fi
  assert_migration_runtime_root_entries \
    "$migration_blocked_label before reboot" "$migration_blocked_root" true
  rm -f -- "$migration_blocked_state/active.agent-os-hub.service"
  rm -rf -- "$migration_blocked_root/run/agent-os"
  rm -rf -- \
    "$migration_blocked_root/proc/417300" \
    "$migration_blocked_root/process-context/417300"
  printf 'populated 0\nfrozen 0\n' \
    >"$migration_blocked_root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
  if AGENT_OS_MOCK_STATE="$migration_blocked_state" \
    AGENT_OS_MOCK_SYSTEMCTL_LOG="$migration_blocked_state/systemctl.log" \
    "$systemctl_mock" is-enabled --quiet agent-os-hub.service; then
    fail "$migration_blocked_label would auto-start after /run was cleared"
  fi
  [[ -f "$migration_blocked_root/var/lib/agent-os-ops/hub-block" ]] ||
    fail "$migration_blocked_label lost its persistent block across simulated reboot"
  run_admin_migration \
    "$migration_blocked_root" "$migration_blocked_nonce" \
    "$migration_blocked_state" "$migration_blocked_digest" >/dev/null ||
    fail "$migration_blocked_label did not converge after simulated reboot"
  assert_migration_forward_completed \
    "$migration_blocked_label" "$migration_blocked_root" \
    "$migration_blocked_state"
  assert_migration_runtime_root_entries \
    "$migration_blocked_label after reboot recovery" \
    "$migration_blocked_root" false
done

# Each atomic-copy family is interrupted with a partial, non-fsynced temporary,
# with a complete fsynced temporary, and after rename made the destination
# visible but before its parent directory fsync. The 25-file admin loop, both
# five-file payload loops and all five live runtime destinations are then proven
# exact by the same-action terminal assertions.
for migration_copy_kind in \
  admin-stage old-runtime new-runtime installed-runtime; do
  for migration_copy_boundary in partial complete published; do
    migration_copy_label="copy-$migration_copy_boundary-$migration_copy_kind"
    migration_copy_root="$temporary/migration-$migration_copy_label-root"
    migration_copy_state="$temporary/migration-$migration_copy_label-state"
    migration_copy_nonce="migrationcopy${migration_copy_boundary}${migration_copy_kind//-/}nonce00000000001"
    create_legacy_migration_fixture \
      "$migration_copy_root" "$migration_copy_nonce" "$migration_copy_state"
    migration_copy_digest=$LEGACY_MIGRATION_DIGEST
    migration_copy_transaction="$(fresh_admin_migration_transaction \
      "$migration_copy_digest")"
    expect_admin_migration_sigkill \
      "$migration_copy_label" \
      "copy-$migration_copy_boundary:$migration_copy_kind" \
      "$migration_copy_root" "$migration_copy_nonce" \
      "$migration_copy_state" "$migration_copy_digest"
    assert_migration_fail_closed_after_kill \
      "$migration_copy_label" "$migration_copy_root" \
      "$migration_copy_state" "$migration_copy_transaction"
    migration_copy_source="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.source")"
    migration_copy_target="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.target")"
    migration_copy_temporary="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.temporary")"
    migration_copy_mode="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.mode")"
    if [[ "$migration_copy_boundary" == published ]]; then
      [[ -f "$migration_copy_target" && ! -L "$migration_copy_target" && \
        ! -e "$migration_copy_temporary" && \
        "$(stat -c '%u' "$migration_copy_target" 2>/dev/null || \
          stat -f '%u' "$migration_copy_target")" == "$EUID" && \
        "$(stat -c '%g' "$migration_copy_target" 2>/dev/null || \
          stat -f '%g' "$migration_copy_target")" == "$migration_caller_gid" && \
        "$(stat -c '%a' "$migration_copy_target" 2>/dev/null || \
          stat -f '%Lp' "$migration_copy_target")" == "${migration_copy_mode#0}" && \
        "$(stat -c '%h' "$migration_copy_target" 2>/dev/null || \
          stat -f '%l' "$migration_copy_target")" == 1 ]] && \
        /usr/bin/cmp -s "$migration_copy_source" "$migration_copy_target" ||
        fail "$migration_copy_label did not expose one exact published destination"
    else
      [[ "$migration_copy_target" == "$migration_copy_temporary" && \
        -f "$migration_copy_target" && ! -L "$migration_copy_target" && \
        "$(stat -c '%a' "$migration_copy_target" 2>/dev/null || \
          stat -f '%Lp' "$migration_copy_target")" == "${migration_copy_mode#0}" && \
        "$(stat -c '%h' "$migration_copy_target" 2>/dev/null || \
          stat -f '%l' "$migration_copy_target")" == 1 ]] ||
        fail "$migration_copy_label retained an unsafe atomic temporary"
    fi
    if [[ "$migration_copy_boundary" == partial ]]; then
      [[ "$(<"$migration_copy_target")" == partial ]] ||
        fail "$migration_copy_label did not prove a partial-write artifact"
    elif [[ "$migration_copy_boundary" == complete ]]; then
      /usr/bin/cmp -s "$migration_copy_source" "$migration_copy_target" ||
        fail "$migration_copy_label complete temporary differs from its bound source"
    fi
    run_admin_migration \
      "$migration_copy_root" "$migration_copy_nonce" \
      "$migration_copy_state" "$migration_copy_digest" >/dev/null ||
      fail "$migration_copy_label did not converge on same-action retry"
    [[ ! -e "$migration_copy_temporary" ]] ||
      fail "$migration_copy_label retained its stale temporary after retry"
    assert_migration_forward_completed \
      "$migration_copy_label" "$migration_copy_root" "$migration_copy_state"
  done
done

# The live-runtime copy family must also be recoverable in the rollback
# direction. Seed a new runtime with the candidate still staged, then interrupt
# restoration from the signed old-runtime payload at each atomic boundary.
for migration_old_copy_boundary in partial complete published; do
  migration_old_copy_label="copy-$migration_old_copy_boundary-installed-runtime-old"
  migration_old_copy_root="$temporary/migration-$migration_old_copy_label-root"
  migration_old_copy_state="$temporary/migration-$migration_old_copy_label-state"
  migration_old_copy_nonce="migrationcopy${migration_old_copy_boundary}installedruntimeoldnonce000001"
  create_legacy_migration_fixture \
    "$migration_old_copy_root" "$migration_old_copy_nonce" \
    "$migration_old_copy_state"
  migration_old_copy_digest=$LEGACY_MIGRATION_DIGEST
  migration_old_copy_transaction="$(fresh_admin_migration_transaction \
    "$migration_old_copy_digest")"
  migration_old_copy_journal="$migration_old_copy_root/var/lib/agent-os-ops/private/$migration_old_copy_transaction"
  expect_admin_migration_sigkill \
    "$migration_old_copy_label seed" phase-dir:runtime_activated \
    "$migration_old_copy_root" "$migration_old_copy_nonce" \
    "$migration_old_copy_state" "$migration_old_copy_digest"
  expect_admin_migration_sigkill \
    "$migration_old_copy_label" \
    "copy-$migration_old_copy_boundary:installed-runtime-old" \
    "$migration_old_copy_root" "$migration_old_copy_nonce" \
    "$migration_old_copy_state" "$migration_old_copy_digest" --rollback
  assert_migration_fail_closed_after_kill \
    "$migration_old_copy_label" "$migration_old_copy_root" \
    "$migration_old_copy_state" "$migration_old_copy_transaction"
  assert_migration_phase \
    "$migration_old_copy_journal" "$migration_old_copy_transaction" \
    rollback_started
  migration_old_copy_source="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.source")"
  migration_old_copy_target="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.target")"
  migration_old_copy_temporary="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.temporary")"
  migration_old_copy_mode="$(<"$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.mode")"
  [[ "$migration_old_copy_source" == \
      "$migration_old_copy_journal/old-runtime/hub-unit" ]] ||
    fail "$migration_old_copy_label did not bind the signed old-runtime source"
  if [[ "$migration_old_copy_boundary" == published ]]; then
    [[ "$migration_old_copy_target" == \
        "$migration_old_copy_root/etc/systemd/system/agent-os-hub.service" && \
      ! -e "$migration_old_copy_temporary" && \
      "$(stat -c '%u' "$migration_old_copy_target" 2>/dev/null || \
        stat -f '%u' "$migration_old_copy_target")" == "$EUID" && \
      "$(stat -c '%g' "$migration_old_copy_target" 2>/dev/null || \
        stat -f '%g' "$migration_old_copy_target")" == "$migration_caller_gid" && \
      "$(stat -c '%a' "$migration_old_copy_target" 2>/dev/null || \
        stat -f '%Lp' "$migration_old_copy_target")" == \
        "${migration_old_copy_mode#0}" && \
      "$(stat -c '%h' "$migration_old_copy_target" 2>/dev/null || \
        stat -f '%l' "$migration_old_copy_target")" == 1 ]] && \
      /usr/bin/cmp -s "$migration_old_copy_source" "$migration_old_copy_target" ||
      fail "$migration_old_copy_label did not expose the exact restored destination"
  else
    [[ "$migration_old_copy_target" == "$migration_old_copy_temporary" && \
      -f "$migration_old_copy_target" && ! -L "$migration_old_copy_target" && \
      "$(stat -c '%a' "$migration_old_copy_target" 2>/dev/null || \
        stat -f '%Lp' "$migration_old_copy_target")" == \
        "${migration_old_copy_mode#0}" && \
      "$(stat -c '%h' "$migration_old_copy_target" 2>/dev/null || \
        stat -f '%l' "$migration_old_copy_target")" == 1 ]] ||
      fail "$migration_old_copy_label retained an unsafe rollback temporary"
    if [[ "$migration_old_copy_boundary" == partial ]]; then
      [[ "$(<"$migration_old_copy_target")" == partial ]] ||
        fail "$migration_old_copy_label did not prove a partial rollback write"
    else
      /usr/bin/cmp -s "$migration_old_copy_source" "$migration_old_copy_target" ||
        fail "$migration_old_copy_label complete rollback temporary changed"
    fi
  fi
  run_admin_migration \
    "$migration_old_copy_root" "$migration_old_copy_nonce" \
    "$migration_old_copy_state" "$migration_old_copy_digest" --rollback \
    >/dev/null || fail "$migration_old_copy_label did not converge"
  [[ ! -e "$migration_old_copy_temporary" ]] ||
    fail "$migration_old_copy_label retained its rollback temporary"
  assert_migration_phase \
    "$migration_old_copy_journal" "$migration_old_copy_transaction" rolled_back
  assert_migration_phase \
    "$migration_old_copy_journal" "$migration_old_copy_transaction" finalized
  assert_migration_runtime_set "$migration_old_copy_root" "$legacy_admin_source" ||
    fail "$migration_old_copy_label did not restore the exact legacy runtime"
  assert_migration_guards_clean "$migration_old_copy_root"
  [[ -f "$migration_old_copy_state/active.agent-os-hub.service" && \
    -f "$migration_old_copy_state/enabled.agent-os-hub.service" ]] ||
    fail "$migration_old_copy_label did not finish active and enabled"
done

assert_admin_migration_metadata_contract() {
  local label=$1 metadata=$2 journal=$3 stage=$4 transaction=$5
  local admin_summary old_runtime_summary new_runtime_summary
  [[ -f "$metadata" && ! -L "$metadata" && \
    "$(stat -c '%a' "$metadata" 2>/dev/null || stat -f '%Lp' "$metadata")" == 400 && \
    "$(stat -c '%h' "$metadata" 2>/dev/null || stat -f '%l' "$metadata")" == 1 ]] ||
    fail "$label metadata entry is not a private one-link regular file"
  admin_summary="$($REAL_NODE_BIN \
    "$HUB_ROOT/bin/tree-digest.mjs" "$stage")" ||
    fail "$label could not fingerprint the staged admin kit"
  old_runtime_summary="$($REAL_NODE_BIN \
    "$HUB_ROOT/bin/tree-digest.mjs" --canonical-root-owner \
    "$journal/old-runtime")" ||
    fail "$label could not fingerprint the legacy runtime payload"
  new_runtime_summary="$($REAL_NODE_BIN \
    "$HUB_ROOT/bin/tree-digest.mjs" "$journal/new-runtime")" ||
    fail "$label could not fingerprint the new runtime payload"
  "$REAL_NODE_BIN" -e '
    const fs = require("node:fs");
    const [path, adminRaw, oldRaw, nextRaw, transaction, legacyDigest] =
      process.argv.slice(1);
    const admin = JSON.parse(adminRaw).treeSha256;
    const oldRuntime = JSON.parse(oldRaw).treeSha256;
    const nextRuntime = JSON.parse(nextRaw).treeSha256;
    if (![admin, oldRuntime, nextRuntime, legacyDigest].every(
      (value) => /^[a-f0-9]{64}$/u.test(value),
    )) process.exit(1);
    const expected = [
      "version=1",
      `transaction=${transaction}`,
      `new_admin_sha256=${admin}`,
      `old_runtime_sha256=${oldRuntime}`,
      `new_runtime_sha256=${nextRuntime}`,
      "",
    ].join("\n");
    if (oldRuntime !== legacyDigest || fs.readFileSync(path, "utf8") !== expected) {
      process.exit(1);
    }
  ' "$metadata" "$admin_summary" "$old_runtime_summary" \
    "$new_runtime_summary" "$transaction" \
    "$EXPECTED_LEGACY_RUNTIME_PRODUCTION_SHA256" ||
    fail "$label metadata did not bind the exact admin and runtime payloads"
}

# Metadata binds all three independently staged payload digests. Interrupt both
# its private temp fsync and its rename-to-journal parent fsync, then require the
# retry to re-derive the same digests before any prepared phase is accepted.
for migration_metadata_boundary in temp dir; do
  migration_metadata_label="metadata-$migration_metadata_boundary"
  migration_metadata_root="$temporary/migration-$migration_metadata_label-root"
  migration_metadata_state="$temporary/migration-$migration_metadata_label-state"
  migration_metadata_nonce="migrationmetadata${migration_metadata_boundary}nonce00000000000001"
  create_legacy_migration_fixture \
    "$migration_metadata_root" "$migration_metadata_nonce" \
    "$migration_metadata_state"
  migration_metadata_digest=$LEGACY_MIGRATION_DIGEST
  migration_metadata_transaction="$(fresh_admin_migration_transaction \
    "$migration_metadata_digest")"
  migration_metadata_artifact_id="$(admin_migration_artifact_id \
    "$migration_metadata_transaction")"
  migration_metadata_journal="$migration_metadata_root/var/lib/agent-os-ops/private/$migration_metadata_transaction"
  migration_metadata_stage="$migration_metadata_root/usr/libexec/agent-os/.hub-admin-migration-$migration_metadata_artifact_id"
  expect_admin_migration_sigkill \
    "$migration_metadata_label" \
    "phase-$migration_metadata_boundary:metadata" \
    "$migration_metadata_root" "$migration_metadata_nonce" \
    "$migration_metadata_state" "$migration_metadata_digest"
  assert_migration_fail_closed_after_kill \
    "$migration_metadata_label" "$migration_metadata_root" \
    "$migration_metadata_state" "$migration_metadata_transaction"
  [[ ! -e "$migration_metadata_journal/prepared" ]] ||
    fail "$migration_metadata_label published prepared before metadata durability"
  if [[ "$migration_metadata_boundary" == temp ]]; then
    shopt -s nullglob
    migration_metadata_temporaries=(
      "$migration_metadata_journal"/.metadata-*.tmp
    )
    shopt -u nullglob
    [[ "${#migration_metadata_temporaries[@]}" == 1 && \
      ! -e "$migration_metadata_journal/metadata" ]] ||
      fail "$migration_metadata_label did not retain one unpublished metadata entry"
    migration_metadata_entry=${migration_metadata_temporaries[0]}
  else
    shopt -s nullglob
    migration_metadata_temporaries=(
      "$migration_metadata_journal"/.metadata-*.tmp
    )
    shopt -u nullglob
    [[ "${#migration_metadata_temporaries[@]}" == 0 && \
      -f "$migration_metadata_journal/metadata" ]] ||
      fail "$migration_metadata_label did not retain one published metadata entry"
    migration_metadata_entry="$migration_metadata_journal/metadata"
  fi
  assert_admin_migration_metadata_contract \
    "$migration_metadata_label" "$migration_metadata_entry" \
    "$migration_metadata_journal" "$migration_metadata_stage" \
    "$migration_metadata_transaction"
  if [[ "$migration_metadata_boundary" == dir ]]; then
    migration_metadata_other_source="$temporary/migration-metadata-other-source"
    rm -rf -- "$migration_metadata_other_source"
    cp -R "$HUB_ROOT" "$migration_metadata_other_source"
    printf '%s\n' '# metadata-mismatch-source' >> \
      "$migration_metadata_other_source/nginx/agent-os-hub.conf"
    migration_metadata_root_before="$(migration_fixture_fingerprint \
      "$migration_metadata_root")"
    migration_metadata_control_before="$(migration_control_state_fingerprint \
      "$migration_metadata_state")"
    migration_metadata_error="$temporary/migration-metadata-source-mismatch.err"
    if run_admin_migration_from_source \
      "$migration_metadata_other_source" \
      "$migration_metadata_root" "$migration_metadata_nonce" \
      "$migration_metadata_state" "$migration_metadata_digest" \
      >/dev/null 2>"$migration_metadata_error"; then
      fail 'durable metadata accepted a different forward source'
    fi
    [[ "$(<"$migration_metadata_error")" == \
        'Hub deployment failed: current admin source does not match frozen migration metadata' && \
      "$(migration_fixture_fingerprint "$migration_metadata_root")" == \
        "$migration_metadata_root_before" && \
      "$(migration_control_state_fingerprint "$migration_metadata_state")" == \
        "$migration_metadata_control_before" ]] ||
      fail 'metadata source mismatch changed frozen payloads, service or journal'
  fi
  run_admin_migration \
    "$migration_metadata_root" "$migration_metadata_nonce" \
    "$migration_metadata_state" "$migration_metadata_digest" >/dev/null ||
    fail "$migration_metadata_label did not converge on same-action retry"
  assert_admin_migration_metadata_contract \
    "$migration_metadata_label retry" "$migration_metadata_journal/metadata" \
    "$migration_metadata_journal" \
    "$migration_metadata_root/usr/libexec/agent-os/hub" \
    "$migration_metadata_transaction"
  assert_migration_forward_completed \
    "$migration_metadata_label" "$migration_metadata_root" \
    "$migration_metadata_state"
done

for migration_forward_move in legacy-preserved candidate-activated; do
  migration_forward_move_label="forward-$migration_forward_move"
  migration_forward_move_root="$temporary/migration-$migration_forward_move_label-root"
  migration_forward_move_state="$temporary/migration-$migration_forward_move_label-state"
  migration_forward_move_nonce="migrationforward${migration_forward_move//-/}nonce000000000001"
  create_legacy_migration_fixture \
    "$migration_forward_move_root" "$migration_forward_move_nonce" \
    "$migration_forward_move_state"
  migration_forward_move_digest=$LEGACY_MIGRATION_DIGEST
  migration_forward_move_transaction="$(fresh_admin_migration_transaction \
    "$migration_forward_move_digest")"
  migration_forward_move_artifact_id="$(admin_migration_artifact_id \
    "$migration_forward_move_transaction")"
  migration_forward_move_previous="$migration_forward_move_root/usr/libexec/agent-os/hub.legacy-$migration_forward_move_artifact_id"
  migration_forward_move_stage="$migration_forward_move_root/usr/libexec/agent-os/.hub-admin-migration-$migration_forward_move_artifact_id"
  expect_admin_migration_sigkill \
    "$migration_forward_move_label" "$migration_forward_move_label" \
    "$migration_forward_move_root" "$migration_forward_move_nonce" \
    "$migration_forward_move_state" "$migration_forward_move_digest"
  assert_migration_fail_closed_after_kill \
    "$migration_forward_move_label" "$migration_forward_move_root" \
    "$migration_forward_move_state" "$migration_forward_move_transaction"
  case "$migration_forward_move" in
    legacy-preserved)
      [[ ! -e "$migration_forward_move_root/usr/libexec/agent-os/hub" && \
        -d "$migration_forward_move_previous" && \
        -d "$migration_forward_move_stage" ]] ||
        fail 'forward first admin rename did not preserve legacy+staged candidate'
      ;;
    candidate-activated)
      [[ -d "$migration_forward_move_root/usr/libexec/agent-os/hub" && \
        -d "$migration_forward_move_previous" && \
        ! -e "$migration_forward_move_stage" ]] ||
        fail 'forward second admin rename did not preserve candidate+legacy topology'
      ;;
  esac
  expect_admin_migration_sigkill \
    "$migration_forward_move_label parent redurability" \
    "$migration_forward_move_label" \
    "$migration_forward_move_root" "$migration_forward_move_nonce" \
    "$migration_forward_move_state" "$migration_forward_move_digest"
  case "$migration_forward_move" in
    legacy-preserved)
      [[ ! -e "$migration_forward_move_root/usr/libexec/agent-os/hub" && \
        -d "$migration_forward_move_previous" && \
        -d "$migration_forward_move_stage" ]] ||
        fail 'forward legacy-preserved retry advanced before parent re-fsync'
      ;;
    candidate-activated)
      [[ -d "$migration_forward_move_root/usr/libexec/agent-os/hub" && \
        -d "$migration_forward_move_previous" && \
        ! -e "$migration_forward_move_stage" ]] ||
        fail 'forward candidate-activated retry changed topology before parent re-fsync'
      ;;
  esac
  run_admin_migration \
    "$migration_forward_move_root" "$migration_forward_move_nonce" \
    "$migration_forward_move_state" "$migration_forward_move_digest" \
    >/dev/null || fail "$migration_forward_move_label did not converge"
  assert_migration_forward_completed \
    "$migration_forward_move_label" "$migration_forward_move_root" \
    "$migration_forward_move_state"
done

# Every phase publication is recoverable both when the 0400 temporary has not
# been fsynced and when rename is visible but the journal directory fsync has
# not completed. Retrying the same forward action must converge exactly.
for migration_kill_phase in \
  stopped prepared runtime_activated admin_activated; do
  for migration_kill_boundary in temp dir; do
    migration_kill_label="phase-$migration_kill_phase-$migration_kill_boundary"
    migration_kill_root="$temporary/migration-$migration_kill_label-root"
    migration_kill_state="$temporary/migration-$migration_kill_label-state"
    migration_kill_nonce="migration${migration_kill_phase//_/}${migration_kill_boundary}nonce0000000000000001"
    create_legacy_migration_fixture \
      "$migration_kill_root" "$migration_kill_nonce" "$migration_kill_state"
    migration_kill_digest=$LEGACY_MIGRATION_DIGEST
    migration_kill_transaction="$(fresh_admin_migration_transaction \
      "$migration_kill_digest")"
    migration_kill_journal="$migration_kill_root/var/lib/agent-os-ops/private/$migration_kill_transaction"
    expect_admin_migration_sigkill \
      "$migration_kill_label" \
      "phase-$migration_kill_boundary:$migration_kill_phase" \
      "$migration_kill_root" "$migration_kill_nonce" \
      "$migration_kill_state" "$migration_kill_digest"
    assert_migration_fail_closed_after_kill \
      "$migration_kill_label" "$migration_kill_root" \
      "$migration_kill_state" "$migration_kill_transaction"
    if [[ "$migration_kill_boundary" == temp ]]; then
      shopt -s nullglob
      migration_phase_temporaries=(
        "$migration_kill_journal"/."$migration_kill_phase"-*.tmp
      )
      shopt -u nullglob
      [[ "${#migration_phase_temporaries[@]}" == 1 && \
        ! -e "$migration_kill_journal/$migration_kill_phase" && \
        -f "${migration_phase_temporaries[0]}" && \
        ! -L "${migration_phase_temporaries[0]}" && \
        "$(stat -c '%a' "${migration_phase_temporaries[0]}" 2>/dev/null || \
          stat -f '%Lp' "${migration_phase_temporaries[0]}")" == 400 && \
        "$(stat -c '%h' "${migration_phase_temporaries[0]}" 2>/dev/null || \
          stat -f '%l' "${migration_phase_temporaries[0]}")" == 1 && \
        "$(<"${migration_phase_temporaries[0]}")" == \
          $'version=1\n'"transaction=$migration_kill_transaction"$'\n'"phase=$migration_kill_phase" ]] ||
        fail "$migration_kill_label left an unsafe or ambiguous journal temporary"
    else
      assert_migration_phase \
        "$migration_kill_journal" "$migration_kill_transaction" \
        "$migration_kill_phase"
      [[ -z "$(find "$migration_kill_journal" -maxdepth 1 \
        -name ".${migration_kill_phase}-*.tmp" -print -quit)" ]] ||
        fail "$migration_kill_label retained a phase temporary after rename"
      case "$migration_kill_phase" in
        stopped) migration_kill_next_phase=prepared ;;
        prepared) migration_kill_next_phase=runtime_activated ;;
        runtime_activated) migration_kill_next_phase=admin_activated ;;
        admin_activated) migration_kill_next_phase=daemon_reloaded ;;
      esac
      expect_admin_migration_sigkill \
        "$migration_kill_label journal redurability" \
        "phase-dir:$migration_kill_phase" \
        "$migration_kill_root" "$migration_kill_nonce" \
        "$migration_kill_state" "$migration_kill_digest"
      [[ ! -e "$migration_kill_journal/$migration_kill_next_phase" ]] ||
        fail "$migration_kill_label advanced before re-fsyncing its visible phase"
    fi
    run_admin_migration \
      "$migration_kill_root" "$migration_kill_nonce" \
      "$migration_kill_state" "$migration_kill_digest" >/dev/null ||
      fail "$migration_kill_label did not converge on same-action retry"
    assert_migration_forward_completed \
      "$migration_kill_label" "$migration_kill_root" "$migration_kill_state"
  done
done

for migration_late_phase in \
  daemon_reloaded started verified enabled committed finalized; do
  for migration_late_boundary in temp dir; do
    migration_late_label="phase-$migration_late_phase-$migration_late_boundary"
    migration_late_root="$temporary/migration-$migration_late_label-root"
    migration_late_state="$temporary/migration-$migration_late_label-state"
    migration_late_nonce="migrationlate${migration_late_phase//_/}${migration_late_boundary}nonce0000000001"
    create_legacy_migration_fixture \
      "$migration_late_root" "$migration_late_nonce" "$migration_late_state"
    migration_late_digest=$LEGACY_MIGRATION_DIGEST
    migration_late_transaction="$(fresh_admin_migration_transaction \
      "$migration_late_digest")"
    migration_late_journal="$migration_late_root/var/lib/agent-os-ops/private/$migration_late_transaction"
    expect_admin_migration_sigkill \
      "$migration_late_label" \
      "phase-$migration_late_boundary:$migration_late_phase" \
      "$migration_late_root" "$migration_late_nonce" \
      "$migration_late_state" "$migration_late_digest"
    if [[ "$migration_late_boundary" == temp ]]; then
      shopt -s nullglob
      migration_late_temporaries=(
        "$migration_late_journal"/."$migration_late_phase"-*.tmp
      )
      shopt -u nullglob
      [[ "${#migration_late_temporaries[@]}" == 1 && \
        ! -e "$migration_late_journal/$migration_late_phase" ]] ||
        fail "$migration_late_label did not retain one private phase temporary"
    else
      assert_migration_phase \
        "$migration_late_journal" "$migration_late_transaction" \
        "$migration_late_phase"
    fi
    case "$migration_late_phase" in
      daemon_reloaded)
        [[ ! -f "$migration_late_state/active.agent-os-hub.service" && \
          ! -f "$migration_late_state/enabled.agent-os-hub.service" ]] ||
          fail "$migration_late_label started or enabled before authorization"
        ;;
      started | verified)
        [[ -f "$migration_late_state/active.agent-os-hub.service" && \
          ! -f "$migration_late_state/enabled.agent-os-hub.service" ]] ||
          fail "$migration_late_label lost active/disabled ordering"
        ;;
      enabled | committed | finalized)
        [[ -f "$migration_late_state/active.agent-os-hub.service" && \
          -f "$migration_late_state/enabled.agent-os-hub.service" ]] ||
          fail "$migration_late_label did not retain active+enabled service state"
        ;;
    esac
    if [[ "$migration_late_phase" == finalized ]]; then
      assert_migration_guards_clean "$migration_late_root"
    else
      [[ -f "$migration_late_root/var/lib/agent-os-ops/hub-block" && \
        "$(<"$migration_late_root/var/lib/agent-os-ops/hub-block")" == \
          "agent-os-hub-recovery-block-v1:$migration_late_transaction" ]] ||
        fail "$migration_late_label lost its transaction block before finalization"
    fi
    run_admin_migration \
      "$migration_late_root" "$migration_late_nonce" \
      "$migration_late_state" "$migration_late_digest" >/dev/null ||
      fail "$migration_late_label did not converge on same-action retry"
    assert_migration_forward_completed \
      "$migration_late_label" "$migration_late_root" "$migration_late_state"
  done
done

# Forward commit removes ingress guards only after the exact active+enabled
# service is durably journaled. Interrupt both directory fsyncs on either side
# of the persistent-block unlink, then prove the committed transaction can
# converge without rolling back its signed admin/runtime payload.
for migration_forward_off_boundary in \
  forward-maintenance-runtime-before \
  forward-maintenance-runtime-after \
  forward-maintenance-ops-before \
  forward-maintenance-ops-after; do
  migration_forward_off_root="$temporary/migration-$migration_forward_off_boundary-root"
  migration_forward_off_state="$temporary/migration-$migration_forward_off_boundary-state"
  migration_forward_off_nonce="migration${migration_forward_off_boundary//-/}nonce0000000000001"
  create_legacy_migration_fixture \
    "$migration_forward_off_root" "$migration_forward_off_nonce" \
    "$migration_forward_off_state"
  migration_forward_off_digest=$LEGACY_MIGRATION_DIGEST
  migration_forward_off_transaction="$(fresh_admin_migration_transaction \
    "$migration_forward_off_digest")"
  migration_forward_off_journal="$migration_forward_off_root/var/lib/agent-os-ops/private/$migration_forward_off_transaction"
  expect_admin_migration_sigkill \
    "$migration_forward_off_boundary seed" phase-dir:committed \
    "$migration_forward_off_root" "$migration_forward_off_nonce" \
    "$migration_forward_off_state" "$migration_forward_off_digest"
  expect_admin_migration_sigkill \
    "$migration_forward_off_boundary" "$migration_forward_off_boundary" \
    "$migration_forward_off_root" "$migration_forward_off_nonce" \
    "$migration_forward_off_state" "$migration_forward_off_digest"
  [[ -f "$migration_forward_off_journal/committed" && \
    ! -e "$migration_forward_off_journal/finalized" && \
    -f "$migration_forward_off_state/active.agent-os-hub.service" && \
    -f "$migration_forward_off_state/enabled.agent-os-hub.service" && \
    ! -e "$migration_forward_off_root/run/agent-os/hub-maintenance" && \
    ! -e "$migration_forward_off_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "$migration_forward_off_boundary lost committed service ordering"
  case "$migration_forward_off_boundary" in
    forward-maintenance-runtime-*)
      [[ -f "$migration_forward_off_root/var/lib/agent-os-ops/hub-block" && \
        "$(<"$migration_forward_off_root/var/lib/agent-os-ops/hub-block")" == \
          "agent-os-hub-recovery-block-v1:$migration_forward_off_transaction" ]] ||
        fail "$migration_forward_off_boundary lost its persistent fsync barrier"
      ;;
    forward-maintenance-ops-*)
      [[ ! -e "$migration_forward_off_root/var/lib/agent-os-ops/hub-block" ]] ||
        fail "$migration_forward_off_boundary retained a block after unlink"
      ;;
  esac
  run_admin_migration \
    "$migration_forward_off_root" "$migration_forward_off_nonce" \
    "$migration_forward_off_state" "$migration_forward_off_digest" >/dev/null ||
    fail "$migration_forward_off_boundary did not converge"
  assert_migration_forward_completed \
    "$migration_forward_off_boundary" "$migration_forward_off_root" \
    "$migration_forward_off_state"
done

migration_forward_off_failure_root="$temporary/migration-forward-maintenance-off-failure-root"
migration_forward_off_failure_state="$temporary/migration-forward-maintenance-off-failure-state"
migration_forward_off_failure_nonce=migrationforwardmaintenanceofffailurenonce00000001
create_legacy_migration_fixture \
  "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
  "$migration_forward_off_failure_state"
migration_forward_off_failure_digest=$LEGACY_MIGRATION_DIGEST
migration_forward_off_failure_transaction="$(fresh_admin_migration_transaction \
  "$migration_forward_off_failure_digest")"
migration_forward_off_failure_journal="$migration_forward_off_failure_root/var/lib/agent-os-ops/private/$migration_forward_off_failure_transaction"
expect_admin_migration_sigkill \
  'forward maintenance-off failure seed' phase-dir:committed \
  "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
  "$migration_forward_off_failure_state" "$migration_forward_off_failure_digest"
migration_forward_off_failure_trace="$temporary/migration-forward-maintenance-off-failure.trace"
install -m 0600 /dev/null "$migration_forward_off_failure_trace"
export AGENT_OS_MOCK_FSYNC_PATH_TRACE="$migration_forward_off_failure_trace"
printf 'version=2\npath=%s\nordinal=2\n' \
  "$migration_forward_off_failure_root/run/agent-os" \
  >"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
if run_admin_migration \
  "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
  "$migration_forward_off_failure_state" "$migration_forward_off_failure_digest" \
  >/dev/null 2>"$temporary/migration-forward-maintenance-off-failure.err"; then
  fail 'forward migration accepted maintenance-off runtime fsync failure'
fi
unset AGENT_OS_MOCK_FSYNC_PATH_TRACE
[[ ! -e "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE" ]] ||
  fail 'forward maintenance-off failure did not reach the runtime fsync boundary'
[[ -f "$migration_forward_off_failure_journal/committed" ]] ||
  fail 'forward maintenance-off failure lost its committed journal phase'
[[ ! -e "$migration_forward_off_failure_journal/finalized" ]] ||
  fail 'forward maintenance-off failure incorrectly published finalized'
[[ -f "$migration_forward_off_failure_root/var/lib/agent-os-ops/hub-block" ]] ||
  fail 'forward maintenance-off failure lost its persistent block'
[[ "$(<"$migration_forward_off_failure_root/var/lib/agent-os-ops/hub-block")" == \
  "agent-os-hub-recovery-block-v1:$migration_forward_off_failure_transaction" ]] ||
  fail 'forward maintenance-off failure changed its persistent block transaction'
[[ ! -e "$migration_forward_off_failure_root/run/agent-os/hub-maintenance" ]] ||
  fail 'forward maintenance-off failure recreated its removed normal maintenance sentinel'
[[ -f "$migration_forward_off_failure_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'forward maintenance-off failure did not recreate its fail-closed sentinel'
grep -Eq \
  'class=runtime-root marker_armed=true token=false normal=false hard=false block=true$' \
  "$migration_forward_off_failure_trace" ||
  fail 'forward maintenance-off failure did not reach the exact post-unlink fsync boundary'
[[ ! -f "$migration_forward_off_failure_state/active.agent-os-hub.service" ]] ||
  fail 'forward maintenance-off failure left the Hub active'
[[ ! -f "$migration_forward_off_failure_state/enabled.agent-os-hub.service" ]] ||
  fail 'forward maintenance-off failure left the Hub enabled'
run_admin_migration \
  "$migration_forward_off_failure_root" "$migration_forward_off_failure_nonce" \
  "$migration_forward_off_failure_state" "$migration_forward_off_failure_digest" \
  >/dev/null || fail 'forward maintenance-off failure did not converge'
assert_migration_forward_completed \
  'forward maintenance-off failure' "$migration_forward_off_failure_root" \
  "$migration_forward_off_failure_state"

# The prepared journal binds the legacy runtime to its production canonical
# digest. A syntactically valid replacement digest must not authorize payload
# publication even when every staged byte remains otherwise unchanged.
migration_runtime_digest_root="$temporary/migration-runtime-digest-root"
migration_runtime_digest_state="$temporary/migration-runtime-digest-state"
migration_runtime_digest_nonce=migrationruntimedigestnonce00000000000001
create_legacy_migration_fixture \
  "$migration_runtime_digest_root" "$migration_runtime_digest_nonce" \
  "$migration_runtime_digest_state"
migration_runtime_digest_pin=$LEGACY_MIGRATION_DIGEST
migration_runtime_digest_transaction="$(fresh_admin_migration_transaction \
  "$migration_runtime_digest_pin")"
migration_runtime_digest_journal="$migration_runtime_digest_root/var/lib/agent-os-ops/private/$migration_runtime_digest_transaction"
expect_admin_migration_sigkill \
  'prepared runtime digest seed' phase-dir:prepared \
  "$migration_runtime_digest_root" "$migration_runtime_digest_nonce" \
  "$migration_runtime_digest_state" "$migration_runtime_digest_pin"
migration_wrong_runtime_digest=$(printf 'd%.0s' {1..64})
[[ "$migration_wrong_runtime_digest" != \
  "$EXPECTED_LEGACY_RUNTIME_PRODUCTION_SHA256" ]] ||
  migration_wrong_runtime_digest=$(printf 'c%.0s' {1..64})
chmod 0600 "$migration_runtime_digest_journal/metadata"
sed \
  "s/^old_runtime_sha256=.*/old_runtime_sha256=$migration_wrong_runtime_digest/" \
  "$migration_runtime_digest_journal/metadata" \
  >"$migration_runtime_digest_journal/metadata.rewrite"
chmod 0400 "$migration_runtime_digest_journal/metadata.rewrite"
mv "$migration_runtime_digest_journal/metadata.rewrite" \
  "$migration_runtime_digest_journal/metadata"
migration_runtime_digest_admin_before="$(migration_fixture_fingerprint \
  "$migration_runtime_digest_root/usr/libexec/agent-os")"
migration_runtime_digest_contract_before="$(migration_fixture_fingerprint \
  "$migration_runtime_digest_root/etc")"
migration_runtime_digest_state_before="$(migration_fixture_fingerprint \
  "$migration_runtime_digest_root/var/lib/agent-os/hub")"
migration_runtime_digest_root_before="$(migration_fixture_fingerprint \
  "$migration_runtime_digest_root")"
migration_runtime_digest_control_before="$(migration_fixture_fingerprint \
  "$migration_runtime_digest_state")"
migration_runtime_digest_error="$temporary/migration-runtime-digest.err"
if run_admin_migration \
  "$migration_runtime_digest_root" "$migration_runtime_digest_nonce" \
  "$migration_runtime_digest_state" "$migration_runtime_digest_pin" \
  >/dev/null 2>"$migration_runtime_digest_error"; then
  fail 'admin migration accepted a non-allowlisted legacy runtime digest'
fi
[[ "$(<"$migration_runtime_digest_error")" == \
  'Hub deployment failed: admin migration history journal is invalid' ]] ||
  fail 'wrong legacy runtime digest emitted the wrong preflight rejection'
[[ "$(migration_fixture_fingerprint "$migration_runtime_digest_root")" == \
  "$migration_runtime_digest_root_before" ]] ||
  fail 'wrong legacy runtime digest changed the migration test root'
[[ "$(migration_fixture_fingerprint "$migration_runtime_digest_state")" == \
  "$migration_runtime_digest_control_before" ]] ||
  fail 'wrong legacy runtime digest changed migration control state'
[[ "$(migration_fixture_fingerprint \
  "$migration_runtime_digest_root/usr/libexec/agent-os")" == \
  "$migration_runtime_digest_admin_before" ]] ||
  fail 'wrong legacy runtime digest changed migration admin artifacts'
[[ "$(migration_fixture_fingerprint "$migration_runtime_digest_root/etc")" == \
  "$migration_runtime_digest_contract_before" ]] ||
  fail 'wrong legacy runtime digest changed installed runtime artifacts'
[[ "$(migration_fixture_fingerprint \
  "$migration_runtime_digest_root/var/lib/agent-os/hub")" == \
  "$migration_runtime_digest_state_before" ]] ||
  fail 'wrong legacy runtime digest changed Hub state'
[[ ! -e "$migration_runtime_digest_journal/runtime_activated" ]] ||
  fail 'wrong legacy runtime digest reached runtime activation'
assert_migration_fail_closed_after_kill \
  'wrong legacy runtime digest' "$migration_runtime_digest_root" \
  "$migration_runtime_digest_state" "$migration_runtime_digest_transaction"

assert_prepared_gid_resume_rejected() {
  local label=$1 root=$2 nonce=$3 state=$4 digest=$5 action=$6 expected=$7
  local transaction artifact_id journal admin_before runtime_before state_before
  local old_payload_before new_payload_before stage_before log_before log_after new_log
  local error="$temporary/prepared-gid-${label//[^A-Za-z0-9_-]/_}.err"
  local -a action_arguments=()
  [[ "$action" == rollback ]] && action_arguments=(--rollback)
  transaction="$(fresh_admin_migration_transaction "$digest")"
  artifact_id="$(admin_migration_artifact_id "$transaction")"
  journal="$root/var/lib/agent-os-ops/private/$transaction"
  admin_before="$(migration_fixture_fingerprint "$root/usr/libexec/agent-os")"
  runtime_before="$(migration_fixture_fingerprint "$root/etc")"
  state_before="$(migration_state_contract_fingerprint \
    "$root/var/lib/agent-os/hub")"
  old_payload_before="$(migration_fixture_fingerprint "$journal/old-runtime")"
  new_payload_before="$(migration_fixture_fingerprint "$journal/new-runtime")"
  stage_before="$(migration_fixture_fingerprint \
    "$root/usr/libexec/agent-os/.hub-admin-migration-$artifact_id")"
  log_before="$(wc -l <"$state/systemctl.log" | tr -d ' ')"
  rm -f -- \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.source" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.target" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.temporary" \
    "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED.mode"
  printf '%s\n' copy-published:installed-runtime \
    >"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
  if run_admin_migration \
    "$root" "$nonce" "$state" "$digest" "${action_arguments[@]}" \
    >/dev/null 2>"$error"; then
    fail "$label accepted prepared GID drift"
  fi
  [[ -f "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE" && \
    ! -e "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" ]] ||
    fail "$label reached live runtime publication after prepared GID drift"
  rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
  log_after="$(wc -l <"$state/systemctl.log" | tr -d ' ')"
  new_log="$(sed -n "$((log_before + 1)),${log_after}p" \
    "$state/systemctl.log")"
  [[ "$(tail -n 1 "$error")" == "$expected" && \
    "$new_log" != *$'start agent-os-hub.service'* && \
    "$new_log" != *$'enable agent-os-hub.service'* && \
    "$new_log" != *$'daemon-reload'* && \
    "$(migration_fixture_fingerprint "$root/usr/libexec/agent-os")" == \
      "$admin_before" && \
    "$(migration_fixture_fingerprint "$root/etc")" == "$runtime_before" && \
    "$(migration_state_contract_fingerprint "$root/var/lib/agent-os/hub")" == \
      "$state_before" && \
    "$(migration_fixture_fingerprint "$journal/old-runtime")" == \
      "$old_payload_before" && \
    "$(migration_fixture_fingerprint "$journal/new-runtime")" == \
      "$new_payload_before" && \
    "$(migration_fixture_fingerprint \
      "$root/usr/libexec/agent-os/.hub-admin-migration-$artifact_id")" == \
      "$stage_before" && \
    ! -e "$journal/runtime_activated" && \
    ! -e "$journal/admin_activated" && \
    -f "$root/var/lib/agent-os-ops/hub-block" ]] ||
    fail "$label GID rejection changed payload/admin/runtime/state or authorized start"
  [[ "$(<"$root/var/lib/agent-os-ops/hub-block")" == \
      "agent-os-hub-recovery-block-v1:$transaction" && \
    -f "$root/run/agent-os/hub-maintenance" && \
    ! -e "$root/run/agent-os/hub-maintenance-hard" && \
    ! -f "$state/active.agent-os-hub.service" && \
    ! -f "$state/enabled.agent-os-hub.service" ]] ||
    fail "$label changed its preflight-blocked, inactive and disabled topology"
  [[ ! -e "$journal/rollback_started" ]] ||
    fail "$label published a rollback phase during pure preflight"
}

if [[ -n "$migration_wrong_group_gid" ]]; then
  for migration_prepared_gid_case in \
    old-root old-file new-root new-file mixed-installed-file; do
    for migration_prepared_gid_action in forward rollback; do
      migration_prepared_gid_label="prepared-gid-$migration_prepared_gid_case-$migration_prepared_gid_action"
      migration_prepared_gid_root="$temporary/migration-$migration_prepared_gid_label-root"
      migration_prepared_gid_state="$temporary/migration-$migration_prepared_gid_label-state"
      migration_prepared_gid_nonce="migrationpreparedgid${migration_prepared_gid_case//-/}${migration_prepared_gid_action}nonce00000001"
      create_legacy_migration_fixture \
        "$migration_prepared_gid_root" "$migration_prepared_gid_nonce" \
        "$migration_prepared_gid_state"
      migration_prepared_gid_digest=$LEGACY_MIGRATION_DIGEST
      migration_prepared_gid_transaction="$(fresh_admin_migration_transaction \
        "$migration_prepared_gid_digest")"
      migration_prepared_gid_journal="$migration_prepared_gid_root/var/lib/agent-os-ops/private/$migration_prepared_gid_transaction"
      expect_admin_migration_sigkill \
        "$migration_prepared_gid_label seed" phase-dir:prepared \
        "$migration_prepared_gid_root" "$migration_prepared_gid_nonce" \
        "$migration_prepared_gid_state" "$migration_prepared_gid_digest"
      case "$migration_prepared_gid_case" in
        old-root)
          migration_prepared_gid_target="$migration_prepared_gid_journal/old-runtime"
          migration_prepared_gid_expected='Hub deployment failed: frozen admin migration payload changed'
          ;;
        old-file)
          migration_prepared_gid_target="$migration_prepared_gid_journal/old-runtime/hub-unit"
          migration_prepared_gid_expected='Hub deployment failed: frozen admin migration payload changed'
          ;;
        new-root)
          migration_prepared_gid_target="$migration_prepared_gid_journal/new-runtime"
          migration_prepared_gid_expected='Hub deployment failed: frozen admin migration payload changed'
          ;;
        new-file)
          migration_prepared_gid_target="$migration_prepared_gid_journal/new-runtime/hub-unit"
          migration_prepared_gid_expected='Hub deployment failed: frozen admin migration payload changed'
          ;;
        mixed-installed-file)
          install -m 0644 \
            "$migration_prepared_gid_journal/new-runtime/hub-unit" \
            "$migration_prepared_gid_root/etc/systemd/system/agent-os-hub.service"
          migration_prepared_gid_target="$migration_prepared_gid_root/etc/systemd/system/agent-os-hub-candidate@.service"
          migration_prepared_gid_expected='Hub deployment failed: installed runtime is outside the frozen old-to-new transition set'
          ;;
      esac
      /usr/bin/chgrp "$migration_wrong_group_gid" "$migration_prepared_gid_target"
      assert_prepared_gid_resume_rejected \
        "$migration_prepared_gid_label" \
        "$migration_prepared_gid_root" "$migration_prepared_gid_nonce" \
        "$migration_prepared_gid_state" "$migration_prepared_gid_digest" \
        "$migration_prepared_gid_action" "$migration_prepared_gid_expected"
    done
  done
else
  [[ "$(/usr/bin/uname -s)" != Linux ]] ||
    fail 'Linux migration gate could not construct prepared payload GID drift fixtures'
  : >"$temporary/migration-prepared-gid-requires-ubuntu-root"
fi

assert_prepared_topology_rejected() {
  local label=$1 root=$2 nonce=$3 state=$4 digest=$5 action=$6 expected=$7
  local transaction journal admin_before runtime_before data_before journal_before
  local opt_before env_before state_before log_before log_after new_log error
  local journal_inventory_before journal_inventory_after journal_after
  local -a action_arguments=()
  [[ "$action" == rollback ]] && action_arguments=(--rollback)
  transaction="$(fresh_admin_migration_transaction "$digest")"
  journal="$root/var/lib/agent-os-ops/private/$transaction"
  admin_before="$(migration_fixture_fingerprint "$root/usr/libexec/agent-os")"
  runtime_before="$(migration_fixture_fingerprint "$root/etc")"
  data_before="$(migration_state_contract_fingerprint "$root/var/lib/agent-os/hub")"
  journal_before="$(migration_journal_contract_fingerprint "$journal")"
  journal_inventory_before="$temporary/prepared-topology-${label//[^A-Za-z0-9_-]/_}.journal-before"
  journal_inventory_after="$temporary/prepared-topology-${label//[^A-Za-z0-9_-]/_}.journal-after"
  migration_journal_contract_inventory "$journal" >"$journal_inventory_before"
  opt_before="$(migration_fixture_fingerprint "$root/opt")"
  env_before="$(migration_fixture_fingerprint "$root/etc/agent-os/hub.env")"
  state_before="$(migration_control_state_fingerprint "$state")"
  log_before="$(wc -l <"$state/systemctl.log" | tr -d ' ')"
  error="$temporary/prepared-topology-${label//[^A-Za-z0-9_-]/_}.err"
  rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED"
  printf '%s\n' phase-dir:daemon_reloaded \
    >"$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
  if run_admin_migration \
    "$root" "$nonce" "$state" "$digest" "${action_arguments[@]}" \
    >/dev/null 2>"$error"; then
    fail "$label accepted an ambiguous prepared candidate topology"
  fi
  [[ -f "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE" && \
    ! -e "$AGENT_OS_MOCK_MIGRATION_KILL_REACHED" ]] ||
    fail "$label reached daemon reload after accepting an ambiguous topology"
  rm -f -- "$AGENT_OS_MOCK_MIGRATION_KILL_ONCE"
  log_after="$(wc -l <"$state/systemctl.log" | tr -d ' ')"
  new_log="$(sed -n "$((log_before + 1)),${log_after}p" \
    "$state/systemctl.log")"
  [[ "$(tail -n 1 "$error")" == "$expected" ]] ||
    fail "$label ambiguous-topology rejection returned the wrong diagnostic"
  [[ "$(migration_fixture_fingerprint "$root/usr/libexec/agent-os")" == \
    "$admin_before" ]] ||
    fail "$label ambiguous-topology rejection changed the admin tree"
  [[ "$(migration_fixture_fingerprint "$root/etc")" == "$runtime_before" ]] ||
    fail "$label ambiguous-topology rejection changed the runtime tree"
  [[ "$(migration_state_contract_fingerprint "$root/var/lib/agent-os/hub")" == \
    "$data_before" ]] ||
    fail "$label ambiguous-topology rejection changed Hub state"
  journal_after="$(migration_journal_contract_fingerprint "$journal")"
  if [[ "$journal_after" != "$journal_before" ]]; then
    migration_journal_contract_inventory "$journal" >"$journal_inventory_after"
    diff -u "$journal_inventory_before" "$journal_inventory_after" |
      sed -n '1,24p' >&2 || true
    fail "$label ambiguous-topology rejection changed the migration journal"
  fi
  [[ "$(migration_fixture_fingerprint "$root/opt")" == "$opt_before" ]] ||
    fail "$label ambiguous-topology rejection changed releases"
  [[ "$(migration_fixture_fingerprint "$root/etc/agent-os/hub.env")" == \
    "$env_before" ]] ||
    fail "$label ambiguous-topology rejection changed hub.env"
  [[ "$(migration_control_state_fingerprint "$state")" == "$state_before" ]] ||
    fail "$label ambiguous-topology rejection changed service control state"
  [[ "$new_log" != *$'daemon-reload'* ]] ||
    fail "$label ambiguous-topology rejection authorized daemon-reload"
  [[ "$new_log" != *$'start agent-os-hub.service'* ]] ||
    fail "$label ambiguous-topology rejection authorized service start"
  [[ "$new_log" != *$'enable agent-os-hub.service'* ]] ||
    fail "$label ambiguous-topology rejection authorized service enable"
  [[ -f "$root/var/lib/agent-os-ops/hub-block" ]] ||
    fail "$label ambiguous-topology rejection removed the durable block"
  [[ "$(<"$root/var/lib/agent-os-ops/hub-block")" == \
    "agent-os-hub-recovery-block-v1:$transaction" ]] ||
    fail "$label ambiguous-topology rejection changed the durable block"
  [[ ! -f "$state/active.agent-os-hub.service" ]] ||
    fail "$label ambiguous-topology rejection left the service active"
  [[ ! -f "$state/enabled.agent-os-hub.service" ]] ||
    fail "$label ambiguous-topology rejection left the service enabled"
}

for migration_topology_case in \
  stage-extra-failed \
  current-extra-stage \
  legacy-failed-extra-previous \
  legacy-failed-stage-extra-previous \
  previous-failed-extra-stage \
  previous-stage-extra-failed; do
  migration_topology_root="$temporary/migration-topology-$migration_topology_case-root"
  migration_topology_state="$temporary/migration-topology-$migration_topology_case-state"
  migration_topology_nonce="migrationtopology${migration_topology_case//-/}nonce0000000001"
  create_legacy_migration_fixture \
    "$migration_topology_root" "$migration_topology_nonce" \
    "$migration_topology_state"
  migration_topology_digest=$LEGACY_MIGRATION_DIGEST
  migration_topology_transaction="$(fresh_admin_migration_transaction \
    "$migration_topology_digest")"
  migration_topology_artifact_id="$(admin_migration_artifact_id \
    "$migration_topology_transaction")"
  migration_topology_stage="$migration_topology_root/usr/libexec/agent-os/.hub-admin-migration-$migration_topology_artifact_id"
  migration_topology_previous="$migration_topology_root/usr/libexec/agent-os/hub.legacy-$migration_topology_artifact_id"
  migration_topology_failed="$migration_topology_root/usr/libexec/agent-os/hub.failed-migration-$migration_topology_artifact_id"
  migration_topology_failed_stage="$migration_topology_root/usr/libexec/agent-os/hub.failed-migration-stage-$migration_topology_artifact_id"
  case "$migration_topology_case" in
    stage-extra-failed)
      expect_admin_migration_sigkill \
        "$migration_topology_case seed" phase-dir:prepared \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      install -d -m 0555 "$migration_topology_failed"
      migration_topology_action=forward
      migration_topology_expected='Hub deployment failed: frozen admin migration candidate topology changed'
      ;;
    current-extra-stage)
      expect_admin_migration_sigkill \
        "$migration_topology_case seed" phase-dir:admin_activated \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      printf '%s\n' unsafe-extra-stage >"$migration_topology_stage"
      chmod 0400 "$migration_topology_stage"
      migration_topology_action=forward
      migration_topology_expected='Hub deployment failed: frozen admin migration candidate topology changed'
      ;;
    legacy-failed-extra-previous)
      expect_admin_migration_sigkill \
        "$migration_topology_case forward seed" phase-dir:daemon_reloaded \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      expect_admin_migration_sigkill \
        "$migration_topology_case isolate seed" rollback-new-isolated \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest" --rollback
      expect_admin_migration_sigkill \
        "$migration_topology_case restore seed" rollback-legacy-restored \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest" --rollback
      ln -s hub "$migration_topology_previous"
      migration_topology_action=rollback
      migration_topology_expected='Hub deployment failed: frozen admin migration candidate topology changed'
      ;;
    legacy-failed-stage-extra-previous)
      expect_admin_migration_sigkill \
        "$migration_topology_case forward seed" phase-dir:runtime_activated \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      expect_admin_migration_sigkill \
        "$migration_topology_case isolate seed" rollback-stage-isolated \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest" --rollback
      ln -s hub "$migration_topology_previous"
      migration_topology_action=rollback
      migration_topology_expected='Hub deployment failed: frozen admin migration candidate topology changed'
      ;;
    previous-failed-extra-stage)
      expect_admin_migration_sigkill \
        "$migration_topology_case forward seed" phase-dir:daemon_reloaded \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      expect_admin_migration_sigkill \
        "$migration_topology_case isolate seed" rollback-new-isolated \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest" --rollback
      printf '%s\n' unsafe-extra-stage >"$migration_topology_stage"
      chmod 0400 "$migration_topology_stage"
      migration_topology_action=rollback
      migration_topology_expected='Hub deployment failed: frozen admin migration candidate topology changed'
      ;;
    previous-stage-extra-failed)
      expect_admin_migration_sigkill \
        "$migration_topology_case prepared seed" phase-dir:prepared \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      expect_admin_migration_sigkill \
        "$migration_topology_case preserve seed" forward-legacy-preserved \
        "$migration_topology_root" "$migration_topology_nonce" \
        "$migration_topology_state" "$migration_topology_digest"
      install -d -m 0555 "$migration_topology_failed"
      migration_topology_action=forward
      migration_topology_expected='Hub deployment failed: frozen admin migration candidate topology changed'
      ;;
  esac
  assert_prepared_topology_rejected \
    "$migration_topology_case" \
    "$migration_topology_root" "$migration_topology_nonce" \
    "$migration_topology_state" "$migration_topology_digest" \
    "$migration_topology_action" "$migration_topology_expected"
done

# Reach an activated candidate, then interrupt each of rollback's two admin
# moves. The same rollback command must understand both intermediate layouts.
migration_restore_moves_root="$temporary/migration-restore-moves-root"
migration_restore_moves_state="$temporary/migration-restore-moves-state"
migration_restore_moves_nonce=migrationrestoremovesnonce00000000000001
create_legacy_migration_fixture \
  "$migration_restore_moves_root" "$migration_restore_moves_nonce" \
  "$migration_restore_moves_state"
migration_restore_moves_digest=$LEGACY_MIGRATION_DIGEST
migration_restore_moves_transaction="$(fresh_admin_migration_transaction \
  "$migration_restore_moves_digest")"
migration_restore_moves_artifact_id="$(admin_migration_artifact_id \
  "$migration_restore_moves_transaction")"
migration_restore_moves_journal="$migration_restore_moves_root/var/lib/agent-os-ops/private/$migration_restore_moves_transaction"
expect_admin_migration_sigkill \
  'activated candidate seed' phase-temp:daemon_reloaded \
  "$migration_restore_moves_root" "$migration_restore_moves_nonce" \
  "$migration_restore_moves_state" "$migration_restore_moves_digest"
expect_admin_migration_sigkill \
  'rollback candidate isolation' rollback-new-isolated \
  "$migration_restore_moves_root" "$migration_restore_moves_nonce" \
  "$migration_restore_moves_state" "$migration_restore_moves_digest" --rollback
assert_migration_phase \
  "$migration_restore_moves_journal" "$migration_restore_moves_transaction" \
  rollback_started
[[ ! -e "$migration_restore_moves_root/usr/libexec/agent-os/hub" && \
  -d "$migration_restore_moves_root/usr/libexec/agent-os/hub.legacy-$migration_restore_moves_artifact_id" && \
  -d "$migration_restore_moves_root/usr/libexec/agent-os/hub.failed-migration-$migration_restore_moves_artifact_id" ]] ||
  fail 'rollback first move did not preserve exactly legacy+isolated candidate'
expect_admin_migration_sigkill \
  'rollback legacy restoration' rollback-legacy-restored \
  "$migration_restore_moves_root" "$migration_restore_moves_nonce" \
  "$migration_restore_moves_state" "$migration_restore_moves_digest" --rollback
[[ -d "$migration_restore_moves_root/usr/libexec/agent-os/hub" && \
  ! -e "$migration_restore_moves_root/usr/libexec/agent-os/hub.legacy-$migration_restore_moves_artifact_id" && \
  -d "$migration_restore_moves_root/usr/libexec/agent-os/hub.failed-migration-$migration_restore_moves_artifact_id" ]] ||
  fail 'rollback second move did not restore legacy while retaining the isolated candidate'
run_admin_migration \
  "$migration_restore_moves_root" "$migration_restore_moves_nonce" \
  "$migration_restore_moves_state" "$migration_restore_moves_digest" --rollback \
  >/dev/null || fail 'rollback two-move SIGKILL topology did not converge'
assert_migration_runtime_set "$migration_restore_moves_root" "$legacy_admin_source" ||
  fail 'rollback two-move recovery did not restore the exact legacy runtime'
assert_migration_guards_clean "$migration_restore_moves_root"
[[ -f "$migration_restore_moves_state/active.agent-os-hub.service" && \
  -f "$migration_restore_moves_state/enabled.agent-os-hub.service" ]] ||
  fail 'rollback two-move recovery did not finish active+enabled'

# Reach a prepared staged candidate, kill after it is durably isolated for
# rollback, and prove action stickiness before testing daemon-reload SIGKILL.
migration_stage_rollback_root="$temporary/migration-stage-rollback-root"
migration_stage_rollback_state="$temporary/migration-stage-rollback-state"
migration_stage_rollback_nonce=migrationstagerollbacknonce0000000000001
create_legacy_migration_fixture \
  "$migration_stage_rollback_root" "$migration_stage_rollback_nonce" \
  "$migration_stage_rollback_state"
migration_stage_rollback_digest=$LEGACY_MIGRATION_DIGEST
migration_stage_rollback_transaction="$(fresh_admin_migration_transaction \
  "$migration_stage_rollback_digest")"
migration_stage_rollback_artifact_id="$(admin_migration_artifact_id \
  "$migration_stage_rollback_transaction")"
migration_stage_rollback_journal="$migration_stage_rollback_root/var/lib/agent-os-ops/private/$migration_stage_rollback_transaction"
expect_admin_migration_sigkill \
  'prepared stage seed' phase-temp:runtime_activated \
  "$migration_stage_rollback_root" "$migration_stage_rollback_nonce" \
  "$migration_stage_rollback_state" "$migration_stage_rollback_digest"
expect_admin_migration_sigkill \
  'rollback stage isolation' rollback-stage-isolated \
  "$migration_stage_rollback_root" "$migration_stage_rollback_nonce" \
  "$migration_stage_rollback_state" "$migration_stage_rollback_digest" --rollback
assert_migration_phase \
  "$migration_stage_rollback_journal" "$migration_stage_rollback_transaction" \
  rollback_started
migration_stage_failed="$migration_stage_rollback_root/usr/libexec/agent-os/hub.failed-migration-stage-$migration_stage_rollback_artifact_id"
[[ -d "$migration_stage_rollback_root/usr/libexec/agent-os/hub" && \
  ! -e "$migration_stage_rollback_root/usr/libexec/agent-os/.hub-admin-migration-$migration_stage_rollback_artifact_id" && \
  -d "$migration_stage_failed" ]] ||
  fail 'rollback stage isolation did not retain exactly legacy+forensic candidate'
migration_stage_switch_hash="$(migration_fixture_fingerprint \
  "$migration_stage_rollback_root")"
migration_stage_switch_log="$(<"$migration_stage_rollback_state/systemctl.log")"
migration_stage_switch_error="$temporary/migration-stage-switch.err"
if run_admin_migration \
  "$migration_stage_rollback_root" "$migration_stage_rollback_nonce" \
  "$migration_stage_rollback_state" "$migration_stage_rollback_digest" \
  >/dev/null 2>"$migration_stage_switch_error"; then
  fail 'rollback-started migration accepted a switch back to forward'
fi
[[ "$(<"$migration_stage_switch_error")" == \
    'Hub deployment failed: a rolled-back admin migration can only be finalized as rollback' && \
  "$(migration_fixture_fingerprint "$migration_stage_rollback_root")" == \
    "$migration_stage_switch_hash" && \
  "$(<"$migration_stage_rollback_state/systemctl.log")" == \
    "$migration_stage_switch_log" ]] ||
  fail 'rollback action-stickiness rejection changed topology or systemd state'
expect_admin_migration_sigkill \
  'rollback daemon reload' rollback-daemon \
  "$migration_stage_rollback_root" "$migration_stage_rollback_nonce" \
  "$migration_stage_rollback_state" "$migration_stage_rollback_digest" --rollback
run_admin_migration \
  "$migration_stage_rollback_root" "$migration_stage_rollback_nonce" \
  "$migration_stage_rollback_state" "$migration_stage_rollback_digest" --rollback \
  >/dev/null || fail 'rollback stage/daemon SIGKILL topology did not converge'
assert_migration_runtime_set "$migration_stage_rollback_root" "$legacy_admin_source" ||
  fail 'rollback stage/daemon recovery did not restore exact legacy runtime'
assert_migration_guards_clean "$migration_stage_rollback_root"
[[ -d "$migration_stage_failed" && \
  -f "$migration_stage_rollback_state/active.agent-os-hub.service" && \
  -f "$migration_stage_rollback_state/enabled.agent-os-hub.service" ]] ||
  fail 'rollback stage/daemon recovery lost its candidate or service signoff'

# Rollback may start the legacy Hub only after reloading and revalidating the
# effective installed unit. Redirects, drop-ins and a pending reload all leave
# the exact transaction blocked, inactive and disabled.
for migration_rollback_contract_case in fragment dropin reload; do
  migration_contract_root="$temporary/migration-rollback-contract-$migration_rollback_contract_case-root"
  migration_contract_state="$temporary/migration-rollback-contract-$migration_rollback_contract_case-state"
  migration_contract_nonce="migrationrollbackcontract${migration_rollback_contract_case}nonce000000000001"
  create_legacy_migration_fixture \
    "$migration_contract_root" "$migration_contract_nonce" \
    "$migration_contract_state"
  migration_contract_digest=$LEGACY_MIGRATION_DIGEST
  migration_contract_transaction="$(fresh_admin_migration_transaction \
    "$migration_contract_digest")"
  expect_admin_migration_sigkill \
    "rollback effective-unit $migration_rollback_contract_case seed" \
    phase-temp:daemon_reloaded \
    "$migration_contract_root" "$migration_contract_nonce" \
    "$migration_contract_state" "$migration_contract_digest"
  case "$migration_rollback_contract_case" in
    fragment) migration_contract_fault=$AGENT_OS_MOCK_BAD_LIVE_FRAGMENT ;;
    dropin) migration_contract_fault=$AGENT_OS_MOCK_LIVE_DROPIN ;;
    reload) migration_contract_fault=$AGENT_OS_MOCK_LIVE_RELOAD_REQUIRED ;;
  esac
  : >"$migration_contract_fault"
  migration_contract_log_before="$(wc -l \
    <"$migration_contract_state/systemctl.log" | tr -d ' ')"
  migration_contract_error="$temporary/migration-rollback-contract-$migration_rollback_contract_case.err"
  if run_admin_migration \
    "$migration_contract_root" "$migration_contract_nonce" \
    "$migration_contract_state" "$migration_contract_digest" --rollback \
    >/dev/null 2>"$migration_contract_error"; then
    fail "rollback accepted effective-unit $migration_rollback_contract_case drift"
  fi
  rm -f -- "$migration_contract_fault"
  migration_contract_log_after="$(wc -l \
    <"$migration_contract_state/systemctl.log" | tr -d ' ')"
  migration_contract_new_log="$(sed -n \
    "$((migration_contract_log_before + 1)),${migration_contract_log_after}p" \
    "$migration_contract_state/systemctl.log")"
  [[ "$(<"$migration_contract_error")" == \
      'Hub deployment failed: effective Hub unit is stale, redirected or modified by a drop-in' && \
    "$migration_contract_new_log" != *$'start agent-os-hub.service'* ]] ||
    fail "rollback effective-unit $migration_rollback_contract_case rejection was inexact or started the Hub"
  assert_migration_fail_closed_after_kill \
    "rollback effective-unit $migration_rollback_contract_case" \
    "$migration_contract_root" "$migration_contract_state" \
    "$migration_contract_transaction" present
  [[ "$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
      --canonical-root-owner \
      "$migration_contract_root/usr/libexec/agent-os/hub" | \
      "$REAL_NODE_BIN" -e \
        'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" == \
      "$migration_contract_digest" ]] ||
    fail "rollback effective-unit $migration_rollback_contract_case lost the legacy admin kit"
  assert_migration_runtime_set "$migration_contract_root" "$legacy_admin_source" ||
    fail "rollback effective-unit $migration_rollback_contract_case changed the legacy runtime"
  run_admin_migration \
    "$migration_contract_root" "$migration_contract_nonce" \
    "$migration_contract_state" "$migration_contract_digest" --rollback \
    >/dev/null ||
    fail "rollback effective-unit $migration_rollback_contract_case did not resume after drift removal"
  assert_migration_guards_clean "$migration_contract_root"
  [[ -f "$migration_contract_state/active.agent-os-hub.service" && \
    -f "$migration_contract_state/enabled.agent-os-hub.service" && \
    -f "$migration_contract_root/var/lib/agent-os-ops/private/$migration_contract_transaction/rolled_back" && \
    -f "$migration_contract_root/var/lib/agent-os-ops/private/$migration_contract_transaction/finalized" ]] ||
    fail "rollback effective-unit $migration_rollback_contract_case did not converge to its terminal contract"
done

# Rollback starts and probes the exact legacy process while it remains disabled
# behind both the normal and persistent ingress guards. Exercise each boundary
# through guard cleanup and enablement; same-action retry must converge.
for migration_rollback_boundary in \
  rollback-start \
  rollback-health \
  rollback-maintenance-runtime-before \
  rollback-maintenance-runtime-after \
  rollback-maintenance-ops-before \
  rollback-maintenance-ops-after \
  rollback-enable; do
  migration_rollback_boundary_root="$temporary/migration-$migration_rollback_boundary-root"
  migration_rollback_boundary_state="$temporary/migration-$migration_rollback_boundary-state"
  migration_rollback_boundary_nonce="migration${migration_rollback_boundary//-/}nonce0000000000001"
  create_legacy_migration_fixture \
    "$migration_rollback_boundary_root" "$migration_rollback_boundary_nonce" \
    "$migration_rollback_boundary_state"
  migration_rollback_boundary_digest=$LEGACY_MIGRATION_DIGEST
  migration_rollback_boundary_transaction="$(fresh_admin_migration_transaction \
    "$migration_rollback_boundary_digest")"
  migration_rollback_boundary_journal="$migration_rollback_boundary_root/var/lib/agent-os-ops/private/$migration_rollback_boundary_transaction"
  expect_admin_migration_sigkill \
    "$migration_rollback_boundary seed" phase-dir:daemon_reloaded \
    "$migration_rollback_boundary_root" "$migration_rollback_boundary_nonce" \
    "$migration_rollback_boundary_state" "$migration_rollback_boundary_digest"
  expect_admin_migration_sigkill \
    "$migration_rollback_boundary" "$migration_rollback_boundary" \
    "$migration_rollback_boundary_root" "$migration_rollback_boundary_nonce" \
    "$migration_rollback_boundary_state" "$migration_rollback_boundary_digest" \
    --rollback
  assert_migration_phase \
    "$migration_rollback_boundary_journal" \
    "$migration_rollback_boundary_transaction" rolled_back
  [[ ! -e "$migration_rollback_boundary_journal/finalized" && \
    -f "$migration_rollback_boundary_state/active.agent-os-hub.service" ]] ||
    fail "$migration_rollback_boundary did not retain its active pre-finalized process"
  case "$migration_rollback_boundary" in
    rollback-start | rollback-health)
      [[ -f "$migration_rollback_boundary_root/run/agent-os/hub-maintenance" && \
        ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance-hard" && \
        -f "$migration_rollback_boundary_root/var/lib/agent-os-ops/hub-block" && \
        "$(<"$migration_rollback_boundary_root/var/lib/agent-os-ops/hub-block")" == \
          "agent-os-hub-recovery-block-v1:$migration_rollback_boundary_transaction" && \
        ! -f "$migration_rollback_boundary_state/enabled.agent-os-hub.service" ]] ||
        fail "$migration_rollback_boundary exposed an unverified rollback process"
      ;;
    rollback-maintenance-runtime-*)
      [[ ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance" && \
        ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance-hard" && \
        -f "$migration_rollback_boundary_root/var/lib/agent-os-ops/hub-block" && \
        ! -f "$migration_rollback_boundary_state/enabled.agent-os-hub.service" ]] ||
        fail "$migration_rollback_boundary lost its persistent cleanup barrier"
      ;;
    rollback-maintenance-ops-*)
      [[ ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance" && \
        ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance-hard" && \
        ! -e "$migration_rollback_boundary_root/var/lib/agent-os-ops/hub-block" && \
        ! -f "$migration_rollback_boundary_state/enabled.agent-os-hub.service" ]] ||
        fail "$migration_rollback_boundary did not expose the post-health clean boundary"
      ;;
    rollback-enable)
      [[ ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance" && \
        ! -e "$migration_rollback_boundary_root/run/agent-os/hub-maintenance-hard" && \
        ! -e "$migration_rollback_boundary_root/var/lib/agent-os-ops/hub-block" && \
        -f "$migration_rollback_boundary_state/enabled.agent-os-hub.service" ]] ||
        fail 'rollback enable crash did not retain active+enabled clean topology'
      ;;
  esac
  run_admin_migration \
    "$migration_rollback_boundary_root" "$migration_rollback_boundary_nonce" \
    "$migration_rollback_boundary_state" "$migration_rollback_boundary_digest" \
    --rollback >/dev/null ||
    fail "$migration_rollback_boundary did not converge on retry"
  assert_rollback_migration_completed \
    "$migration_rollback_boundary" "$migration_rollback_boundary_root" \
    "$migration_rollback_boundary_state" "$migration_rollback_boundary_transaction"
done

for migration_rollback_failure in start health maintenance-off; do
  migration_rollback_failure_root="$temporary/migration-rollback-$migration_rollback_failure-failure-root"
  migration_rollback_failure_state="$temporary/migration-rollback-$migration_rollback_failure-failure-state"
  migration_rollback_failure_nonce="migrationrollback${migration_rollback_failure//-/}failurenonce000000001"
  create_legacy_migration_fixture \
    "$migration_rollback_failure_root" "$migration_rollback_failure_nonce" \
    "$migration_rollback_failure_state"
  migration_rollback_failure_digest=$LEGACY_MIGRATION_DIGEST
  migration_rollback_failure_transaction="$(fresh_admin_migration_transaction \
    "$migration_rollback_failure_digest")"
  migration_rollback_failure_journal="$migration_rollback_failure_root/var/lib/agent-os-ops/private/$migration_rollback_failure_transaction"
  expect_admin_migration_sigkill \
    "rollback $migration_rollback_failure failure seed" \
    phase-dir:daemon_reloaded \
    "$migration_rollback_failure_root" "$migration_rollback_failure_nonce" \
    "$migration_rollback_failure_state" "$migration_rollback_failure_digest"
  case "$migration_rollback_failure" in
    start)
      printf '%s\n' legacy-release >"$AGENT_OS_MOCK_FAIL_START_REVISION"
      migration_rollback_failure_marker=$AGENT_OS_MOCK_FAIL_START_REVISION
      migration_rollback_failure_expected='Hub deployment failed: legacy Hub failed to start after migration rollback'
      ;;
    health)
      printf '%s\n' legacy-release >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
      migration_rollback_failure_marker=$AGENT_OS_MOCK_FAIL_HEALTH_REVISION
      migration_rollback_failure_expected='Hub deployment failed: legacy Hub failed liveness after migration rollback'
      ;;
    maintenance-off)
      printf '%s\n' "$migration_rollback_failure_root/run/agent-os" \
        >"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
      migration_rollback_failure_marker=$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE
      migration_rollback_failure_expected='Hub deployment failed: maintenance runtime cleanup durability failed'
      ;;
  esac
  migration_rollback_failure_error="$temporary/migration-rollback-$migration_rollback_failure-failure.err"
  if run_admin_migration \
    "$migration_rollback_failure_root" "$migration_rollback_failure_nonce" \
    "$migration_rollback_failure_state" "$migration_rollback_failure_digest" \
    --rollback >/dev/null 2>"$migration_rollback_failure_error"; then
    fail "rollback accepted $migration_rollback_failure failure"
  fi
  if [[ "$migration_rollback_failure" == health ]]; then
    [[ -f "$migration_rollback_failure_marker" && \
      ! -L "$migration_rollback_failure_marker" && \
      "$(<"$migration_rollback_failure_marker")" == legacy-release ]] ||
      fail 'rollback health failure marker changed'
    rm -f -- "$migration_rollback_failure_marker"
  else
    [[ ! -e "$migration_rollback_failure_marker" ]] ||
      fail "rollback $migration_rollback_failure failure marker was not consumed"
  fi
  [[ "$(tail -n 1 "$migration_rollback_failure_error")" == \
    "$migration_rollback_failure_expected" ]] ||
    fail "rollback $migration_rollback_failure failure diagnostic tail changed"
  [[ -f "$migration_rollback_failure_journal/rolled_back" ]] ||
    fail "rollback $migration_rollback_failure failure did not retain rolled_back"
  [[ ! -e "$migration_rollback_failure_journal/finalized" ]] ||
    fail "rollback $migration_rollback_failure failure published finalized"
  migration_rollback_failure_block="$migration_rollback_failure_root/var/lib/agent-os-ops/hub-block"
  [[ -f "$migration_rollback_failure_block" && \
    ! -L "$migration_rollback_failure_block" ]] ||
    fail "rollback $migration_rollback_failure failure lost its regular durable block"
  [[ "$(<"$migration_rollback_failure_block")" == \
    "agent-os-hub-recovery-block-v1:$migration_rollback_failure_transaction" ]] ||
    fail "rollback $migration_rollback_failure failure durable block transaction changed"
  [[ -f "$migration_rollback_failure_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "rollback $migration_rollback_failure failure did not enter hard maintenance"
  [[ ! -f "$migration_rollback_failure_state/active.agent-os-hub.service" ]] ||
    fail "rollback $migration_rollback_failure failure left the service active"
  [[ ! -f "$migration_rollback_failure_state/enabled.agent-os-hub.service" ]] ||
    fail "rollback $migration_rollback_failure failure left the service enabled"
  if [[ "$migration_rollback_failure" == maintenance-off ]]; then
    [[ ! -e "$migration_rollback_failure_root/run/agent-os/hub-maintenance" ]] ||
      fail 'rollback maintenance-off fsync failure recreated a stale normal sentinel'
  else
    [[ -f "$migration_rollback_failure_root/run/agent-os/hub-maintenance" ]] ||
      fail "rollback $migration_rollback_failure failure lost the pre-health ingress guard"
  fi
  run_admin_migration \
    "$migration_rollback_failure_root" "$migration_rollback_failure_nonce" \
    "$migration_rollback_failure_state" "$migration_rollback_failure_digest" \
    --rollback >/dev/null ||
    fail "rollback $migration_rollback_failure failure did not converge"
  assert_rollback_migration_completed \
    "rollback $migration_rollback_failure failure" \
    "$migration_rollback_failure_root" "$migration_rollback_failure_state" \
    "$migration_rollback_failure_transaction"
done

# Rollback publishes `finalized` only after the exact legacy service is active,
# healthy and enabled. Enable failure must re-enter a transaction-owned block;
# crashes at the final 0400 temp or rename->directory-fsync boundaries must
# retain the committed rollback topology and converge under the same action.
migration_rollback_enable_root="$temporary/migration-rollback-enable-failure-root"
migration_rollback_enable_state="$temporary/migration-rollback-enable-failure-state"
migration_rollback_enable_nonce=migrationrollbackenablenonce000000000001
create_legacy_migration_fixture \
  "$migration_rollback_enable_root" "$migration_rollback_enable_nonce" \
  "$migration_rollback_enable_state"
migration_rollback_enable_digest=$LEGACY_MIGRATION_DIGEST
migration_rollback_enable_transaction="$(fresh_admin_migration_transaction \
  "$migration_rollback_enable_digest")"
migration_rollback_enable_journal="$migration_rollback_enable_root/var/lib/agent-os-ops/private/$migration_rollback_enable_transaction"
expect_admin_migration_sigkill \
  'rollback enable-failure seed' phase-temp:daemon_reloaded \
  "$migration_rollback_enable_root" "$migration_rollback_enable_nonce" \
  "$migration_rollback_enable_state" "$migration_rollback_enable_digest"
printf '%s\n' legacy-release >"$AGENT_OS_MOCK_FAIL_ENABLE_REVISION"
if run_admin_migration \
  "$migration_rollback_enable_root" "$migration_rollback_enable_nonce" \
  "$migration_rollback_enable_state" "$migration_rollback_enable_digest" \
  --rollback >/dev/null 2>&1; then
  fail 'rollback accepted service-enable failure'
fi
[[ ! -e "$AGENT_OS_MOCK_FAIL_ENABLE_REVISION" && \
  -f "$migration_rollback_enable_journal/rolled_back" && \
  ! -e "$migration_rollback_enable_journal/finalized" ]] ||
  fail 'rollback enable failure did not stop before terminal publication'
migration_rollback_enable_block="$migration_rollback_enable_root/var/lib/agent-os-ops/hub-block"
[[ ! -e "$migration_rollback_enable_root/run/agent-os/hub-maintenance" ]] ||
  fail 'rollback enable failure recreated normal maintenance'
[[ -f "$migration_rollback_enable_root/run/agent-os/hub-maintenance-hard" && \
  ! -L "$migration_rollback_enable_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'rollback enable failure did not retain regular hard maintenance'
[[ -f "$migration_rollback_enable_block" && \
  ! -L "$migration_rollback_enable_block" ]] ||
  fail 'rollback enable failure lost its regular durable block'
[[ "$(<"$migration_rollback_enable_block")" == \
  "agent-os-hub-recovery-block-v1:$migration_rollback_enable_transaction" ]] ||
  fail 'rollback enable failure durable block transaction changed'
[[ ! -e "$migration_rollback_enable_root/run/agent-os/hub-recovery-start" ]] ||
  fail 'rollback enable failure left recovery-start authorization published'
[[ ! -f "$migration_rollback_enable_state/active.agent-os-hub.service" ]] ||
  fail 'rollback enable failure left the service active'
[[ ! -f "$migration_rollback_enable_state/enabled.agent-os-hub.service" ]] ||
  fail 'rollback enable failure left the service enabled'
run_admin_migration \
  "$migration_rollback_enable_root" "$migration_rollback_enable_nonce" \
  "$migration_rollback_enable_state" "$migration_rollback_enable_digest" \
  --rollback >/dev/null ||
  fail 'rollback enable failure did not converge on same-action retry'
assert_migration_phase \
  "$migration_rollback_enable_journal" \
  "$migration_rollback_enable_transaction" finalized
assert_migration_guards_clean "$migration_rollback_enable_root"
[[ -f "$migration_rollback_enable_state/active.agent-os-hub.service" && \
  -f "$migration_rollback_enable_state/enabled.agent-os-hub.service" ]] ||
  fail 'rollback enable retry did not finish active+enabled'

for migration_rollback_final_boundary in temp dir; do
  migration_rollback_final_label="rollback-finalized-$migration_rollback_final_boundary"
  migration_rollback_final_root="$temporary/migration-$migration_rollback_final_label-root"
  migration_rollback_final_state="$temporary/migration-$migration_rollback_final_label-state"
  migration_rollback_final_nonce="migrationrollbackfinal${migration_rollback_final_boundary}nonce000000000001"
  create_legacy_migration_fixture \
    "$migration_rollback_final_root" "$migration_rollback_final_nonce" \
    "$migration_rollback_final_state"
  migration_rollback_final_digest=$LEGACY_MIGRATION_DIGEST
  migration_rollback_final_transaction="$(fresh_admin_migration_transaction \
    "$migration_rollback_final_digest")"
  migration_rollback_final_journal="$migration_rollback_final_root/var/lib/agent-os-ops/private/$migration_rollback_final_transaction"
  expect_admin_migration_sigkill \
    "$migration_rollback_final_label seed" phase-temp:daemon_reloaded \
    "$migration_rollback_final_root" "$migration_rollback_final_nonce" \
    "$migration_rollback_final_state" "$migration_rollback_final_digest"
  expect_admin_migration_sigkill \
    "$migration_rollback_final_label" \
    "phase-$migration_rollback_final_boundary:finalized" \
    "$migration_rollback_final_root" "$migration_rollback_final_nonce" \
    "$migration_rollback_final_state" "$migration_rollback_final_digest" \
    --rollback
  [[ -f "$migration_rollback_final_journal/rolled_back" && \
    -f "$migration_rollback_final_state/active.agent-os-hub.service" && \
    -f "$migration_rollback_final_state/enabled.agent-os-hub.service" && \
    ! -e "$migration_rollback_final_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$migration_rollback_final_root/run/agent-os/hub-maintenance" && \
    ! -e "$migration_rollback_final_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "$migration_rollback_final_label lost its terminal service or guard topology"
  if [[ "$migration_rollback_final_boundary" == temp ]]; then
    shopt -s nullglob
    migration_rollback_final_temporaries=(
      "$migration_rollback_final_journal"/.finalized-*.tmp
    )
    shopt -u nullglob
    [[ "${#migration_rollback_final_temporaries[@]}" == 1 && \
      ! -e "$migration_rollback_final_journal/finalized" ]] ||
      fail "$migration_rollback_final_label did not retain one private final temporary"
  else
    assert_migration_phase \
      "$migration_rollback_final_journal" \
      "$migration_rollback_final_transaction" finalized
  fi
  run_admin_migration \
    "$migration_rollback_final_root" "$migration_rollback_final_nonce" \
    "$migration_rollback_final_state" "$migration_rollback_final_digest" \
    --rollback >/dev/null ||
    fail "$migration_rollback_final_label did not converge on same-action retry"
  assert_migration_phase \
    "$migration_rollback_final_journal" \
    "$migration_rollback_final_transaction" finalized
  assert_migration_guards_clean "$migration_rollback_final_root"
  [[ -f "$migration_rollback_final_state/active.agent-os-hub.service" && \
    -f "$migration_rollback_final_state/enabled.agent-os-hub.service" ]] ||
    fail "$migration_rollback_final_label retry did not remain active+enabled"
done

for migration_rollback_phase in rollback_started rolled_back; do
  for migration_rollback_phase_boundary in temp dir; do
    migration_rollback_phase_label="rollback-$migration_rollback_phase-$migration_rollback_phase_boundary"
    migration_rollback_phase_root="$temporary/migration-$migration_rollback_phase_label-root"
    migration_rollback_phase_state="$temporary/migration-$migration_rollback_phase_label-state"
    migration_rollback_phase_nonce="migrationrollback${migration_rollback_phase//_/}${migration_rollback_phase_boundary}nonce0000001"
    create_legacy_migration_fixture \
      "$migration_rollback_phase_root" "$migration_rollback_phase_nonce" \
      "$migration_rollback_phase_state"
    migration_rollback_phase_digest=$LEGACY_MIGRATION_DIGEST
    migration_rollback_phase_transaction="$(fresh_admin_migration_transaction \
      "$migration_rollback_phase_digest")"
    migration_rollback_phase_journal="$migration_rollback_phase_root/var/lib/agent-os-ops/private/$migration_rollback_phase_transaction"
    expect_admin_migration_sigkill \
      "$migration_rollback_phase_label seed" phase-temp:daemon_reloaded \
      "$migration_rollback_phase_root" "$migration_rollback_phase_nonce" \
      "$migration_rollback_phase_state" "$migration_rollback_phase_digest"
    expect_admin_migration_sigkill \
      "$migration_rollback_phase_label" \
      "phase-$migration_rollback_phase_boundary:$migration_rollback_phase" \
      "$migration_rollback_phase_root" "$migration_rollback_phase_nonce" \
      "$migration_rollback_phase_state" "$migration_rollback_phase_digest" \
      --rollback
    assert_migration_fail_closed_after_kill \
      "$migration_rollback_phase_label" "$migration_rollback_phase_root" \
      "$migration_rollback_phase_state" "$migration_rollback_phase_transaction"
    if [[ "$migration_rollback_phase_boundary" == temp ]]; then
      shopt -s nullglob
      migration_rollback_phase_temporaries=(
        "$migration_rollback_phase_journal"/."$migration_rollback_phase"-*.tmp
      )
      shopt -u nullglob
      [[ "${#migration_rollback_phase_temporaries[@]}" == 1 && \
        ! -e "$migration_rollback_phase_journal/$migration_rollback_phase" ]] ||
        fail "$migration_rollback_phase_label did not retain one private phase temporary"
    else
      assert_migration_phase \
        "$migration_rollback_phase_journal" \
        "$migration_rollback_phase_transaction" \
        "$migration_rollback_phase"
    fi
    run_admin_migration \
      "$migration_rollback_phase_root" "$migration_rollback_phase_nonce" \
      "$migration_rollback_phase_state" "$migration_rollback_phase_digest" \
      --rollback >/dev/null ||
      fail "$migration_rollback_phase_label did not converge on retry"
    assert_migration_phase \
      "$migration_rollback_phase_journal" \
      "$migration_rollback_phase_transaction" finalized
    assert_migration_guards_clean "$migration_rollback_phase_root"
  done
done

for migration_grammar_case in \
  forward-gap rollback-missing-prefix rolled-back-without-start \
  finalized-without-terminal dual-terminal rollback-prefix-gap \
  forward-late-gap; do
  migration_grammar_root="$temporary/migration-grammar-$migration_grammar_case-root"
  migration_grammar_state="$temporary/migration-grammar-$migration_grammar_case-state"
  migration_grammar_nonce="migrationgrammar${migration_grammar_case//-/}nonce000000000001"
  create_legacy_migration_fixture \
    "$migration_grammar_root" "$migration_grammar_nonce" \
    "$migration_grammar_state"
  migration_grammar_digest=$LEGACY_MIGRATION_DIGEST
  migration_grammar_transaction="$(fresh_admin_migration_transaction \
    "$migration_grammar_digest")"
  migration_grammar_journal="$migration_grammar_root/var/lib/agent-os-ops/private/$migration_grammar_transaction"
  migration_grammar_action=forward
  case "$migration_grammar_case" in
    forward-gap)
      expect_admin_migration_sigkill \
        "$migration_grammar_case seed" phase-dir:stopped \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      rm -f -- "$migration_grammar_journal/blocked"
      ;;
    rollback-missing-prefix)
      expect_admin_migration_sigkill \
        "$migration_grammar_case forward seed" phase-dir:daemon_reloaded \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      expect_admin_migration_sigkill \
        "$migration_grammar_case rollback seed" phase-dir:rollback_started \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest" --rollback
      rm -f -- "$migration_grammar_journal/stopped"
      migration_grammar_action=rollback
      ;;
    rolled-back-without-start)
      expect_admin_migration_sigkill \
        "$migration_grammar_case forward seed" phase-dir:daemon_reloaded \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      expect_admin_migration_sigkill \
        "$migration_grammar_case rollback seed" phase-dir:rolled_back \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest" --rollback
      rm -f -- "$migration_grammar_journal/rollback_started"
      migration_grammar_action=rollback
      ;;
    finalized-without-terminal)
      expect_admin_migration_sigkill \
        "$migration_grammar_case seed" phase-dir:finalized \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      rm -f -- "$migration_grammar_journal/committed"
      ;;
    dual-terminal)
      expect_admin_migration_sigkill \
        "$migration_grammar_case seed" phase-dir:committed \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      write_migration_phase_fixture \
        "$migration_grammar_journal" "$migration_grammar_transaction" rolled_back
      ;;
    rollback-prefix-gap)
      expect_admin_migration_sigkill \
        "$migration_grammar_case forward seed" phase-dir:daemon_reloaded \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      expect_admin_migration_sigkill \
        "$migration_grammar_case rollback seed" phase-dir:rollback_started \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest" --rollback
      rm -f -- "$migration_grammar_journal/prepared"
      migration_grammar_action=rollback
      ;;
    forward-late-gap)
      expect_admin_migration_sigkill \
        "$migration_grammar_case seed" phase-dir:enabled \
        "$migration_grammar_root" "$migration_grammar_nonce" \
        "$migration_grammar_state" "$migration_grammar_digest"
      rm -f -- "$migration_grammar_journal/verified"
      ;;
  esac
  assert_invalid_migration_journal_preflight \
    "$migration_grammar_case" "$migration_grammar_root" \
    "$migration_grammar_nonce" "$migration_grammar_state" \
    "$migration_grammar_digest" "$migration_grammar_action" \
    'Hub deployment failed: admin migration history journal is invalid'
done

# The migration must stop and disable the legacy writer before inspecting its
# replay state. An assigned task is therefore rejected under the durable block,
# but before any current-source payload, runtime contract or admin tree moves.
migration_active_root="$temporary/migration-active-root"
migration_active_state="$temporary/migration-active-state"
migration_active_nonce=migrationactivenonce000000000000000001
create_legacy_migration_fixture \
  "$migration_active_root" "$migration_active_nonce" "$migration_active_state"
write_migration_state_fixture "$migration_active_root/var/lib/agent-os/hub" active
migration_active_digest=$LEGACY_MIGRATION_DIGEST
migration_active_transaction="$(fresh_admin_migration_transaction \
  "$migration_active_digest")"
migration_active_artifact_id="$(admin_migration_artifact_id \
  "$migration_active_transaction")"
migration_active_journal="$migration_active_root/var/lib/agent-os-ops/private/$migration_active_transaction"
migration_active_state_hash="$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" \
  "$migration_active_root/var/lib/agent-os/hub")"
migration_active_error="$temporary/migration-active.err"
if run_admin_migration \
  "$migration_active_root" "$migration_active_nonce" \
  "$migration_active_state" "$migration_active_digest" \
  >/dev/null 2>"$migration_active_error"; then
  fail 'legacy admin migration accepted assigned work after writer stop'
fi
[[ "$(<"$migration_active_error")" == \
  $'Hub state snapshot failed: active_tasks_present\nHub deployment failed: legacy Hub state is corrupt or contains active work after writer stop' ]] ||
  fail 'legacy admin migration active-work rejection was not exact'
assert_migration_writer_proof "$migration_active_root" "$migration_active_state"
for migration_phase in disabled blocked stopped; do
  assert_migration_phase \
    "$migration_active_journal" "$migration_active_transaction" "$migration_phase"
done
[[ -f "$migration_active_journal/intent" && \
  ! -e "$migration_active_journal/metadata" && \
  ! -e "$migration_active_journal/prepared" && \
  ! -e "$migration_active_journal/old-runtime" && \
  ! -e "$migration_active_journal/new-runtime" && \
  ! -e "$migration_active_root/usr/libexec/agent-os/.hub-admin-migration-$migration_active_artifact_id" && \
  ! -e "$migration_active_root/usr/libexec/agent-os/hub.legacy-$migration_active_artifact_id" && \
  ! -e "$migration_active_root/usr/libexec/agent-os/hub.failed-migration-$migration_active_artifact_id" ]] ||
  fail 'active-work migration staged or moved a payload before replay rejection'
[[ "$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
  --canonical-root-owner "$migration_active_root/usr/libexec/agent-os/hub" | \
  "$REAL_NODE_BIN" -e \
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" == \
    "$migration_active_digest" ]] ||
  fail 'active-work migration changed the pinned legacy admin kit'
assert_migration_runtime_set "$migration_active_root" "$legacy_admin_source" ||
  fail 'active-work migration changed the pinned legacy runtime contract'
[[ "$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" \
  "$migration_active_root/var/lib/agent-os/hub")" == "$migration_active_state_hash" ]] ||
  fail 'active-work migration changed the assigned state tree'
if grep -Eq '^(daemon-reload|start|enable)( |$)' \
  "$migration_active_state/systemctl.log"; then
  fail 'active-work migration reloaded or started a runtime after replay rejection'
fi
[[ -f "$migration_active_root/var/lib/agent-os-ops/hub-block" && \
  "$(<"$migration_active_root/var/lib/agent-os-ops/hub-block")" == \
    "agent-os-hub-recovery-block-v1:$migration_active_transaction" && \
  -f "$migration_active_root/run/agent-os/hub-maintenance" && \
  -f "$migration_active_root/run/agent-os/hub-maintenance-hard" && \
  ! -e "$migration_active_root/run/agent-os/hub-recovery-start" && \
  ! -f "$migration_active_state/active.agent-os-hub.service" && \
  ! -f "$migration_active_state/enabled.agent-os-hub.service" ]] ||
  fail 'active-work migration did not remain inactive, disabled and durably blocked'

# This failure is still safely reversible because no payload was prepared.
# Prove both the first explicit rollback and its terminal idempotent retry.
run_admin_migration \
  "$migration_active_root" "$migration_active_nonce" \
  "$migration_active_state" "$migration_active_digest" --rollback >/dev/null ||
  fail 'pre-prepare admin migration rollback failed'
assert_migration_phase \
  "$migration_active_journal" "$migration_active_transaction" rolled_back
assert_migration_phase \
  "$migration_active_journal" "$migration_active_transaction" rollback_started
assert_migration_phase \
  "$migration_active_journal" "$migration_active_transaction" finalized
assert_migration_guards_clean "$migration_active_root"
[[ -f "$migration_active_state/active.agent-os-hub.service" && \
  -f "$migration_active_state/enabled.agent-os-hub.service" ]] ||
  fail 'pre-prepare admin migration rollback did not restore active+enabled service state'
migration_active_admin_hash="$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" \
  "$migration_active_root/usr/libexec/agent-os/hub")"
migration_active_journal_hash="$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" \
  "$migration_active_journal")"
run_admin_migration \
  "$migration_active_root" "$migration_active_nonce" \
  "$migration_active_state" "$migration_active_digest" --rollback >/dev/null ||
  fail 'finalized pre-prepare admin migration rollback was not retryable'
[[ "$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" \
  "$migration_active_root/usr/libexec/agent-os/hub")" == \
    "$migration_active_admin_hash" && \
  "$($REAL_NODE_BIN "$HUB_ROOT/bin/state-hash.mjs" \
  "$migration_active_journal")" == "$migration_active_journal_hash" ]] ||
  fail 'pre-prepare admin migration rollback retry changed its kit or journal'

# A journal created by the previously shipped fixed transaction name is
# immutable implicit attempt 1. It remains resumable, but all newly created
# journals below use the version-2 full-digest attempt grammar.
migration_legacy_compat_root="$temporary/migration-legacy-journal-root"
migration_legacy_compat_state="$temporary/migration-legacy-journal-state"
migration_legacy_compat_nonce=migrationlegacyjournalnonce0000000000001
create_legacy_migration_fixture \
  "$migration_legacy_compat_root" "$migration_legacy_compat_nonce" \
  "$migration_legacy_compat_state"
migration_legacy_compat_digest=$LEGACY_MIGRATION_DIGEST
migration_legacy_compat_transaction="upgrade-admin-migration-${migration_legacy_compat_digest:0:32}"
migration_legacy_compat_journal="$migration_legacy_compat_root/var/lib/agent-os-ops/private/$migration_legacy_compat_transaction"
write_valid_admin_migration_intent_artifact \
  "$migration_legacy_compat_root" "$migration_legacy_compat_digest" final
run_admin_migration \
  "$migration_legacy_compat_root" "$migration_legacy_compat_nonce" \
  "$migration_legacy_compat_state" "$migration_legacy_compat_digest" \
  >/dev/null || fail 'legacy version-1 migration journal did not resume'
assert_migration_forward_completed \
  'legacy version-1 migration journal' "$migration_legacy_compat_root" \
  "$migration_legacy_compat_state"
[[ -f "$migration_legacy_compat_journal/committed" && \
  -f "$migration_legacy_compat_journal/finalized" ]] ||
  fail 'legacy version-1 migration journal lost its fixed transaction history'

migration_success_root="$temporary/migration-success-root"
migration_success_state="$temporary/migration-success-state"
migration_success_nonce=migrationsuccessnonce000000000000000001
create_legacy_migration_fixture \
  "$migration_success_root" "$migration_success_nonce" "$migration_success_state"
migration_success_digest=$LEGACY_MIGRATION_DIGEST
migration_success_env_fingerprint="$(migration_fixture_fingerprint \
  "$migration_success_root/etc/agent-os/hub.env")"
migration_success_current_target="$(readlink \
  "$migration_success_root/opt/agent-os/current")"
migration_success_previous_target="$(readlink \
  "$migration_success_root/opt/agent-os/previous")"
migration_success_state_fingerprint="$(migration_state_contract_fingerprint \
  "$migration_success_root/var/lib/agent-os/hub")" ||
  fail 'successful migration fixture state could not be fingerprinted'
migration_success_transaction="$(fresh_admin_migration_transaction \
  "$migration_success_digest")"
migration_success_artifact_id="$(admin_migration_artifact_id \
  "$migration_success_transaction")"
migration_success_journal="$migration_success_root/var/lib/agent-os-ops/private/$migration_success_transaction"
rm -f -- "$AGENT_OS_MOCK_FAIL_DAEMON_ONCE"
run_admin_migration \
  "$migration_success_root" "$migration_success_nonce" \
  "$migration_success_state" "$migration_success_digest" >/dev/null ||
  fail 'real legacy admin migration failed'
assert_migration_attempt_intent \
  "$migration_success_journal" "$migration_success_transaction" 1 \
  none none "$migration_success_digest"
assert_current_migration_kit "$migration_success_root"
assert_migration_runtime_set "$migration_success_root" "$HUB_ROOT" ||
  fail 'admin migration runtime files are not byte-identical to the audited source'
assert_migration_writer_proof \
  "$migration_success_root" "$migration_success_state"
[[ "$(migration_fixture_fingerprint \
    "$migration_success_root/etc/agent-os/hub.env")" == \
    "$migration_success_env_fingerprint" && \
  "$(readlink "$migration_success_root/opt/agent-os/current")" == \
    "$migration_success_current_target" && \
  "$(readlink "$migration_success_root/opt/agent-os/previous")" == \
    "$migration_success_previous_target" && \
  "$(migration_state_contract_fingerprint \
    "$migration_success_root/var/lib/agent-os/hub")" == \
    "$migration_success_state_fingerprint" ]] ||
  fail 'admin migration changed the state, secret environment or application pointers'
for migration_phase in \
  disabled blocked stopped prepared runtime_activated admin_activated daemon_reloaded \
  started verified enabled committed finalized; do
  assert_migration_phase \
    "$migration_success_journal" "$migration_success_transaction" "$migration_phase"
done
migration_success_old_runtime_summary="$($REAL_NODE_BIN \
  "$HUB_ROOT/bin/tree-digest.mjs" --canonical-root-owner \
  "$migration_success_journal/old-runtime")" ||
  fail 'successful admin migration old-runtime payload could not be fingerprinted'
"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  const summary = JSON.parse(process.argv[1]);
  const metadata = Object.fromEntries(
    fs.readFileSync(process.argv[2], "utf8").trimEnd().split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  if (summary.entryCount !== 5 || summary.fileCount !== 5 ||
      summary.totalBytes !== 8233 || summary.treeSha256 !== process.argv[3] ||
      metadata.version !== "1" || metadata.transaction !== process.argv[4] ||
      metadata.old_runtime_sha256 !== process.argv[3] ||
      !/^[a-f0-9]{64}$/u.test(metadata.new_admin_sha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(metadata.new_runtime_sha256 ?? "")) {
    process.exit(1);
  }
' "$migration_success_old_runtime_summary" \
  "$migration_success_journal/metadata" \
  "$EXPECTED_LEGACY_RUNTIME_PRODUCTION_SHA256" \
  "$migration_success_transaction" ||
  fail 'admin migration metadata did not bind the canonical legacy runtime digest'
legacy_preserved="$migration_success_root/usr/libexec/agent-os/hub.legacy-$migration_success_artifact_id"
[[ -d "$legacy_preserved" && ! -L "$legacy_preserved" && \
  "$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
    --canonical-root-owner "$legacy_preserved" | \
    "$REAL_NODE_BIN" -e \
      'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" == \
    "$migration_success_digest" ]] ||
  fail 'successful admin migration did not preserve the unique legacy kit'
assert_migration_guards_clean "$migration_success_root"
[[ -f "$migration_success_state/active.agent-os-hub.service" && \
  -f "$migration_success_state/enabled.agent-os-hub.service" ]] ||
  fail 'successful admin migration did not sign off active+enabled service state'

migration_success_terminal_root_before="$(migration_fixture_fingerprint \
  "$migration_success_root")" ||
  fail 'finalized forward migration root could not be fingerprinted'
migration_success_terminal_control_before="$(migration_control_state_fingerprint \
  "$migration_success_state")" ||
  fail 'finalized forward control state could not be fingerprinted'
migration_success_terminal_log_before="$(wc -l \
  <"$migration_success_state/systemctl.log" | tr -d ' ')"
run_admin_migration \
  "$migration_success_root" "$migration_success_nonce" \
  "$migration_success_state" "$migration_success_digest" >/dev/null ||
  fail 'finalized admin migration was not idempotently retryable'
[[ "$(migration_fixture_fingerprint "$migration_success_root")" == \
    "$migration_success_terminal_root_before" && \
  "$(migration_control_state_fingerprint "$migration_success_state")" == \
    "$migration_success_terminal_control_before" ]] ||
  fail 'idempotent forward retry changed env/state/pointers/admin/runtime/layout metadata'
assert_no_service_mutation_since \
  'idempotent forward retry' "$migration_success_state" \
  "$migration_success_terminal_log_before"

migration_success_opposite_root_before="$(migration_fixture_fingerprint \
  "$migration_success_root")"
migration_success_opposite_control_before="$(migration_control_state_fingerprint \
  "$migration_success_state")"
migration_success_opposite_log_before="$(wc -l \
  <"$migration_success_state/systemctl.log" | tr -d ' ')"
migration_success_opposite_error="$temporary/migration-success-opposite.err"
if run_admin_migration \
  "$migration_success_root" "$migration_success_nonce" \
  "$migration_success_state" "$migration_success_digest" --rollback \
  >/dev/null 2>"$migration_success_opposite_error"; then
  fail 'finalized committed migration accepted rollback action'
fi
[[ "$(<"$migration_success_opposite_error")" == \
    'Hub deployment failed: a committed admin migration can only be finalized forward' && \
  "$(migration_fixture_fingerprint "$migration_success_root")" == \
    "$migration_success_opposite_root_before" && \
  "$(migration_control_state_fingerprint "$migration_success_state")" == \
    "$migration_success_opposite_control_before" ]] ||
  fail 'finalized committed opposite-action rejection mutated terminal state'
assert_no_service_mutation_since \
  'finalized committed opposite action' "$migration_success_state" \
  "$migration_success_opposite_log_before"

# A finalized transaction is validation-only. Inactive, unhealthy or disabled
# terminal service state must fail without attempting repair or changing any
# deployment/state byte. The operator must restore the external service
# contract explicitly before a retry can pass.
for migration_terminal_fault in inactive unhealthy disabled; do
  migration_terminal_fault_root_before="$(migration_fixture_fingerprint \
    "$migration_success_root")"
  migration_terminal_fault_log_before="$(wc -l \
    <"$migration_success_state/systemctl.log" | tr -d ' ')"
  migration_terminal_fault_error="$temporary/migration-terminal-$migration_terminal_fault.err"
  case "$migration_terminal_fault" in
    inactive)
      rm -f -- "$migration_success_state/active.agent-os-hub.service"
      ;;
    unhealthy)
      printf '%s\n' legacy-release >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
      ;;
    disabled)
      rm -f -- "$migration_success_state/enabled.agent-os-hub.service"
      ;;
  esac
  migration_terminal_fault_control_before="$(migration_control_state_fingerprint \
    "$migration_success_state")"
  if run_admin_migration \
    "$migration_success_root" "$migration_success_nonce" \
    "$migration_success_state" "$migration_success_digest" \
    >/dev/null 2>"$migration_terminal_fault_error"; then
    fail "finalized migration accepted $migration_terminal_fault service state"
  fi
  [[ "$(tail -n 1 "$migration_terminal_fault_error")" == \
      'Hub deployment failed: finalized admin migration no longer matches its terminal state' && \
    "$(migration_fixture_fingerprint "$migration_success_root")" == \
      "$migration_terminal_fault_root_before" && \
    "$(migration_control_state_fingerprint "$migration_success_state")" == \
      "$migration_terminal_fault_control_before" ]] ||
    fail "finalized $migration_terminal_fault rejection mutated terminal state or emitted the wrong diagnosis"
  assert_no_service_mutation_since \
    "finalized $migration_terminal_fault rejection" \
    "$migration_success_state" "$migration_terminal_fault_log_before"
  case "$migration_terminal_fault" in
    inactive)
      printf '%s\n' 417300 \
        >"$migration_success_state/active.agent-os-hub.service"
      ;;
    unhealthy)
      rm -f -- "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
      ;;
    disabled)
      : >"$migration_success_state/enabled.agent-os-hub.service"
      ;;
  esac
done

for migration_terminal_kit_fault in hardlink root-group file-group; do
  if [[ "$migration_terminal_kit_fault" == *-group && \
    -z "$migration_wrong_group_gid" ]]; then
    continue
  fi
  migration_terminal_kit_path=
  migration_terminal_kit_peer=
  migration_terminal_kit_parent=
  case "$migration_terminal_kit_fault" in
    hardlink)
      migration_terminal_kit_path="$migration_success_root/usr/libexec/agent-os/hub/env.example"
      migration_terminal_kit_peer="$migration_success_root/usr/libexec/agent-os/hub/env.example.terminal-peer"
      migration_terminal_kit_parent=${migration_terminal_kit_path%/*}
      [[ "$(stat -c '%a' "$migration_terminal_kit_parent")" == 555 ]] ||
        fail 'finalized current-kit hardlink parent was not mode 0555 before fixture setup'
      chmod 0755 "$migration_terminal_kit_parent"
      if ! ln "$migration_terminal_kit_path" "$migration_terminal_kit_peer"; then
        chmod 0555 "$migration_terminal_kit_parent"
        fail 'finalized current-kit hardlink fixture could not be created'
      fi
      chmod 0555 "$migration_terminal_kit_parent"
      [[ "$(stat -c '%a' "$migration_terminal_kit_parent")" == 555 ]] ||
        fail 'finalized current-kit hardlink parent was not restored after fixture setup'
      ;;
    root-group)
      migration_terminal_kit_path="$migration_success_root/usr/libexec/agent-os/hub"
      /usr/bin/chgrp "$migration_wrong_group_gid" "$migration_terminal_kit_path"
      ;;
    file-group)
      migration_terminal_kit_path="$migration_success_root/usr/libexec/agent-os/hub/env.example"
      /usr/bin/chgrp "$migration_wrong_group_gid" "$migration_terminal_kit_path"
      ;;
  esac
  migration_terminal_kit_root_before="$(migration_fixture_fingerprint \
    "$migration_success_root")"
  migration_terminal_kit_control_before="$(migration_control_state_fingerprint \
    "$migration_success_state")"
  migration_terminal_kit_log_before="$(wc -l \
    <"$migration_success_state/systemctl.log" | tr -d ' ')"
  migration_terminal_kit_error="$temporary/migration-terminal-kit-$migration_terminal_kit_fault.err"
  migration_terminal_kit_root_inventory_before="$migration_terminal_kit_error.root-before"
  migration_terminal_kit_root_inventory_after="$migration_terminal_kit_error.root-after"
  migration_terminal_kit_state_inventory_before="$migration_terminal_kit_error.state-before"
  migration_terminal_kit_state_inventory_after="$migration_terminal_kit_error.state-after"
  migration_terminal_kit_systemctl_before="$migration_terminal_kit_error.systemctl-before"
  migration_fixture_inventory "$migration_success_root" \
    >"$migration_terminal_kit_root_inventory_before"
  migration_fixture_inventory "$migration_success_state" \
    >"$migration_terminal_kit_state_inventory_before"
  cp "$migration_success_state/systemctl.log" \
    "$migration_terminal_kit_systemctl_before"
  if run_admin_migration \
    "$migration_success_root" "$migration_success_nonce" \
    "$migration_success_state" "$migration_success_digest" \
    >/dev/null 2>"$migration_terminal_kit_error"; then
    fail "finalized migration accepted current-kit $migration_terminal_kit_fault drift"
  fi
  migration_terminal_kit_diagnostic_expected='Hub deployment failed: frozen admin migration candidate topology changed'
  migration_terminal_kit_diagnostic_actual="$(tail -n 1 \
    "$migration_terminal_kit_error")"
  if [[ "$migration_terminal_kit_diagnostic_actual" != \
    "$migration_terminal_kit_diagnostic_expected" ]]; then
    migration_terminal_kit_diagnostic_actual=${migration_terminal_kit_diagnostic_actual//$migration_success_root/<test-root>}
    migration_terminal_kit_diagnostic_actual=${migration_terminal_kit_diagnostic_actual//$HUB_ROOT/<source-root>}
    if ((${#migration_terminal_kit_diagnostic_actual} > 512)) || \
      [[ "$migration_terminal_kit_diagnostic_actual" == *$'\r'* ]]; then
      migration_terminal_kit_diagnostic_actual=redacted-too-long
    fi
    fail "finalized current-kit $migration_terminal_kit_fault diagnostic changed: actual=[$migration_terminal_kit_diagnostic_actual] expected=[$migration_terminal_kit_diagnostic_expected]"
  fi
  migration_terminal_kit_root_after="$(migration_fixture_fingerprint \
    "$migration_success_root")"
  if [[ "$migration_terminal_kit_root_after" != \
    "$migration_terminal_kit_root_before" ]]; then
    migration_fixture_inventory "$migration_success_root" \
      >"$migration_terminal_kit_root_inventory_after"
    diff -u \
      "$migration_terminal_kit_root_inventory_before" \
      "$migration_terminal_kit_root_inventory_after" | head -n 16 >&2 || true
    fail "finalized current-kit $migration_terminal_kit_fault rejection changed the installation root"
  fi
  migration_terminal_kit_control_after="$(migration_control_state_fingerprint \
    "$migration_success_state")"
  if [[ "$migration_terminal_kit_control_after" != \
    "$migration_terminal_kit_control_before" ]]; then
    migration_fixture_inventory "$migration_success_state" \
      >"$migration_terminal_kit_state_inventory_after"
    diff -u \
      "$migration_terminal_kit_state_inventory_before" \
      "$migration_terminal_kit_state_inventory_after" | head -n 16 >&2 || true
    if ! cmp -s \
      "$migration_terminal_kit_systemctl_before" \
      "$migration_success_state/systemctl.log"; then
      diff -u \
        "$migration_terminal_kit_systemctl_before" \
        "$migration_success_state/systemctl.log" | head -n 12 >&2 || true
    fi
    fail "finalized current-kit $migration_terminal_kit_fault rejection changed process-control state"
  fi
  assert_no_service_mutation_since \
    "finalized current-kit $migration_terminal_kit_fault rejection" \
    "$migration_success_state" "$migration_terminal_kit_log_before"
  case "$migration_terminal_kit_fault" in
    hardlink)
      [[ "$(stat -c '%a' "$migration_terminal_kit_parent")" == 555 ]] ||
        fail 'finalized current-kit hardlink parent changed before fixture cleanup'
      chmod 0755 "$migration_terminal_kit_parent"
      if ! rm -f -- "$migration_terminal_kit_peer"; then
        chmod 0555 "$migration_terminal_kit_parent"
        fail 'finalized current-kit hardlink fixture could not be removed'
      fi
      chmod 0555 "$migration_terminal_kit_parent"
      [[ "$(stat -c '%a' "$migration_terminal_kit_parent")" == 555 ]] ||
        fail 'finalized current-kit hardlink parent was not restored after fixture cleanup'
      ;;
    root-group | file-group)
      /usr/bin/chgrp "$migration_caller_gid" "$migration_terminal_kit_path"
      ;;
  esac
done
for migration_terminal_unit_fault in fragment dropin reload; do
  assert_finalized_effective_unit_rejected \
    'finalized forward' \
    "$migration_success_root" "$migration_success_nonce" \
    "$migration_success_state" "$migration_success_digest" \
    forward "$migration_terminal_unit_fault"
done

migration_rollback_root="$temporary/migration-rollback-root"
migration_rollback_state="$temporary/migration-rollback-state"
migration_rollback_nonce=migrationrollbacknonce0000000000000001
create_legacy_migration_fixture \
  "$migration_rollback_root" "$migration_rollback_nonce" "$migration_rollback_state"
migration_rollback_digest=$LEGACY_MIGRATION_DIGEST
migration_rollback_env_fingerprint="$(migration_fixture_fingerprint \
  "$migration_rollback_root/etc/agent-os/hub.env")"
migration_rollback_current_target="$(readlink \
  "$migration_rollback_root/opt/agent-os/current")"
migration_rollback_previous_target="$(readlink \
  "$migration_rollback_root/opt/agent-os/previous")"
migration_rollback_state_fingerprint="$(migration_state_contract_fingerprint \
  "$migration_rollback_root/var/lib/agent-os/hub")" ||
  fail 'rollback migration fixture state could not be fingerprinted'
migration_rollback_transaction="$(fresh_admin_migration_transaction \
  "$migration_rollback_digest")"
migration_rollback_artifact_id="$(admin_migration_artifact_id \
  "$migration_rollback_transaction")"
migration_rollback_journal="$migration_rollback_root/var/lib/agent-os-ops/private/$migration_rollback_transaction"
: >"$AGENT_OS_MOCK_FAIL_DAEMON_ONCE"
if run_admin_migration \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" >/dev/null 2>&1; then
  fail 'admin migration accepted injected daemon-reload failure'
fi
[[ ! -e "$AGENT_OS_MOCK_FAIL_DAEMON_ONCE" && \
  -f "$migration_rollback_root/var/lib/agent-os-ops/hub-block" && \
  ! -f "$migration_rollback_state/active.agent-os-hub.service" && \
  ! -f "$migration_rollback_state/enabled.agent-os-hub.service" ]] ||
  fail 'failed admin migration did not remain disabled and fail closed'
run_admin_migration \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" --rollback >/dev/null ||
  fail 'explicit admin migration rollback failed'
assert_migration_attempt_intent \
  "$migration_rollback_journal" "$migration_rollback_transaction" 1 \
  none none "$migration_rollback_digest"
[[ "$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
  --canonical-root-owner "$migration_rollback_root/usr/libexec/agent-os/hub" | \
  "$REAL_NODE_BIN" -e \
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" == \
  "$migration_rollback_digest" ]] ||
  fail 'admin migration rollback did not restore the exact legacy kit'
assert_migration_runtime_set "$migration_rollback_root" "$legacy_admin_source" ||
  fail 'admin migration rollback did not restore exact legacy runtime files'
assert_migration_writer_proof \
  "$migration_rollback_root" "$migration_rollback_state"
[[ "$(migration_fixture_fingerprint \
    "$migration_rollback_root/etc/agent-os/hub.env")" == \
    "$migration_rollback_env_fingerprint" && \
  "$(readlink "$migration_rollback_root/opt/agent-os/current")" == \
    "$migration_rollback_current_target" && \
  "$(readlink "$migration_rollback_root/opt/agent-os/previous")" == \
    "$migration_rollback_previous_target" && \
  "$(migration_state_contract_fingerprint \
    "$migration_rollback_root/var/lib/agent-os/hub")" == \
    "$migration_rollback_state_fingerprint" ]] ||
  fail 'admin migration rollback changed the state, secret environment or application pointers'
for migration_phase in \
  disabled blocked stopped prepared rollback_started rolled_back finalized; do
  assert_migration_phase \
    "$migration_rollback_journal" "$migration_rollback_transaction" "$migration_phase"
done
[[ ! -e "$migration_rollback_journal/committed" && \
  ! -e "$migration_rollback_root/usr/libexec/agent-os/hub.legacy-$migration_rollback_artifact_id" && \
  -f "$migration_rollback_state/active.agent-os-hub.service" && \
  -f "$migration_rollback_state/enabled.agent-os-hub.service" ]] ||
  fail 'admin migration rollback retained an ambiguous kit or service state'
assert_migration_guards_clean "$migration_rollback_root"

migration_rollback_terminal_root_before="$(migration_fixture_fingerprint \
  "$migration_rollback_root")" ||
  fail 'finalized rollback root could not be fingerprinted'
migration_rollback_terminal_control_before="$(migration_control_state_fingerprint \
  "$migration_rollback_state")" ||
  fail 'finalized rollback control state could not be fingerprinted'
migration_rollback_terminal_log_before="$(wc -l \
  <"$migration_rollback_state/systemctl.log" | tr -d ' ')"
run_admin_migration \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" --rollback \
  >/dev/null || fail 'finalized rollback was not idempotently retryable'
[[ "$(migration_fixture_fingerprint "$migration_rollback_root")" == \
    "$migration_rollback_terminal_root_before" && \
  "$(migration_control_state_fingerprint "$migration_rollback_state")" == \
    "$migration_rollback_terminal_control_before" ]] ||
  fail 'idempotent rollback retry changed env/state/pointers/admin/runtime/layout metadata'
assert_no_service_mutation_since \
  'idempotent rollback retry' "$migration_rollback_state" \
  "$migration_rollback_terminal_log_before"

for migration_terminal_unit_fault in fragment dropin reload; do
  assert_finalized_effective_unit_rejected \
    'finalized rollback' \
    "$migration_rollback_root" "$migration_rollback_nonce" \
    "$migration_rollback_state" "$migration_rollback_digest" \
    rollback "$migration_terminal_unit_fault"
done

# A finalized rollback is immutable history, not a permanent migration veto.
# Bind a fresh second attempt to the exact first journal digest and prove the
# same machine can subsequently complete the supported migration without
# deleting or rewriting the rollback evidence.
migration_attempt_one_digest="$($REAL_NODE_BIN \
  "$HUB_ROOT/bin/tree-digest.mjs" --canonical-root-owner \
  "$migration_rollback_journal" | "$REAL_NODE_BIN" -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" ||
  fail 'rolled-back attempt journal could not be fingerprinted'
migration_attempt_two_transaction="$(fresh_admin_migration_transaction \
  "$migration_rollback_digest" 2)"
migration_attempt_two_journal="$migration_rollback_root/var/lib/agent-os-ops/private/$migration_attempt_two_transaction"
migration_attempt_two_source="$temporary/migration-attempt-two-source"
cp -R "$HUB_ROOT" "$migration_attempt_two_source"
printf '%s\n' '# attempt-two-source' >> \
  "$migration_attempt_two_source/nginx/agent-os-hub.conf"
for migration_predecessor_fault in inactive unhealthy disabled; do
  case "$migration_predecessor_fault" in
    inactive)
      rm -f -- "$migration_rollback_state/active.agent-os-hub.service"
      ;;
    unhealthy)
      printf '%s\n' legacy-release >"$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
      ;;
    disabled)
      rm -f -- "$migration_rollback_state/enabled.agent-os-hub.service"
      ;;
  esac
  migration_predecessor_root_before="$(migration_fixture_fingerprint \
    "$migration_rollback_root")"
  migration_predecessor_control_before="$(migration_control_state_fingerprint \
    "$migration_rollback_state")"
  migration_predecessor_log_before="$(wc -l \
    <"$migration_rollback_state/systemctl.log" | tr -d ' ')"
  migration_predecessor_error="$temporary/migration-predecessor-$migration_predecessor_fault.err"
  if run_admin_migration_from_source \
    "$migration_attempt_two_source" \
    "$migration_rollback_root" "$migration_rollback_nonce" \
    "$migration_rollback_state" "$migration_rollback_digest" \
    >/dev/null 2>"$migration_predecessor_error"; then
    fail "fresh attempt accepted a $migration_predecessor_fault predecessor"
  fi
  [[ "$(tail -n 1 "$migration_predecessor_error")" == \
      'Hub deployment failed: rolled-back admin migration no longer matches its terminal state' && \
    ! -e "$migration_attempt_two_journal" && \
    "$(migration_fixture_fingerprint "$migration_rollback_root")" == \
      "$migration_predecessor_root_before" && \
    "$(migration_control_state_fingerprint "$migration_rollback_state")" == \
      "$migration_predecessor_control_before" ]] ||
    fail "fresh attempt $migration_predecessor_fault rejection mutated its predecessor"
  assert_no_service_mutation_since \
    "fresh attempt $migration_predecessor_fault predecessor" \
    "$migration_rollback_state" "$migration_predecessor_log_before"
  case "$migration_predecessor_fault" in
    inactive)
      printf '%s\n' 417300 \
        >"$migration_rollback_state/active.agent-os-hub.service"
      ;;
    unhealthy)
      rm -f -- "$AGENT_OS_MOCK_FAIL_HEALTH_REVISION"
      ;;
    disabled)
      : >"$migration_rollback_state/enabled.agent-os-hub.service"
      ;;
  esac
done
expect_admin_migration_sigkill \
  'rolled-back predecessor journal redurability' phase-dir:finalized \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest"
[[ -f "$migration_rollback_journal/rolled_back" && \
  -f "$migration_rollback_journal/finalized" && \
  ! -e "$migration_attempt_two_journal" ]] ||
  fail 'fresh attempt was allocated before its terminal predecessor was re-fsynced'
run_admin_migration_from_source \
  "$migration_attempt_two_source" \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" >/dev/null ||
  fail 'finalized rollback did not permit a fresh forward attempt'
assert_migration_attempt_intent \
  "$migration_attempt_two_journal" "$migration_attempt_two_transaction" 2 \
  "$migration_rollback_transaction" "$migration_attempt_one_digest" \
  "$migration_rollback_digest"
assert_migration_forward_completed \
  'second migration attempt' "$migration_rollback_root" \
  "$migration_rollback_state" "$migration_attempt_two_source"
[[ -f "$migration_rollback_journal/rolled_back" && \
  -f "$migration_rollback_journal/finalized" && \
  -f "$migration_attempt_two_journal/committed" && \
  -f "$migration_attempt_two_journal/finalized" ]] ||
  fail 'fresh migration attempt overwrote history or missed its terminal record'
[[ "$($REAL_NODE_BIN "$HUB_ROOT/bin/tree-digest.mjs" \
    --canonical-root-owner "$migration_rollback_journal" | \
    "$REAL_NODE_BIN" -e \
      'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" == \
    "$migration_attempt_one_digest" ]] ||
  fail 'fresh migration attempt changed its immutable predecessor journal'
migration_attempt_one_failed="$migration_rollback_root/usr/libexec/agent-os/hub.failed-migration-$migration_rollback_artifact_id"
migration_attempt_one_failed_stage="$migration_rollback_root/usr/libexec/agent-os/hub.failed-migration-stage-$migration_rollback_artifact_id"
if [[ -d "$migration_attempt_one_failed" ]]; then
  [[ ! -e "$migration_attempt_one_failed_stage" ]] ||
    fail 'fresh migration attempt left ambiguous predecessor forensic artifacts'
elif [[ -d "$migration_attempt_one_failed_stage" ]]; then
  [[ ! -e "$migration_attempt_one_failed" ]] ||
    fail 'fresh migration attempt left ambiguous predecessor forensic artifacts'
else
  fail 'fresh migration attempt lost its predecessor forensic candidate'
fi
[[ "$(migration_fixture_fingerprint \
    "$migration_rollback_root/etc/agent-os/hub.env")" == \
    "$migration_rollback_env_fingerprint" && \
  "$(readlink "$migration_rollback_root/opt/agent-os/current")" == \
    "$migration_rollback_current_target" && \
  "$(readlink "$migration_rollback_root/opt/agent-os/previous")" == \
    "$migration_rollback_previous_target" && \
  "$(migration_state_contract_fingerprint \
    "$migration_rollback_root/var/lib/agent-os/hub")" == \
    "$migration_rollback_state_fingerprint" ]] ||
  fail 'second migration attempt changed state, secrets or release pointers'

migration_attempt_history_log_before="$(wc -l \
  <"$migration_rollback_state/systemctl.log" | tr -d ' ')"
migration_attempt_two_intent="$migration_attempt_two_journal/intent"
migration_attempt_two_intent_saved="$temporary/migration-attempt-two-intent.saved"
cp -p "$migration_attempt_two_intent" "$migration_attempt_two_intent_saved"
chmod 0600 "$migration_attempt_two_intent"
sed 's/^predecessor_journal_sha256=.*/predecessor_journal_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' \
  "$migration_attempt_two_intent_saved" >"$migration_attempt_two_intent"
chmod 0400 "$migration_attempt_two_intent"
migration_attempt_history_error="$temporary/migration-attempt-history.err"
if run_admin_migration_from_source \
  "$migration_attempt_two_source" \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" \
  >/dev/null 2>"$migration_attempt_history_error"; then
  fail 'admin migration accepted a tampered predecessor digest'
fi
[[ "$(<"$migration_attempt_history_error")" == \
  'Hub deployment failed: admin migration attempt predecessor binding is invalid' ]] ||
  fail 'admin migration predecessor tamper rejection was inexact'
install -m 0400 "$migration_attempt_two_intent_saved" \
  "$migration_attempt_two_intent"

migration_attempt_three_transaction="$(fresh_admin_migration_transaction \
  "$migration_rollback_digest" 3)"
migration_attempt_three_journal="$migration_rollback_root/var/lib/agent-os-ops/private/$migration_attempt_three_transaction"
mv "$migration_attempt_two_journal" "$migration_attempt_three_journal"
if run_admin_migration_from_source \
  "$migration_attempt_two_source" \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" \
  >/dev/null 2>"$migration_attempt_history_error"; then
  fail 'admin migration accepted an attempt-number gap'
fi
[[ "$(<"$migration_attempt_history_error")" == \
  'Hub deployment failed: admin migration history contains an attempt gap' ]] ||
  fail 'admin migration attempt-gap rejection was inexact'
mv "$migration_attempt_three_journal" "$migration_attempt_two_journal"

migration_attempt_legacy_duplicate="$migration_rollback_root/var/lib/agent-os-ops/private/upgrade-admin-migration-${migration_rollback_digest:0:32}"
cp -R "$migration_rollback_journal" "$migration_attempt_legacy_duplicate"
if run_admin_migration_from_source \
  "$migration_attempt_two_source" \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" \
  >/dev/null 2>"$migration_attempt_history_error"; then
  fail 'admin migration accepted duplicate attempt numbers'
fi
[[ "$(<"$migration_attempt_history_error")" == \
  'Hub deployment failed: admin migration history contains duplicate attempt numbers' ]] ||
  fail 'admin migration duplicate-attempt rejection was inexact'
migration_attempt_recovery_root="$migration_rollback_root/var/lib/agent-os-ops/private"
migration_attempt_legacy_duplicate_expected="$migration_attempt_recovery_root/upgrade-admin-migration-${migration_rollback_digest:0:32}"
[[ "$migration_attempt_legacy_duplicate" == \
    "$migration_attempt_legacy_duplicate_expected" && \
  "$migration_attempt_legacy_duplicate" != "$migration_rollback_journal" && \
  "${migration_attempt_legacy_duplicate%/*}" == \
    "$migration_attempt_recovery_root" && \
  -d "$migration_attempt_legacy_duplicate" && \
  ! -L "$migration_attempt_legacy_duplicate" && \
  -z "$(find "$migration_attempt_legacy_duplicate" -type l -print -quit)" ]] ||
  fail 'admin migration duplicate-attempt cleanup target was unsafe'
find "$migration_attempt_legacy_duplicate" -type d -exec chmod u+rwx {} +
find "$migration_attempt_legacy_duplicate" -type f -exec chmod u+rw {} +
rm -rf -- "$migration_attempt_legacy_duplicate"
[[ ! -e "$migration_attempt_legacy_duplicate" ]] ||
  fail 'admin migration duplicate-attempt fixture was not removed'

if [[ -d "$migration_attempt_one_failed" ]]; then
  migration_attempt_one_candidate=$migration_attempt_one_failed
else
  migration_attempt_one_candidate=$migration_attempt_one_failed_stage
fi
migration_attempt_one_candidate_file="$migration_attempt_one_candidate/nginx/agent-os-hub.conf"
migration_attempt_one_candidate_file_parent=${migration_attempt_one_candidate_file%/*}
migration_attempt_one_candidate_saved="$temporary/migration-attempt-one-candidate.saved"
[[ -f "$migration_attempt_one_candidate_file" && \
  ! -L "$migration_attempt_one_candidate_file" && \
  "$(stat -c '%h' "$migration_attempt_one_candidate_file")" == 1 ]] ||
  fail 'historical forensic candidate target was not a private regular file'
migration_attempt_one_candidate_file_identity_before="$(stat -c '%d:%i' \
  "$migration_attempt_one_candidate_file")"
migration_attempt_one_candidate_parent_mtime_before="$(stat -c '%y' \
  "$migration_attempt_one_candidate_file_parent")"
migration_attempt_one_candidate_digest_before="$($REAL_NODE_BIN \
  "$HUB_ROOT/bin/tree-digest.mjs" --canonical-root-owner \
  "$migration_attempt_one_candidate" | "$REAL_NODE_BIN" -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" ||
  fail 'historical forensic candidate could not be fingerprinted before tamper'
cp -p "$migration_attempt_one_candidate_file" \
  "$migration_attempt_one_candidate_saved"
chmod 0644 "$migration_attempt_one_candidate_file"
printf '%s\n' '# tampered-history' >>"$migration_attempt_one_candidate_file"
chmod 0444 "$migration_attempt_one_candidate_file"
if run_admin_migration_from_source \
  "$migration_attempt_two_source" \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" \
  >/dev/null 2>"$migration_attempt_history_error"; then
  fail 'admin migration accepted a tampered historical forensic candidate'
fi
[[ "$(<"$migration_attempt_history_error")" == \
  'Hub deployment failed: historical admin migration forensic artifact changed' ]] ||
  fail 'admin migration historical-forensic rejection was inexact'
migration_attempt_candidate_parent="$migration_rollback_root/usr/libexec/agent-os"
[[ "$migration_attempt_one_candidate" == "$migration_attempt_one_failed" || \
  "$migration_attempt_one_candidate" == "$migration_attempt_one_failed_stage" ]] ||
  fail 'admin migration historical-forensic repair target name was unsafe'
for migration_attempt_candidate_ancestor in \
  "$migration_rollback_root" \
  "$migration_rollback_root/usr" \
  "$migration_rollback_root/usr/libexec" \
  "$migration_attempt_candidate_parent" \
  "$migration_attempt_one_candidate"; do
  [[ -d "$migration_attempt_candidate_ancestor" && \
    ! -L "$migration_attempt_candidate_ancestor" && \
    "$(realpath -e "$migration_attempt_candidate_ancestor")" == \
      "$migration_attempt_candidate_ancestor" ]] ||
    fail 'admin migration historical-forensic repair ancestor was unsafe'
done
[[ "${migration_attempt_one_candidate%/*}" == \
    "$migration_attempt_candidate_parent" && \
  -z "$(find "$migration_attempt_one_candidate" -type l -print -quit)" ]] ||
  fail 'admin migration historical-forensic repair tree was unsafe'
chmod 0644 "$migration_attempt_one_candidate_file"
cp -p -- "$migration_attempt_one_candidate_saved" \
  "$migration_attempt_one_candidate_file"
chmod 0444 "$migration_attempt_one_candidate_file"
[[ "$(stat -c '%a' "$migration_attempt_one_candidate_file")" == 444 ]] ||
  fail 'admin migration historical-forensic repair did not restore target mode'
[[ -f "$migration_attempt_one_candidate_file" && \
  ! -L "$migration_attempt_one_candidate_file" && \
  "$(stat -c '%h' "$migration_attempt_one_candidate_file")" == 1 && \
  "$(stat -c '%d:%i' "$migration_attempt_one_candidate_file")" == \
    "$migration_attempt_one_candidate_file_identity_before" ]] ||
  fail 'historical forensic candidate repair replaced the target inode'
[[ "$(stat -c '%y' "$migration_attempt_one_candidate_file_parent")" == \
  "$migration_attempt_one_candidate_parent_mtime_before" ]] ||
  fail 'historical forensic candidate repair changed its parent directory mtime'
migration_attempt_one_candidate_digest_after="$($REAL_NODE_BIN \
  "$HUB_ROOT/bin/tree-digest.mjs" --canonical-root-owner \
  "$migration_attempt_one_candidate" | "$REAL_NODE_BIN" -e \
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).treeSha256))')" ||
  fail 'historical forensic candidate could not be fingerprinted after repair'
[[ "$migration_attempt_one_candidate_digest_after" == \
  "$migration_attempt_one_candidate_digest_before" ]] ||
  fail 'historical forensic candidate digest was not restored exactly'

assert_no_service_mutation_since \
  'admin migration history negative matrix' "$migration_rollback_state" \
  "$migration_attempt_history_log_before"
run_admin_migration_from_source \
  "$migration_attempt_two_source" \
  "$migration_rollback_root" "$migration_rollback_nonce" \
  "$migration_rollback_state" "$migration_rollback_digest" >/dev/null ||
  fail 'restored migration history was not validation-only retryable'
fi

install -d -m 0700 "$test_root/proc"

bash "$HUB_ROOT/bootstrap-admin.sh" >/dev/null
bash "$HUB_ROOT/bootstrap-admin.sh" >/dev/null
fixed_root="$test_root/usr/libexec/agent-os/hub"
fixed_bin="$fixed_root/bin"
[[ -x "$fixed_bin/admin-entry-guard.sh" && -x "$fixed_bin/install.sh" && \
  -x "$fixed_bin/health-check.sh" && -x "$fixed_bin/recovery-start-gate.sh" && \
  -x "$fixed_bin/state-admin.sh" && -x "$fixed_root/pre-upgrade-snapshot" && \
  -f "$fixed_bin/state-snapshot.mjs" && -f "$fixed_bin/state-forensic.mjs" && \
  -f "$fixed_bin/state-open-files.mjs" && \
  -f "$fixed_bin/tree-digest.mjs" && -f "$fixed_bin/capacity-check.mjs" ]] ||
  fail 'bootstrap did not install the fixed admin kit'

publisher_root="$test_root/usr/libexec/agent-os/publisher"
publisher_config="$test_root/etc/agent-os/publisher"
publisher_state="$test_root/var/lib/agent-os/publisher/staging"
install -d -m 0700 "$publisher_root" "$publisher_config" "$publisher_state"
publisher_verifier="$publisher_root/verify"
cat >"$publisher_verifier" <<PUBLISHER_VERIFY
#!/bin/bash -p
set -Eeuo pipefail
artifact=
while ((\$# > 0)); do
  case "\$1" in
    --artifact) artifact=\$2; shift 2 ;;
    *) shift ;;
  esac
done
[[ -f "\$artifact" && ! -L "\$artifact" ]]
hash=\$(sha256sum "\$artifact" | awk '{print \\$1}')
bytes=\$(stat -c '%s' "\$artifact")
published="$publisher_state/hub-release-1-\$hash"
if [[ ! -e "\$published" ]]; then
  /bin/cp -- "\$artifact" "\$published"
  chmod 0600 "\$published"
fi
printf 'publisher_verifier result=ok artifact_type=hub-release sequence=1 artifact_sha256=%s artifact_bytes=%s published_path=%s\n' \
  "\$hash" "\$bytes" "\$published"
PUBLISHER_VERIFY
chmod 0555 "$publisher_verifier"
sha256_file "$publisher_verifier" >"$publisher_config/verifier.sha256"
chmod 0400 "$publisher_config/verifier.sha256"
envelope="$temporary/release.envelope"
printf '%s\n' test-envelope >"$envelope"
printf '%s\n' test-signature >"$envelope.sig"
chmod 0600 "$envelope" "$envelope.sig"

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
if [[ -z "$account" ]]; then
  case "$option" in
    -u) printf '%s\n' "$MOCK_CALLER_UID" ;;
    -g) printf '%s\n' "$MOCK_CALLER_GID" ;;
    -G) printf '%s\n' "$MOCK_CALLER_GID" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
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
export MOCK_CALLER_UID="$(id -u)"
export MOCK_CALLER_GID="$(id -g)"
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
  bash "$HUB_ROOT/bin/install.sh" --archive "$archive" --envelope "$envelope" \
  --revision source-rejected --env-file "$good_env"

invalid_archive="$temporary/admin-content.tar.gz"
invalid_checksum="$(sha256_file "$invalid_archive")"
expect_failure \
  'install accepted legacy checksum-only authentication' \
  bash "$fixed_bin/install.sh" --archive "$archive" \
  --sha256 0000000000000000000000000000000000000000000000000000000000000000 \
  --revision bad-checksum --env-file "$good_env"
expect_failure \
  'install accepted an unsafe archive with a valid checksum' \
  bash "$fixed_bin/install.sh" --archive "$invalid_archive" --envelope "$envelope" \
  --revision bad-archive --env-file "$good_env"
expect_failure \
  'install accepted an invalid credential file' \
  bash "$fixed_bin/install.sh" --archive "$archive" --envelope "$envelope" \
  --revision bad-config --env-file "$temporary/short.env"
cp "$good_env" "$temporary/hardlinked-env"
ln "$temporary/hardlinked-env" "$temporary/hardlinked-env-peer"
expect_failure \
  'install accepted a multiply-linked credential source' \
  bash "$fixed_bin/install.sh" --archive "$archive" --envelope "$envelope" \
  --revision bad-config-hardlink --env-file "$temporary/hardlinked-env"
[[ ! -e "$test_root/etc/agent-os/hub.env" && ! -e "$test_root/opt/agent-os/current" ]] ||
  fail 'offline install rejection committed configuration or a pointer'

ln -s releases/legacy-history "$test_root/opt/agent-os/previous"
expect_failure \
  'fresh install accepted an existing previous pointer' \
  bash "$fixed_bin/install.sh" --archive "$archive" --envelope "$envelope" \
  --revision previous-rejected --env-file "$good_env"
[[ "$(readlink "$test_root/opt/agent-os/previous")" == releases/legacy-history ]] ||
  fail 'fresh install rejection changed an existing previous pointer'
rm -f -- "$test_root/opt/agent-os/previous"

# Every install commit boundary must leave the same verified immutable release
# reusable while removing all published configuration, pointers and unit state.
install_revision_one() {
  bash "$fixed_bin/install.sh" --archive "$archive" --envelope "$envelope" \
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

# State materialization in unprivileged deploy-test mode must target the caller
# identity. Keep the production account-name lookup shape while avoiding any
# privileged chown on the disposable test root.
export AGENT_OS_ID_BIN="$identity_mock_dir/id"
export MOCK_LIVE_UID=$EUID
export MOCK_LIVE_GID="$(/usr/bin/id -g)"

state_sentinel="$test_root/var/lib/agent-os/hub/state-sentinel"
printf '%s\n' stable >"$state_sentinel"
chmod 0600 "$state_sentinel"
state_root="$test_root/var/lib/agent-os/hub"
chmod 0700 "$state_root"
cat >"$state_root/events.jsonl" <<'EVENTS'
{"id":"event-1","type":"task.created","seq":1,"project":"project-a","actor":{"kind":"system","id":"runtime"},"subject":{"kind":"task","id":"task-1"},"at":"2026-08-24T00:00:01.000Z","payload":{"task":"task-1","title":"fixture","requires":[]}}
{"id":"event-2","type":"task.completed","seq":2,"project":"project-a","actor":{"kind":"system","id":"runtime"},"subject":{"kind":"task","id":"task-1"},"at":"2026-08-24T00:00:02.000Z","payload":{"task":"task-1","acceptedBy":"human"}}
EVENTS
cat >"$state_root/remote-placement.json" <<'PLACEMENT'
{
  "version": 1,
  "placements": {
    "[\"user-a\",\"project-a\",\"grok\"]": {
      "user": "user-a",
      "project": "project-a",
      "agent": "grok",
      "hostId": "windows-fixture",
      "updatedAt": "2026-08-24T00:00:00.000Z"
    }
  }
}
PLACEMENT
request_id=request-fixture-1
request_hash="$($REAL_NODE_BIN -e \
  'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' \
  "$request_id")"
request_ledger_root="$state_root/remote-placement.json.requests"
install -d -m 0700 "$request_ledger_root"
cat >"$request_ledger_root/$request_hash.json" <<'LEDGER'
{
  "version": 1,
  "request": {
    "requestId": "request-fixture-1",
    "fingerprint": "78d5e55a0fe7b9d2540d2caa26ad9b669c6c47406016f1ff11486a820078bde8",
    "state": "completed",
    "events": [
      {
        "requestId": "request-fixture-1",
        "sequence": 1,
        "at": "2026-08-24T00:00:01.000Z",
        "kind": "started",
        "fresh": false
      },
      {
        "requestId": "request-fixture-1",
        "sequence": 2,
        "at": "2026-08-24T00:00:02.000Z",
        "kind": "completed",
        "result": {
          "requestId": "request-fixture-1",
          "text": "done",
          "sessionId": "session-fixture",
          "ms": 10,
          "fresh": false
        }
      }
    ],
    "updatedAt": "2026-08-24T00:00:02.000Z",
    "result": {
      "requestId": "request-fixture-1",
      "text": "done",
      "sessionId": "session-fixture",
      "ms": 10,
      "fresh": false
    }
  }
}
LEDGER
chmod 0600 \
  "$state_root/events.jsonl" \
  "$state_root/remote-placement.json" \
  "$request_ledger_root/$request_hash.json"
secret_canary=agent-os-private-canary-7f3e9c0a-do-not-log
secret_canary_path="$state_root/private-opaque.bin"
printf '%s\n' "$secret_canary" >"$secret_canary_path"
chmod 0600 "$secret_canary_path"

write_proc_process_fixture() {
  local pid=$1 uid=$2 cgroup_path=$3 pid_root
  pid_root="$test_root/proc/$pid"
  local task_root="$pid_root/task/$pid" context_root="$test_root/process-context/$pid"
  local field=1 stat_line="$pid (fixture $pid) S"
  install -d -m 0700 \
    "$task_root/fd" "$task_root/fdinfo" \
    "$context_root/cwd" "$context_root/root"
  while ((field < 19)); do
    stat_line="$stat_line 0"
    field=$((field + 1))
  done
  printf '%s 1000\n' "$stat_line" >"$pid_root/stat"
  printf '%s 1000\n' "$stat_line" >"$task_root/stat"
  printf 'Name:\tfixture\nUid:\t%s\t%s\t%s\t%s\n' \
    "$uid" "$uid" "$uid" "$uid" >"$task_root/status"
  printf '0::%s\n' "$cgroup_path" >"$task_root/cgroup"
  printf '1 0 0:42 / %s rw - ext4 /dev/vda2 rw\n260 1 0:4 mnt:[4026532223] %s/run/snapd/ns/lxd.mnt rw - nsfs nsfs rw\n' \
    "$test_root" "$test_root" >"$task_root/mountinfo"
  : >"$task_root/maps"
  : >"$task_root/smaps"
  ln -s "$context_root/cwd" "$task_root/cwd"
  ln -s "$context_root/root" "$task_root/root"
  install_proc_mount_namespace_fixture "$test_root" "$task_root"
  chmod 0600 \
    "$pid_root/stat" \
    "$task_root/stat" \
    "$task_root/status" \
    "$task_root/cgroup" \
    "$task_root/mountinfo" \
    "$task_root/maps" \
    "$task_root/smaps"
}

# The real state-open-files helper always proves the inspector identity and the
# service cgroup twice. Supply a complete synthetic proc/cgroup topology rather
# than replacing the helper with a permissive mock.
install -d -m 0700 \
  "$test_root/cgroup/system.slice/agent-os-hub.service"
printf 'populated 0\nfrozen 0\n' \
  >"$test_root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
chmod 0600 \
  "$test_root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
write_proc_process_fixture 999 0 /system.slice/fixture-inspector.service

ops_root="$test_root/var/lib/agent-os-ops"
recovery_block="$ops_root/hub-block"
recovery_token="$test_root/run/agent-os/hub-recovery-start"
runtime_maintenance="$test_root/run/agent-os/hub-maintenance"
"$systemctl_mock" stop agent-os-hub.service
token_transaction=backup-deploy-token-probe
printf 'agent-os-hub-recovery-block-v1:%s\n' "$token_transaction" >"$recovery_block"
chmod 0444 "$recovery_block"
/bin/bash -p -c \
  'source "$1"; authorize_recovery_start "$2"' \
  _ "$fixed_bin/lib.sh" "$token_transaction" ||
  fail 'recovery token was not atomically published by the audited library'
[[ -f "$recovery_token" && ! -L "$recovery_token" && \
  "$(stat -c '%a' "$recovery_token" 2>/dev/null || stat -f '%Lp' "$recovery_token")" == 400 ]] ||
  fail 'published recovery token ownership shape is unsafe'
/bin/bash -p "$fixed_bin/recovery-start-gate.sh" >/dev/null ||
  fail 'matching persistent block and one-time token were not authorized'
[[ ! -e "$recovery_token" ]] || fail 'recovery start gate did not consume its token'
expect_failure \
  'recovery start token was reusable after its first authorization' \
  /bin/bash -p "$fixed_bin/recovery-start-gate.sh"
rm -f -- "$recovery_block"

# A signed orphan restore intent is bound to the narrowly scoped
# recovery-pre-* parent transaction.  It needs the same one-shot start path,
# while arbitrary recovery-* records must remain ineligible.
token_transaction=recovery-pre-deploy-token-probe
printf 'agent-os-hub-recovery-block-v1:%s\n' "$token_transaction" >"$recovery_block"
chmod 0444 "$recovery_block"
/bin/bash -p -c \
  'source "$1"; authorize_recovery_start "$2"' \
  _ "$fixed_bin/lib.sh" "$token_transaction" ||
  fail 'signed orphan-intent recovery token was not atomically published'
/bin/bash -p "$fixed_bin/recovery-start-gate.sh" >/dev/null ||
  fail 'signed orphan-intent recovery token was not authorized'
[[ ! -e "$recovery_token" ]] ||
  fail 'signed orphan-intent recovery token was not consumed'
rm -f -- "$recovery_block"

token_transaction=recovery-unsigned-token-probe
printf 'agent-os-hub-recovery-block-v1:%s\n' "$token_transaction" >"$recovery_block"
chmod 0444 "$recovery_block"
expect_failure \
  'an unsigned generic recovery record authorized a service start' \
  /bin/bash -p -c 'source "$1"; authorize_recovery_start "$2"' \
    _ "$fixed_bin/lib.sh" "$token_transaction"
[[ ! -e "$recovery_token" ]] ||
  fail 'rejected generic recovery record left a start token'
rm -f -- "$recovery_block"

fsync_transaction=backup-maintenance-fsync-probe
printf 'agent-os-hub-recovery-block-v1:%s\n' "$fsync_transaction" >"$recovery_block"
: >"$runtime_maintenance"
chmod 0444 "$recovery_block" "$runtime_maintenance"
expect_failure \
  'maintenance_off accepted a cleanup transaction that did not match its block' \
  /bin/bash -p -c 'source "$1"; maintenance_off backup-wrong-cleanup-probe' \
    _ "$fixed_bin/lib.sh"
[[ -f "$runtime_maintenance" && -f "$recovery_block" && \
  "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$fsync_transaction" ]] ||
  fail 'wrong maintenance cleanup transaction unlinked a recovery guard'
printf '%s\n' "$test_root/run/agent-os" >"$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE"
expect_failure \
  'maintenance_off accepted runtime-guard directory fsync failure' \
  /bin/bash -p -c 'source "$1"; maintenance_off "$2"' \
    _ "$fixed_bin/lib.sh" "$fsync_transaction"
[[ ! -e "$AGENT_OS_MOCK_FAIL_FSYNC_PATH_ONCE" && \
  ! -e "$runtime_maintenance" && -f "$recovery_block" ]] ||
  fail 'maintenance_off runtime fsync failure did not retain the persistent block'
rm -f -- "$recovery_block"

wrong_existing_block=backup-existing-block-probe
wrong_requested_block=restore-requested-block-probe
printf 'agent-os-hub-recovery-block-v1:%s\n' "$wrong_existing_block" \
  >"$recovery_block"
chmod 0444 "$recovery_block"
wrong_block_private_count="$(find "$ops_root/private" -mindepth 1 -maxdepth 1 \
  | awk 'END { print NR + 0 }')"
expect_failure \
  'durable recovery accepted a requested transaction different from the existing block' \
  /bin/bash -p -c \
    'source "$1"; durable_recovery_on state-probe blocked "$2"' \
    _ "$fixed_bin/lib.sh" "$wrong_requested_block"
[[ "$(<"$recovery_block")" == \
  "agent-os-hub-recovery-block-v1:$wrong_existing_block" && \
  "$(find "$ops_root/private" -mindepth 1 -maxdepth 1 \
    | awk 'END { print NR + 0 }')" == "$wrong_block_private_count" && \
  -z "$(find "$ops_root/private" -maxdepth 1 -name '.*.tmp' -print -quit)" ]] ||
  fail 'wrong durable recovery transaction changed the block or wrote a private record'
rm -f -- "$recovery_block"
"$systemctl_mock" start agent-os-hub.service

# Exercise the installed production snapshot and state-admin paths before any
# fault wrapper is introduced. This catches CLI drift between the hook,
# backup/restore orchestrator and the snapshot engine.
state_backup_error="$temporary/state-backup.err"
state_backup_output="$(
  /bin/bash -p "$fixed_bin/state-admin.sh" backup --label deploy-gate \
    2>"$state_backup_error"
)" || fail 'real state-admin backup failed'
state_backup_result=${state_backup_output##*$'\n'}
[[ "$state_backup_result" =~ ^hub_state_backup\ status=ok\ snapshot=([A-Za-z0-9._-]+)\ manifest_sha256=([a-f0-9]{64})$ ]] ||
  fail 'real state-admin backup emitted an invalid result contract'
state_backup_id=${BASH_REMATCH[1]}
state_backup_digest=${BASH_REMATCH[2]}
state_backup_path="$test_root/var/backups/agent-os/hub/$state_backup_id"
strict_verify_error="$temporary/state-snapshot-verify.err"
state_backup_summary="$(
  "$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" \
    verify "$state_backup_path" --manifest-sha256 "$state_backup_digest" \
    2>"$strict_verify_error"
)" || fail 'real state-admin backup did not publish a verifiable snapshot'
strict_secret_artifact="$state_backup_path/data/private-opaque.bin"
strict_secret_root_mode="$(stat -c '%a' "$state_backup_path" 2>/dev/null || \
  stat -f '%Lp' "$state_backup_path")"
strict_secret_file_mode="$(stat -c '%a' "$strict_secret_artifact" 2>/dev/null || \
  stat -f '%Lp' "$strict_secret_artifact")"
strict_secret_root_uid="$(stat -c '%u' "$state_backup_path" 2>/dev/null || \
  stat -f '%u' "$state_backup_path")"
strict_secret_file_uid="$(stat -c '%u' "$strict_secret_artifact" 2>/dev/null || \
  stat -f '%u' "$strict_secret_artifact")"
[[ -d "$state_backup_path" && ! -L "$state_backup_path" ]] ||
  fail 'strict snapshot root was not a private directory'
[[ "$strict_secret_root_mode" == 500 ]] ||
  fail 'strict snapshot root mode was not 0500'
[[ -f "$strict_secret_artifact" && ! -L "$strict_secret_artifact" ]] ||
  fail 'strict snapshot opaque secret was not a regular non-link file'
[[ "$strict_secret_file_mode" == 400 ]] ||
  fail 'strict snapshot opaque secret mode was not 0400'
[[ "$strict_secret_root_uid" == "$EUID" ]] ||
  fail 'strict snapshot root owner changed'
[[ "$strict_secret_file_uid" == "$EUID" ]] ||
  fail 'strict snapshot opaque secret owner changed'
[[ "$(<"$strict_secret_artifact")" == "$secret_canary" ]] ||
  fail 'strict snapshot opaque secret content changed'
if printf '%s\n%s\n' "$state_backup_output" "$state_backup_summary" | \
  grep -Fq -- "$secret_canary" || \
  grep -Fq -- "$secret_canary" "$state_backup_error" "$strict_verify_error"; then
  fail 'strict snapshot command stdout or stderr disclosed the opaque secret'
fi
if grep -Fq -- "$secret_canary" "$state_backup_path/manifest.json" || \
  grep -R -Fq -- "$secret_canary" "$ops_root/private" || \
  grep -Fq -- "$secret_canary" "$AGENT_OS_MOCK_SYSTEMCTL_LOG"; then
  fail 'strict snapshot manifest, journal or deployment evidence disclosed the opaque secret'
fi
"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  const summary = JSON.parse(process.argv[1]);
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const byPath = new Map(manifest.files.map((entry) => [entry.relativePath, entry]));
  const event = byPath.get("events.jsonl");
  const placement = byPath.get("remote-placement.json");
  const ledgers = manifest.files.filter((entry) =>
    entry.relativePath.startsWith("remote-placement.json.requests/"));
  if (summary.files !== manifest.totals.files || event?.count !== 2 ||
      placement?.count !== 1 || ledgers.length !== 1 || ledgers[0].count !== 1 ||
      manifest.activeTaskCount !== 0) process.exit(1);
' "$state_backup_summary" "$state_backup_path/manifest.json" ||
  fail 'real snapshot omitted event, placement or terminal request ledger evidence'

for event_transaction_marker in write-intent write-committed; do
  transient_event_marker="$state_root/events.jsonl.$event_transaction_marker"
  transient_snapshot="$test_root/var/backups/agent-os/hub/transient-$event_transaction_marker"
  printf '%s\n' transient >"$transient_event_marker"
  chmod 0600 "$transient_event_marker"
  expect_failure \
    "snapshot accepted EventLog $event_transaction_marker transaction state" \
    /bin/bash -p "$fixed_root/pre-upgrade-snapshot" \
      "$state_root" "$transient_snapshot"
  [[ ! -e "$transient_snapshot" && ! -L "$transient_snapshot" ]] ||
    fail "snapshot published a transient EventLog $event_transaction_marker artifact"
  rm -f -- "$transient_event_marker"
done

# An inactive Hub must still refuse automatic restore when the current tree
# contains active work.  The active projection has priority over a corrupt tail
# in the same small read chunk: neither malformed JSON nor invalid UTF-8 may
# divert this case into forensic preservation.  The rejection must happen
# before a recovery block, journal, staging rename or service mutation exists.
active_priority_events_original="$temporary/active-priority-events.original"
active_priority_ledger_original="$temporary/active-priority-ledger.original"
cp "$state_root/events.jsonl" "$active_priority_events_original"
cp "$request_ledger_root/$request_hash.json" "$active_priority_ledger_original"
chmod 0600 "$active_priority_events_original" "$active_priority_ledger_original"
"$systemctl_mock" stop agent-os-hub.service
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'active-work restore preflight fixture is not inactive and enabled'

assert_active_restore_preflight() {
  local label=$1 before_state before_snapshot before_log after_log
  local before_backup_count before_journal_count mutation_log
  local rejection_actual rejection_actual_quoted rejection_expected
  local rejection_expected_quoted rejection_error rejection_bytes
  before_state="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")" ||
    fail "$label could not hash the active current state"
  before_snapshot="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_backup_path")" ||
    fail "$label could not hash the unique verified target snapshot"
  before_backup_count="$(find "$test_root/var/backups/agent-os/hub" \
    -mindepth 1 -maxdepth 1 -type d | awk 'END { print NR + 0 }')"
  before_journal_count="$(find "$test_root/var/lib/agent-os-ops/private" \
    -mindepth 1 -maxdepth 1 -type d -name 'restore-*' | awk 'END { print NR + 0 }')"
  before_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  rejection_expected='Hub deployment failed: current state contains assigned, running or inflight work and cannot be restored automatically'
  rejection_error="$temporary/active-restore-${label//[^A-Za-z0-9_-]/_}.err"
  if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$state_backup_id" --manifest-sha256 "$state_backup_digest" \
    >/dev/null 2>"$rejection_error"; then
    fail "$label was not rejected as active_tasks_present"
  fi
  rejection_actual="$(<"$rejection_error")"
  if [[ "$rejection_actual" != "$rejection_expected" ]]; then
    rejection_bytes="$(wc -c <"$rejection_error" | tr -d ' ')"
    if ((${#rejection_actual} > 512)) || \
      [[ "$rejection_actual" == *"$secret_canary"* ]]; then
      rejection_actual="redacted-bytes-$rejection_bytes"
    else
      rejection_actual=${rejection_actual//$test_root/<test-root>}
      rejection_actual=${rejection_actual//$HUB_ROOT/<source-root>}
      rejection_actual=${rejection_actual//$'\r'/';'}
      rejection_actual=${rejection_actual//$'\n'/';'}
    fi
    printf -v rejection_actual_quoted '%q' "$rejection_actual"
    printf -v rejection_expected_quoted '%q' "$rejection_expected"
    fail "$label was not rejected as active_tasks_present: actual=$rejection_actual_quoted expected=$rejection_expected_quoted"
  fi
  after_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  mutation_log="$(sed -n "$((before_log + 1)),${after_log}p" \
    "$AGENT_OS_MOCK_SYSTEMCTL_LOG")"
  if printf '%s\n' "$mutation_log" | grep -Eq \
    '^(start|stop|enable|disable|reset-failed)( |$)'; then
    fail "$label mutated systemd before the active-work rejection"
  fi
  [[ ! -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label changed inactive/enabled systemd state"
  [[ "$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")" == \
    "$before_state" ]] || fail "$label changed the active current state"
  [[ "$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_backup_path")" == \
    "$before_snapshot" ]] || fail "$label changed the unique verified target snapshot"
  [[ "$(find "$test_root/var/backups/agent-os/hub" \
    -mindepth 1 -maxdepth 1 -type d | awk 'END { print NR + 0 }')" == \
    "$before_backup_count" && \
    "$(find "$test_root/var/lib/agent-os-ops/private" \
      -mindepth 1 -maxdepth 1 -type d -name 'restore-*' | awk 'END { print NR + 0 }')" == \
    "$before_journal_count" ]] ||
    fail "$label published a preservation artifact or restore journal"
  [[ ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" && \
    -z "$(find "$test_root/var/lib/agent-os" -maxdepth 1 -type d \
      \( -name '.hub.restore-*' -o -name 'hub.pre-restore-*' -o \
      -name 'hub.failed-restore-*' \) -print -quit)" ]] ||
    fail "$label entered recovery or renamed state before rejecting active work"
}

for active_corrupt_tail in malformed invalid-utf8; do
  "$REAL_NODE_BIN" -e '
    const fs = require("node:fs");
    const events = [
      {
        id: "active-prefix-1", type: "task.created", seq: 1,
        project: "project-a", actor: { kind: "system", id: "runtime" },
        subject: { kind: "task", id: "task-active-prefix" },
        at: "2026-08-24T00:00:01.000Z",
        payload: { task: "task-active-prefix", title: "active", requires: [] },
      },
      {
        id: "active-prefix-2", type: "task.assigned", seq: 2,
        project: "project-a", actor: { kind: "system", id: "runtime" },
        subject: { kind: "task", id: "task-active-prefix" },
        at: "2026-08-24T00:00:02.000Z",
        payload: { task: "task-active-prefix", executor: "grok" },
      },
    ];
    const prefix = Buffer.from(`${events.map(JSON.stringify).join("\n")}\n`, "utf8");
    const tail = process.argv[2] === "malformed"
      ? Buffer.from("{\"truncated\":", "utf8")
      : Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]);
    fs.writeFileSync(process.argv[1], Buffer.concat([prefix, tail]));
  ' "$state_root/events.jsonl" "$active_corrupt_tail"
  chmod 0600 "$state_root/events.jsonl"
  active_corrupt_measure_error="$temporary/active-corrupt-$active_corrupt_tail-measure.err"
  if "$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" measure "$state_root" \
    >/dev/null 2>"$active_corrupt_measure_error"; then
    fail "state snapshot accepted active event prefix with $active_corrupt_tail tail"
  fi
  active_corrupt_measure_expected='Hub state snapshot failed: active_tasks_present'
  active_corrupt_measure_actual="$(<"$active_corrupt_measure_error")"
  if [[ "$active_corrupt_measure_actual" != \
    "$active_corrupt_measure_expected" ]]; then
    active_corrupt_measure_bytes="$(wc -c \
      <"$active_corrupt_measure_error" | tr -d ' ')"
    if ((${#active_corrupt_measure_actual} > 512)) || \
      [[ "$active_corrupt_measure_actual" == *"$secret_canary"* ]]; then
      active_corrupt_measure_actual="redacted-bytes-$active_corrupt_measure_bytes"
    else
      active_corrupt_measure_actual=${active_corrupt_measure_actual//$test_root/<test-root>}
      active_corrupt_measure_actual=${active_corrupt_measure_actual//$HUB_ROOT/<source-root>}
      active_corrupt_measure_actual=${active_corrupt_measure_actual//$'\r'/';'}
      active_corrupt_measure_actual=${active_corrupt_measure_actual//$'\n'/';'}
    fi
    printf -v active_corrupt_measure_actual_quoted '%q' \
      "$active_corrupt_measure_actual"
    printf -v active_corrupt_measure_expected_quoted '%q' \
      "$active_corrupt_measure_expected"
    fail "state snapshot active-prefix $active_corrupt_tail priority changed: actual=$active_corrupt_measure_actual_quoted expected=$active_corrupt_measure_expected_quoted"
  fi
  assert_active_restore_preflight \
    "restore with active event prefix and $active_corrupt_tail tail"
done
cp "$active_priority_events_original" "$state_root/events.jsonl"
chmod 0600 "$state_root/events.jsonl"

# Ledger state is checked before terminal-ledger shape, so one real restore
# covers the request-level pending/offered/inflight/queued/running family.
"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  value.request.state = "running";
  delete value.request.result;
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
' "$request_ledger_root/$request_hash.json"
chmod 0600 "$request_ledger_root/$request_hash.json"
assert_active_restore_preflight 'restore with an active running request ledger'
cp "$active_priority_ledger_original" "$request_ledger_root/$request_hash.json"
chmod 0600 "$request_ledger_root/$request_hash.json"
"$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" measure "$state_root" >/dev/null ||
  fail 'active-work restore negatives did not restore the valid fixture'
"$systemctl_mock" start agent-os-hub.service

"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const events = fs.readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  events[0].payload.title = "destroyed-copy";
  fs.writeFileSync(path, `${events.map(JSON.stringify).join("\n")}\n`);
' "$state_root/events.jsonl"
"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  Object.values(value.placements)[0].hostId = "destroyed-copy";
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
' "$state_root/remote-placement.json"
"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const value = JSON.parse(fs.readFileSync(path, "utf8"));
  value.request.result.text = "destroyed-copy";
  value.request.events.at(-1).result.text = "destroyed-copy";
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
' "$request_ledger_root/$request_hash.json"
chmod 0600 \
  "$state_root/events.jsonl" \
  "$state_root/remote-placement.json" \
  "$request_ledger_root/$request_hash.json"
destroyed_state_hash="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")"
state_restore_output="$(
  /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$state_backup_id" --manifest-sha256 "$state_backup_digest"
)" || fail 'real state-admin restore failed after test-state destruction'
state_restore_result=${state_restore_output##*$'\n'}
[[ "$state_restore_result" == hub_state_restore\ status=ok\ snapshot="$state_backup_id"\ manifest_sha256="$state_backup_digest"\ retained_previous=* ]] ||
  fail 'real state-admin restore emitted an invalid result contract'
restored_measurement="$(
  "$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" measure "$state_root"
)" || fail 'restored state failed strict offline validation'
"$REAL_NODE_BIN" -e '
  const value = JSON.parse(process.argv[1]);
  if (value.eventCount !== 2 || value.placementCount !== 1 ||
      value.requestCount !== 1) process.exit(1);
' "$restored_measurement" ||
  fail 'restored state lost event, placement or terminal request ledger records'
restored_state_hash="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")"
[[ "$restored_state_hash" != "$destroyed_state_hash" ]] ||
  fail 'restore did not replace the destroyed state copy'
"$systemctl_mock" stop agent-os-hub.service
"$systemctl_mock" start agent-os-hub.service
[[ "$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")" == "$restored_state_hash" ]] ||
  fail 'restored state changed across a subsequent Hub restart'

read -r restore_required_bytes restore_required_inodes < <(
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(`${value.bytes} ${value.files + value.directories}\n`);
  ' "$state_backup_summary"
) || fail 'could not derive restore capacity demand from verified snapshot metadata'
current_capacity_measurement="$(
  "$REAL_NODE_BIN" "$fixed_bin/tree-digest.mjs" "$state_root"
)" || fail 'could not structurally measure current state for restore peak-capacity testing'
read -r current_required_bytes current_required_inodes < <(
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(`${value.totalBytes} ${value.entryCount}\n`);
  ' "$current_capacity_measurement"
) || fail 'could not derive current-state restore capacity demand'
assert_restore_capacity_preflight() {
  local label=$1 before_log before_hash after_log capacity_log
  before_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  before_hash="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")"
  expect_failure \
    "$label" \
    /bin/bash -p "$fixed_bin/state-admin.sh" restore \
      --snapshot "$state_backup_id" --manifest-sha256 "$state_backup_digest"
  [[ ! -e "$AGENT_OS_MOCK_CAPACITY_STATFS_ONCE" ]] ||
    fail "$label did not reach the combined restore-capacity gate"
  after_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  capacity_log="$(sed -n "$((before_log + 1)),${after_log}p" \
    "$AGENT_OS_MOCK_SYSTEMCTL_LOG")"
  if printf '%s\n' "$capacity_log" | grep -Eq \
    '^(start|stop|enable|disable|reset-failed)( |$)'; then
    fail "$label mutated systemd state before the capacity rejection"
  fi
  [[ "$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")" == "$before_hash" ]] ||
    fail "$label changed live state before the capacity rejection"
  [[ ! -e "$test_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$test_root/run/agent-os/hub-maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "$label entered persistent or runtime maintenance before the capacity rejection"
  [[ -z "$(find "$test_root/var/lib/agent-os" -maxdepth 1 -type d \
    -name '.hub.restore-*' -print -quit)" ]] ||
    fail "$label published restore staging before the capacity rejection"
}

combined_restore_bytes="$((1073741824 + restore_required_bytes + current_required_bytes))"
combined_restore_inodes="$((1024 + restore_required_inodes + current_required_inodes))"
((combined_restore_bytes - 1 >= 1073741824 + restore_required_bytes && \
  combined_restore_bytes - 1 >= 1073741824 + current_required_bytes)) ||
  fail 'byte capacity fixture does not prove both individual demands fit'
((combined_restore_inodes - 1 >= 1024 + restore_required_inodes && \
  combined_restore_inodes - 1 >= 1024 + current_required_inodes)) ||
  fail 'inode capacity fixture does not prove both individual demands fit'
printf '{"state":{"bavail":"%s","bsize":"1","dev":"7","ffree":"%s"},"backup":{"bavail":"%s","bsize":"1","dev":"7","ffree":"%s"}}\n' \
  "$((combined_restore_bytes - 1))" \
  "$combined_restore_inodes" \
  "$((combined_restore_bytes - 1))" \
  "$combined_restore_inodes" \
  >"$AGENT_OS_MOCK_CAPACITY_STATFS_ONCE"
assert_restore_capacity_preflight \
  'restore accepted same-filesystem aggregate capacity one byte below peak demand'
printf '{"state":{"bavail":"%s","bsize":"1","dev":"7","ffree":"%s"},"backup":{"bavail":"%s","bsize":"1","dev":"7","ffree":"%s"}}\n' \
  "$combined_restore_bytes" \
  "$((combined_restore_inodes - 1))" \
  "$combined_restore_bytes" \
  "$((combined_restore_inodes - 1))" \
  >"$AGENT_OS_MOCK_CAPACITY_STATFS_ONCE"
assert_restore_capacity_preflight \
  'restore accepted same-filesystem aggregate inode capacity one below peak demand'

recover_test_state_from_signed_snapshot() {
  local parent_transaction= chained_count=0 metadata intent
  local recovery_error="$temporary/explicit-state-recovery.err" token_trace error_tail
  local restore_call_label
  restore_token_call_sequence=$((restore_token_call_sequence + 1))
  printf -v restore_call_label \
    'restore-call-%06d' "$restore_token_call_sequence"
  last_restore_token_call_label=$restore_call_label
  local -a restore_arguments=(
    restore
    --snapshot "$state_backup_id"
    --manifest-sha256 "$state_backup_digest"
  )
  if [[ -f "$test_root/var/lib/agent-os-ops/hub-block" ]]; then
    parent_transaction="$(<"$test_root/var/lib/agent-os-ops/hub-block")"
    parent_transaction=${parent_transaction#agent-os-hub-recovery-block-v1:}
    [[ "$parent_transaction" =~ ^(backup|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] ||
      fail 'explicit recovery encountered an invalid parent transaction binding'
    restore_arguments+=(--from-transaction "$parent_transaction")
  fi
  record_restore_token_harness_checkpoint \
    helper-entry "$restore_call_label"
  if ! env AGENT_OS_MOCK_RESTORE_TOKEN_CALL_LABEL="$restore_call_label" \
    /bin/bash -p "$fixed_bin/state-admin.sh" "${restore_arguments[@]}" \
    >/dev/null 2>"$recovery_error"; then
    token_trace="$(tail -n 20 "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE" | \
      tr '\r\n' ';;' | cut -c 1-2048)"
    error_tail="$(tail -n 2 "$recovery_error" | \
      sed "s#${test_root//\#/\\#}#<test-root>#g" | tr '\r\n' ';;' | cut -c 1-1024)"
    fail "explicit test-state recovery failed: token_trace=$token_trace stderr=$error_tail"
  fi
  if [[ -n "$parent_transaction" ]]; then
    for metadata in "$test_root/var/lib/agent-os-ops/private"/restore-*/metadata; do
      [[ -f "$metadata" ]] || continue
      grep -Fxq "parent_transaction=$parent_transaction" "$metadata" || continue
      intent="${metadata%/metadata}/intent"
      [[ -f "$intent" ]] ||
        fail 'parent-bound restore metadata lacks its durable intent'
      grep -Fxq "parent_transaction=$parent_transaction" "$intent" ||
        fail 'restore intent and metadata disagree about their parent transaction'
      chained_count=$((chained_count + 1))
    done
    [[ "$chained_count" == 1 ]] ||
      fail 'explicit recovery did not create exactly one positive parent transaction chain'
  fi
  [[ -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail 'explicit test-state recovery did not restore active/enabled service state'
  [[ ! -e "$test_root/run/agent-os/hub-maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$test_root/run/agent-os/hub-recovery-start" && \
    ! -e "$test_root/var/lib/agent-os-ops/hub-block" ]] ||
    fail 'explicit test-state recovery did not clear every recovery gate'
}

# Build a second, semantically valid target snapshot so phase-kill recovery can
# prove it restores the preserved pre-restore tree rather than merely accepting
# whichever tree happens to be present.
if [[ "$VERIFY_FOCUS" != rollback-stop-parent-restore ]]; then
printf '%s\n' target-state-b >"$state_sentinel"
chmod 0600 "$state_sentinel"
target_backup_output="$(
  /bin/bash -p "$fixed_bin/state-admin.sh" backup --label phase-target
)" || fail 'phase-kill target backup failed'
target_backup_result=${target_backup_output##*$'\n'}
[[ "$target_backup_result" =~ ^hub_state_backup\ status=ok\ snapshot=([A-Za-z0-9._-]+)\ manifest_sha256=([a-f0-9]{64})$ ]] ||
  fail 'phase-kill target backup emitted an invalid result contract'
phase_target_snapshot=${BASH_REMATCH[1]}
phase_target_digest=${BASH_REMATCH[2]}
phase_target_summary="$(
  "$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" verify \
    "$test_root/var/backups/agent-os/hub/$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest"
)" || fail 'phase-kill target snapshot could not be independently verified'
phase_target_tree="$(
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    if (!/^[a-f0-9]{64}$/u.test(value.treeSha256)) process.exit(1);
    process.stdout.write(value.treeSha256);
  ' "$phase_target_summary"
)" || fail 'phase-kill target snapshot lacks a valid semantic tree digest'
recover_test_state_from_signed_snapshot
semantic_tree_sha256() {
  local measurement
  measurement="$($REAL_NODE_BIN "$fixed_bin/state-snapshot.mjs" measure "$1")" || return 1
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    if (!/^[a-f0-9]{64}$/u.test(value.treeSha256)) process.exit(1);
    process.stdout.write(value.treeSha256);
  ' "$measurement"
}
phase_baseline_tree="$(semantic_tree_sha256 "$state_root")" ||
  fail 'phase-kill baseline is not semantically replayable'

raw_tree_sha256() {
  local measurement
  measurement="$($REAL_NODE_BIN "$fixed_bin/tree-digest.mjs" "$1")" || return 1
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    if (!/^[a-f0-9]{64}$/u.test(value.treeSha256)) process.exit(1);
    process.stdout.write(value.treeSha256);
  ' "$measurement"
}

# Crash after metadata is durable but before prepared is a distinct window: the
# persistent block is still bound to the signed parent recovery transaction.
# recover-old must preserve that audit edge and converge the metadata-only
# journal without requiring an impossible child restore.
rm -f -- "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED"
printf '%s\n' metadata >"$AGENT_OS_MOCK_KILL_AFTER_JOURNAL_PUBLICATION"
if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
  --snapshot "$phase_target_snapshot" \
  --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
  fail 'metadata-only restore window ignored the SIGKILL probe'
else
  metadata_only_kill_status=$?
fi
[[ "$metadata_only_kill_status" == 137 && \
  ! -e "$AGENT_OS_MOCK_KILL_AFTER_JOURNAL_PUBLICATION" && \
  -s "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED" ]] ||
  fail 'metadata-only restore did not terminate at its durable boundary'
metadata_only_transaction="$(<"$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED")"
metadata_only_journal="$test_root/var/lib/agent-os-ops/private/$metadata_only_transaction"
metadata_only_parent="$(sed -n 's/^parent_transaction=//p' \
  "$metadata_only_journal/metadata")"
metadata_only_intent_parent="$(sed -n 's/^parent_transaction=//p' \
  "$metadata_only_journal/intent")"
[[ "$metadata_only_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
  "$metadata_only_parent" =~ ^recovery-pre-[A-Za-z0-9._-]{1,128}$ && \
  "$metadata_only_intent_parent" == "$metadata_only_parent" && \
  -f "$metadata_only_journal/metadata" && \
  ! -e "$metadata_only_journal/prepared" && \
  -f "$recovery_block" && \
  "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$metadata_only_parent" && \
  -d "$state_root" && \
  ! -e "$test_root/var/lib/agent-os/.hub.restore-$metadata_only_transaction" && \
  ! -e "$test_root/var/lib/agent-os/hub.pre-restore-$metadata_only_transaction" ]] ||
  fail 'metadata-only restore window lost its parent-bound topology or audit chain'
metadata_only_intent_hash="$(sha256_file "$metadata_only_journal/intent")"
metadata_only_metadata_hash="$(sha256_file "$metadata_only_journal/metadata")"
metadata_only_recovery_output="$(
  /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
    --transaction "$metadata_only_transaction"
)" || fail 'recover-old deadlocked on the parent-bound metadata-only journal'
metadata_only_recovery_result=${metadata_only_recovery_output##*$'\n'}
[[ "$metadata_only_recovery_result" == \
  hub_state_recover_old\ status=ok\ transaction="$metadata_only_transaction"\ snapshot=*\ manifest_sha256=* && \
  "$(sha256_file "$metadata_only_journal/intent")" == "$metadata_only_intent_hash" && \
  "$(sha256_file "$metadata_only_journal/metadata")" == "$metadata_only_metadata_hash" && \
  -f "$metadata_only_journal/rolled_back" && \
  "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
  ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
  ! -e "$recovery_token" && \
  -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'metadata-only recover-old lost audit metadata or failed to converge safely'

run_forensic_recovery_case() {
# Keep semantically valid divergence (above) distinct from corrupt-current
# handling. Malformed JSONL, a malformed terminal ledger and invalid UTF-8 must
# be copied byte-for-byte into a non-reactivatable forensic artifact. A crash
# at old_moved must reject recover-old rollback, then accept only a new verified
# restore explicitly chained to the blocked restore transaction.
target_manifest_hash_before="$(sha256_file "$state_backup_path/manifest.json")"
corrupt_event_hash=
corrupt_ledger_hash=
"$REAL_NODE_BIN" -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], Buffer.concat([
    Buffer.from("{\"version\":1,\"malformed\":", "utf8"),
    Buffer.from([0xff]),
    Buffer.from("\n", "utf8"),
  ]));
  fs.writeFileSync(process.argv[2], Buffer.concat([
    Buffer.from("{\"request\":", "utf8"),
    Buffer.from([0xff]),
    Buffer.from("\n", "utf8"),
  ]));
' "$state_root/events.jsonl" "$request_ledger_root/$request_hash.json"
chmod 0600 "$state_root/events.jsonl" "$request_ledger_root/$request_hash.json"
corrupt_event_hash="$(sha256_file "$state_root/events.jsonl")"
corrupt_ledger_hash="$(sha256_file "$request_ledger_root/$request_hash.json")"
  corrupt_raw_tree="$(raw_tree_sha256 "$state_root")" ||
    fail 'corrupt-current fixture could not be structurally measured'
  corrupt_measure_output="$temporary/corrupt-measure.out"
  corrupt_measure_error="$temporary/corrupt-measure.err"
  if "$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" measure "$state_root" \
    >"$corrupt_measure_output" 2>"$corrupt_measure_error"; then
    fail 'corrupt-current fixture remained semantically replayable'
  fi
  if grep -Fq -- "$secret_canary" \
    "$corrupt_measure_output" "$corrupt_measure_error"; then
    fail 'corrupt-current measurement stdout or stderr disclosed the opaque secret'
  fi
  printf '%s\n' old_moved >"$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE"
  forensic_restore_output="$temporary/forensic-restore.out"
  forensic_restore_error="$temporary/forensic-restore.err"
  if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$state_backup_id" \
    --manifest-sha256 "$state_backup_digest" \
    >"$forensic_restore_output" 2>"$forensic_restore_error"; then
    fail 'forensic old_moved restore ignored the SIGKILL probe'
else
  forensic_kill_status=$?
fi
  [[ "$forensic_kill_status" == 137 && \
    ! -e "$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE" && \
    -f "$recovery_block" ]] ||
    fail 'forensic restore did not terminate at the durable old_moved boundary'
  if grep -Fq -- "$secret_canary" \
    "$forensic_restore_output" "$forensic_restore_error"; then
    fail 'forensic restore stdout or stderr disclosed the opaque secret'
  fi
forensic_transaction="$(<"$recovery_block")"
forensic_transaction=${forensic_transaction#agent-os-hub-recovery-block-v1:}
forensic_journal="$test_root/var/lib/agent-os-ops/private/$forensic_transaction"
forensic_retired="$test_root/var/lib/agent-os/hub.pre-restore-$forensic_transaction"
forensic_staging="$test_root/var/lib/agent-os/.hub.restore-$forensic_transaction"
[[ "$forensic_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
  ! -e "$state_root" && -d "$forensic_retired" && -d "$forensic_staging" && \
  -f "$forensic_journal/old_moved" && \
  ! -e "$forensic_journal/new_activated" && \
  -f "$forensic_journal/metadata" && \
  "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$forensic_transaction" ]] ||
  fail 'forensic old_moved crash topology lost current, staging or journal evidence'
grep -Fxq 'preservation_mode=forensic' "$forensic_journal/metadata" ||
  fail 'corrupt-current restore was mislabeled as a strict replayable snapshot'
forensic_snapshot_id="$(sed -n 's/^preserved_snapshot=//p' "$forensic_journal/metadata")"
forensic_snapshot_digest="$(sed -n 's/^preserved_manifest_sha256=//p' "$forensic_journal/metadata")"
[[ "$forensic_snapshot_id" =~ ^forensic-current-[A-Za-z0-9._-]+$ && \
  "$forensic_snapshot_digest" =~ ^[a-f0-9]{64}$ ]] ||
  fail 'forensic restore metadata lacks a signed artifact identity'
forensic_snapshot_path="$test_root/var/backups/agent-os/hub/$forensic_snapshot_id"
  forensic_verify_error="$temporary/forensic-verify.err"
  forensic_summary="$(
    "$REAL_NODE_BIN" "$fixed_bin/state-forensic.mjs" verify \
      "$forensic_snapshot_path" --manifest-sha256 "$forensic_snapshot_digest" \
      2>"$forensic_verify_error"
  )" || fail 'corrupt-current forensic artifact failed independent verification'
forensic_secret_artifact="$forensic_snapshot_path/data/private-opaque.bin"
forensic_secret_root_mode="$(stat -c '%a' "$forensic_snapshot_path" 2>/dev/null || \
  stat -f '%Lp' "$forensic_snapshot_path")"
forensic_secret_file_mode="$(stat -c '%a' "$forensic_secret_artifact" 2>/dev/null || \
  stat -f '%Lp' "$forensic_secret_artifact")"
forensic_secret_root_uid="$(stat -c '%u' "$forensic_snapshot_path" 2>/dev/null || \
  stat -f '%u' "$forensic_snapshot_path")"
forensic_secret_file_uid="$(stat -c '%u' "$forensic_secret_artifact" 2>/dev/null || \
  stat -f '%u' "$forensic_secret_artifact")"
forensic_secret_root_type=missing
forensic_secret_root_gid=unavailable
forensic_secret_root_links=unavailable
forensic_secret_file_type=missing
forensic_secret_file_gid=unavailable
forensic_secret_file_links=unavailable
forensic_secret_file_hash=unavailable
forensic_secret_expected_hash=unavailable
if [[ -e "$forensic_snapshot_path" || -L "$forensic_snapshot_path" ]]; then
  forensic_secret_root_type="$(stat -c '%F' "$forensic_snapshot_path" 2>/dev/null || \
    stat -f '%HT' "$forensic_snapshot_path" 2>/dev/null || printf unavailable)"
  forensic_secret_root_gid="$(stat -c '%g' "$forensic_snapshot_path" 2>/dev/null || \
    stat -f '%g' "$forensic_snapshot_path" 2>/dev/null || printf unavailable)"
  forensic_secret_root_links="$(stat -c '%h' "$forensic_snapshot_path" 2>/dev/null || \
    stat -f '%l' "$forensic_snapshot_path" 2>/dev/null || printf unavailable)"
fi
if [[ -e "$forensic_secret_artifact" || -L "$forensic_secret_artifact" ]]; then
  forensic_secret_file_type="$(stat -c '%F' "$forensic_secret_artifact" 2>/dev/null || \
    stat -f '%HT' "$forensic_secret_artifact" 2>/dev/null || printf unavailable)"
  forensic_secret_file_gid="$(stat -c '%g' "$forensic_secret_artifact" 2>/dev/null || \
    stat -f '%g' "$forensic_secret_artifact" 2>/dev/null || printf unavailable)"
  forensic_secret_file_links="$(stat -c '%h' "$forensic_secret_artifact" 2>/dev/null || \
    stat -f '%l' "$forensic_secret_artifact" 2>/dev/null || printf unavailable)"
  forensic_secret_file_hash="$(sha256_file "$forensic_secret_artifact" 2>/dev/null || \
    printf unavailable)"
fi
if [[ -f "$forensic_retired/private-opaque.bin" && \
  ! -L "$forensic_retired/private-opaque.bin" ]]; then
  forensic_secret_expected_hash="$(
    sha256_file "$forensic_retired/private-opaque.bin" 2>/dev/null || printf unavailable
  )"
fi
if ! [[ -f "$forensic_secret_artifact" && ! -L "$forensic_secret_artifact" && \
  "$(<"$forensic_secret_artifact")" == "$secret_canary" && \
  "$forensic_secret_root_mode" == 500 && \
  "$forensic_secret_file_mode" == 400 && \
  "$forensic_secret_root_uid" == "$EUID" && \
  "$forensic_secret_file_uid" == "$EUID" ]]; then
  fail "forensic artifact did not preserve the opaque secret under private ownership: root_type=$forensic_secret_root_type root_uid=$forensic_secret_root_uid root_gid=$forensic_secret_root_gid root_mode=$forensic_secret_root_mode root_links=$forensic_secret_root_links file_type=$forensic_secret_file_type file_uid=$forensic_secret_file_uid file_gid=$forensic_secret_file_gid file_mode=$forensic_secret_file_mode file_links=$forensic_secret_file_links file_sha256=$forensic_secret_file_hash expected_sha256=$forensic_secret_expected_hash"
fi
  if printf '%s\n' "$forensic_summary" | grep -Fq -- "$secret_canary" || \
    grep -Fq -- "$secret_canary" "$forensic_verify_error" || \
    grep -Fq -- "$secret_canary" "$forensic_snapshot_path/manifest.json" || \
  grep -R -Fq -- "$secret_canary" "$ops_root/private" || \
  grep -Fq -- "$secret_canary" "$AGENT_OS_MOCK_SYSTEMCTL_LOG"; then
  fail 'forensic command output, manifest, journal or evidence disclosed the opaque secret'
fi
forensic_tree="$(
  "$REAL_NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    if (!/^[a-f0-9]{64}$/u.test(value.treeSha256)) process.exit(1);
    process.stdout.write(value.treeSha256);
  ' "$forensic_summary"
)" || fail 'forensic artifact summary lacks a tree digest'
grep -Fxq "preserved_tree_sha256=$forensic_tree" "$forensic_journal/metadata" ||
  fail 'forensic journal does not bind the verified forensic manifest tree'
grep -Fxq "preserved_state_sha256=$corrupt_raw_tree" "$forensic_journal/metadata" ||
  fail 'forensic journal does not bind the raw corrupt source tree'
[[ "$(raw_tree_sha256 "$forensic_retired")" == "$corrupt_raw_tree" ]] ||
  fail 'forensic old_moved copy changed the raw corrupt source tree'
[[ "$(sha256_file "$forensic_snapshot_path/data/events.jsonl")" == "$corrupt_event_hash" && \
  "$(sha256_file "$forensic_snapshot_path/data/remote-placement.json.requests/$request_hash.json")" == "$corrupt_ledger_hash" ]] ||
  fail 'forensic artifact changed malformed JSON or invalid UTF-8 bytes'
[[ "$(sha256_file "$forensic_retired/events.jsonl")" == "$corrupt_event_hash" && \
  "$(sha256_file "$forensic_retired/remote-placement.json.requests/$request_hash.json")" == "$corrupt_ledger_hash" ]] ||
  fail 'retired corrupt state changed malformed JSON or invalid UTF-8 bytes'
[[ "$(sha256_file "$state_backup_path/manifest.json")" == "$target_manifest_hash_before" ]] ||
  fail 'forensic preservation modified the unique verified target snapshot'

forensic_recovery_log_before="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
forensic_journal_count_before="$(find "$test_root/var/lib/agent-os-ops/private" \
  -mindepth 1 -maxdepth 1 -type d -name 'restore-*' | awk 'END { print NR + 0 }')"
forensic_metadata_hash_before="$(sha256_file "$forensic_journal/metadata")"
forensic_parent_before="$(sed -n 's/^parent_transaction=//p' "$forensic_journal/metadata")"
expect_failure \
  'restore created a child transaction from an existing restore journal' \
  /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$state_backup_id" \
    --manifest-sha256 "$state_backup_digest" \
    --from-transaction "$forensic_transaction"
[[ "$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')" == \
  "$forensic_recovery_log_before" && \
  "$(find "$test_root/var/lib/agent-os-ops/private" \
    -mindepth 1 -maxdepth 1 -type d -name 'restore-*' | awk 'END { print NR + 0 }')" == \
    "$forensic_journal_count_before" && \
  ! -e "$state_root" && -d "$forensic_retired" && -d "$forensic_staging" && \
  "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$forensic_transaction" ]] ||
  fail 'child restore rejection mutated forensic old_moved topology'

  forensic_recovery_error="$temporary/forensic-recovery.err"
  forensic_replacement_output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$forensic_transaction" 2>"$forensic_recovery_error"
  )" || fail 'recover-old could not resume forensic old_moved toward the verified target'
  forensic_replacement_result=${forensic_replacement_output##*$'\n'}
  if printf '%s\n' "$forensic_replacement_output" | grep -Fq -- "$secret_canary" || \
    grep -Fq -- "$secret_canary" "$forensic_recovery_error"; then
    fail 'forensic recovery stdout or stderr disclosed the opaque secret'
  fi
[[ "$forensic_replacement_result" == \
  hub_state_recover_old\ status=forward_completed\ transaction="$forensic_transaction"\ snapshot="$state_backup_id"\ manifest_sha256="$state_backup_digest" ]] ||
  fail 'forensic forward recovery emitted an invalid result contract'
[[ "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
  ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
  ! -e "$recovery_token" && \
  -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'forensic forward recovery did not activate target and clear every gate'
[[ -f "$forensic_journal/committed" && \
  ! -e "$forensic_journal/rolled_back" && \
  "$(sha256_file "$forensic_journal/metadata")" == "$forensic_metadata_hash_before" && \
  "$(sed -n 's/^parent_transaction=//p' "$forensic_journal/metadata")" == \
    "$forensic_parent_before" && \
  "$(find "$test_root/var/lib/agent-os-ops/private" \
    -mindepth 1 -maxdepth 1 -type d -name 'restore-*' | awk 'END { print NR + 0 }')" == \
    "$forensic_journal_count_before" ]] ||
  fail 'forensic forward recovery rolled back, rewrote metadata or created a child journal'
[[ "$(raw_tree_sha256 "$forensic_retired")" == "$corrupt_raw_tree" && \
  "$(sha256_file "$forensic_retired/events.jsonl")" == "$corrupt_event_hash" && \
  "$(sha256_file "$forensic_retired/remote-placement.json.requests/$request_hash.json")" == "$corrupt_ledger_hash" && \
  "$(sha256_file "$state_backup_path/manifest.json")" == "$target_manifest_hash_before" ]] ||
  fail 'forensic forward recovery changed corrupt evidence or its unique target snapshot'
"$REAL_NODE_BIN" "$fixed_bin/state-forensic.mjs" verify \
  "$forensic_snapshot_path" --manifest-sha256 "$forensic_snapshot_digest" >/dev/null ||
  fail 'forensic forward recovery deleted or changed the evidence artifact'
}

# Journal publication must not overwrite the parent's fd 9, which carries the
# global deployment flock. On hosts with the audited flock binary, pause after
# each durable publication kind and prove an independent deployment lock probe
# is rejected until the restore process exits.
real_flock_bin="$(command -v flock || true)"
if [[ "$real_flock_bin" == /* && -f "$real_flock_bin" && -x "$real_flock_bin" ]]; then
  for journal_lock_phase in intent metadata prepared; do
    rm -f -- \
      "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED" \
      "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_RELEASE"
    printf '%s\n' "$journal_lock_phase" \
      >"$AGENT_OS_MOCK_PAUSE_AFTER_JOURNAL_PUBLICATION"
    journal_lock_restore_output="$temporary/journal-lock-$journal_lock_phase.out"
    env AGENT_OS_FLOCK_BIN="$real_flock_bin" \
      /bin/bash -p "$fixed_bin/state-admin.sh" restore \
        --snapshot "$phase_target_snapshot" \
        --manifest-sha256 "$phase_target_digest" \
        >"$journal_lock_restore_output" 2>&1 &
    journal_lock_restore_pid=$!
    journal_lock_reached=false
    for ((journal_lock_wait=0; journal_lock_wait<1000; journal_lock_wait++)); do
      if [[ -s "$AGENT_OS_MOCK_JOURNAL_PUBLICATION_REACHED" ]]; then
        journal_lock_reached=true
        break
      fi
      kill -0 "$journal_lock_restore_pid" >/dev/null 2>&1 || break
      sleep 0.01
    done
    if [[ "$journal_lock_reached" != true ]]; then
      : >"$AGENT_OS_MOCK_JOURNAL_PUBLICATION_RELEASE"
      wait "$journal_lock_restore_pid" >/dev/null 2>&1 || true
      fail "$journal_lock_phase journal publication did not reach its lock probe"
    fi
    if journal_lock_probe_output="$(
      env AGENT_OS_FLOCK_BIN="$real_flock_bin" \
        /bin/bash -p -c 'source "$1"; acquire_deploy_lock' \
          _ "$fixed_bin/lib.sh" 2>&1
    )"; then
      journal_lock_rejected=false
    else
      journal_lock_rejected=true
    fi
    : >"$AGENT_OS_MOCK_JOURNAL_PUBLICATION_RELEASE"
    if ! wait "$journal_lock_restore_pid"; then
      fail "$journal_lock_phase journal restore failed after releasing its lock probe"
    fi
    [[ "$journal_lock_rejected" == true && \
      "$journal_lock_probe_output" == \
        'Hub deployment failed: another Hub deployment operation holds the global lock' ]] ||
      fail "$journal_lock_phase journal publication released or replaced the global flock"
    [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" ]] ||
      fail "$journal_lock_phase journal lock probe changed the committed target"
    env AGENT_OS_FLOCK_BIN="$real_flock_bin" \
      /bin/bash -p "$fixed_bin/state-admin.sh" restore \
        --snapshot "$state_backup_id" \
        --manifest-sha256 "$state_backup_digest" >/dev/null ||
      fail "$journal_lock_phase lock probe could not restore its baseline"
    [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" ]] ||
      fail "$journal_lock_phase lock probe baseline did not replay"
  done
fi

# A process death after the journal body write, both before and after the file
# fsync, must leave a private 0400 temporary that recover-old recognizes,
# removes, fsyncs away and then safely resumes. This also proves the mode is
# fixed at O_EXCL creation time rather than by a later chmod window.
for journal_temp_boundary in before-fsync after-fsync; do
  rm -f -- "$AGENT_OS_MOCK_RESTORE_JOURNAL_TEMP_PATH"
  printf 'prepared:%s\n' "$journal_temp_boundary" \
    >"$AGENT_OS_MOCK_KILL_RESTORE_JOURNAL_TEMP"
  if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
    fail "restore journal $journal_temp_boundary probe did not kill publication"
  else
    journal_temp_kill_status=$?
  fi
  [[ "$journal_temp_kill_status" == 137 && \
    ! -e "$AGENT_OS_MOCK_KILL_RESTORE_JOURNAL_TEMP" && \
    -s "$AGENT_OS_MOCK_RESTORE_JOURNAL_TEMP_PATH" && \
    -f "$recovery_block" ]] ||
    fail "restore journal $journal_temp_boundary probe missed its exact boundary"
  journal_temp_path="$(<"$AGENT_OS_MOCK_RESTORE_JOURNAL_TEMP_PATH")"
  journal_temp_transaction="$(<"$recovery_block")"
  journal_temp_transaction=${journal_temp_transaction#agent-os-hub-recovery-block-v1:}
  journal_temp_root="$test_root/var/lib/agent-os-ops/private/$journal_temp_transaction"
  [[ "$journal_temp_path" == "$journal_temp_root"/.prepared-*.tmp && \
    -f "$journal_temp_path" && ! -L "$journal_temp_path" && \
    "$(stat -c '%a' "$journal_temp_path" 2>/dev/null || stat -f '%Lp' "$journal_temp_path")" == 400 && \
    "$(stat -c '%u' "$journal_temp_path" 2>/dev/null || stat -f '%u' "$journal_temp_path")" == "$EUID" && \
    "$(stat -c '%g' "$journal_temp_path" 2>/dev/null || stat -f '%g' "$journal_temp_path")" == "$(id -g)" && \
    "$(stat -c '%h' "$journal_temp_path" 2>/dev/null || stat -f '%l' "$journal_temp_path")" == 1 && \
    ! -e "$journal_temp_root/prepared" ]] ||
    fail "restore journal $journal_temp_boundary temporary was not private from creation"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" ]] ||
    fail "restore journal $journal_temp_boundary crash changed live state"
  journal_temp_recovery_output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$journal_temp_transaction"
  )" || fail "recover-old rejected its legal $journal_temp_boundary temporary"
  journal_temp_recovery_result=${journal_temp_recovery_output##*$'\n'}
  [[ "$journal_temp_recovery_result" == \
    hub_state_recover_old\ status=ok\ transaction="$journal_temp_transaction"\ snapshot=*\ manifest_sha256=* && \
    ! -e "$journal_temp_path" && \
    -f "$journal_temp_root/rolled_back" && \
    "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" ]] ||
    fail "recover-old did not safely continue after $journal_temp_boundary temporary cleanup"
  [[ ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" && \
    -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "recover-old did not sign off $journal_temp_boundary temporary recovery"
done

assert_malicious_journal_temporary_rejected() {
  local label=$1 path=$2 before_log before_tree block_value
  before_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  before_tree="$(semantic_tree_sha256 "$state_root")" ||
    fail "$label began with a non-replayable state tree"
  block_value="$(<"$recovery_block")"
  expect_failure \
    "$label was deleted or accepted by recover-old" \
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$killed_transaction"
  [[ -e "$path" || -L "$path" ]] ||
    fail "$label was destructively removed before validation"
  [[ "$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')" == "$before_log" ]] ||
    fail "$label reached systemd before journal temporary rejection"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$before_tree" && \
    "$(<"$recovery_block")" == "$block_value" ]] ||
    fail "$label changed state or recovery transaction binding"
}

for restore_kill_phase in prepared staged old_moved new_activated verified; do
  printf '%s\n' "$restore_kill_phase" >"$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE"
  if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
    fail "restore phase $restore_kill_phase ignored the SIGKILL probe"
  else
    restore_kill_status=$?
  fi
  [[ "$restore_kill_status" == 137 && \
    ! -e "$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE" ]] ||
    fail "restore phase $restore_kill_phase did not terminate at its durable boundary"
  [[ -f "$recovery_block" && ! -L "$recovery_block" ]] ||
    fail "restore phase $restore_kill_phase lost its persistent block"
  [[ ! -e "$recovery_token" && -f "$runtime_maintenance" ]] ||
    fail "restore phase $restore_kill_phase left a reusable token or lost runtime blocking"
  killed_transaction="$(<"$recovery_block")"
  killed_transaction=${killed_transaction#agent-os-hub-recovery-block-v1:}
  [[ "$killed_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    fail "restore phase $restore_kill_phase published an invalid transaction binding"
  killed_journal="$test_root/var/lib/agent-os-ops/private/$killed_transaction"
  [[ -f "$killed_journal/metadata" && -f "$killed_journal/$restore_kill_phase" ]] ||
    fail "restore phase $restore_kill_phase lacks durable metadata or phase evidence"
  [[ -z "$(find "$killed_journal" -maxdepth 1 -name '.*.tmp' -print -quit)" ]] ||
    fail "restore phase $restore_kill_phase rename boundary retained a journal temporary"

  if [[ "$restore_kill_phase" == prepared ]]; then
    wrong_bound_journal="$test_root/var/lib/agent-os-ops/private/restore-wrong-binding-probe"
    wrong_bound_temp="$wrong_bound_journal/.prepared-9-9.tmp"
    install -d -m 0700 "$wrong_bound_journal"
    printf '%s\n' legal-but-unbound >"$wrong_bound_temp"
    chmod 0400 "$wrong_bound_temp"
    wrong_bound_log_before="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
    expect_failure \
      'recover-old cleaned a legal temporary before binding its journal to the block' \
      /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
        --transaction restore-wrong-binding-probe
    [[ -f "$wrong_bound_temp" && \
      "$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')" == \
        "$wrong_bound_log_before" && \
      "$(<"$recovery_block")" == \
        "agent-os-hub-recovery-block-v1:$killed_transaction" ]] ||
      fail 'unbound recover-old mutated its legal temporary, systemd or block'
    rm -f -- "$wrong_bound_temp"
    rmdir "$wrong_bound_journal"

    malicious_temp="$killed_journal/.unexpected-1-1.tmp"
    printf '%s\n' malicious >"$malicious_temp"
    chmod 0400 "$malicious_temp"
    assert_malicious_journal_temporary_rejected \
      'unrecognized restore journal temporary name' "$malicious_temp"
    rm -f -- "$malicious_temp"

    malicious_temp="$killed_journal/.prepared-1-1.tmp"
    printf '%s\n' malicious >"$malicious_temp"
    chmod 0600 "$malicious_temp"
    assert_malicious_journal_temporary_rejected \
      'writable restore journal temporary mode' "$malicious_temp"
    rm -f -- "$malicious_temp"

    malicious_temp="$killed_journal/.prepared-2-2.tmp"
    malicious_link="$killed_journal/journal-temp-hardlink"
    printf '%s\n' malicious >"$malicious_temp"
    chmod 0400 "$malicious_temp"
    ln "$malicious_temp" "$malicious_link"
    assert_malicious_journal_temporary_rejected \
      'multiply-linked restore journal temporary' "$malicious_temp"
    rm -f -- "$malicious_temp" "$malicious_link"

    malicious_temp="$killed_journal/.prepared-3-3.tmp"
    ln -s metadata "$malicious_temp"
    assert_malicious_journal_temporary_rejected \
      'symbolic restore journal temporary' "$malicious_temp"
    rm -f -- "$malicious_temp"

    alternate_gid="$(id -G | tr ' ' '\n' | awk -v primary="$(id -g)" '$1 != primary { print; exit }')"
    if [[ -n "$alternate_gid" ]]; then
      malicious_temp="$killed_journal/.prepared-4-4.tmp"
      printf '%s\n' malicious >"$malicious_temp"
      chmod 0400 "$malicious_temp"
      chgrp "$alternate_gid" "$malicious_temp"
      assert_malicious_journal_temporary_rejected \
        'wrong-group restore journal temporary' "$malicious_temp"
      rm -f -- "$malicious_temp"
    fi
  fi

  before_wrong_recovery_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  expect_failure \
    "recover-old accepted the wrong transaction after $restore_kill_phase" \
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "restore-wrong-$restore_kill_phase"
  [[ "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$killed_transaction" ]] ||
    fail "wrong recover-old transaction changed the $restore_kill_phase block binding"
  [[ "$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')" == \
    "$before_wrong_recovery_log" ]] ||
    fail "wrong recover-old transaction reached systemd after $restore_kill_phase"

  case "$restore_kill_phase" in
    prepared)
      [[ -d "$state_root" && \
        ! -e "$test_root/var/lib/agent-os/.hub.restore-$killed_transaction" && \
        ! -e "$test_root/var/lib/agent-os/hub.pre-restore-$killed_transaction" ]] ||
        fail 'prepared kill topology is not the pre-materialize state'
      ;;
    staged)
      [[ -d "$state_root" && \
        -d "$test_root/var/lib/agent-os/.hub.restore-$killed_transaction" && \
        ! -e "$test_root/var/lib/agent-os/hub.pre-restore-$killed_transaction" ]] ||
        fail 'staged kill topology did not retain current and target staging trees'
      ;;
    old_moved)
      [[ ! -e "$state_root" && \
        -d "$test_root/var/lib/agent-os/.hub.restore-$killed_transaction" && \
        -d "$test_root/var/lib/agent-os/hub.pre-restore-$killed_transaction" ]] ||
        fail 'old_moved kill topology did not retain staging and retired trees'
      ;;
    new_activated | verified)
      [[ -d "$state_root" && \
        ! -e "$test_root/var/lib/agent-os/.hub.restore-$killed_transaction" && \
        -d "$test_root/var/lib/agent-os/hub.pre-restore-$killed_transaction" ]] ||
        fail "$restore_kill_phase kill topology did not retain active-new and retired trees"
      [[ "$(semantic_tree_sha256 "$state_root")" != "$phase_baseline_tree" ]] ||
        fail "$restore_kill_phase kill topology did not activate the target tree"
      ;;
  esac
  if [[ "$restore_kill_phase" == verified ]]; then
    [[ -f "$mock_state/active.agent-os-hub.service" && \
      ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
      fail 'verified kill topology must retain the started but not boot-enabled Hub'
  else
    [[ ! -f "$mock_state/active.agent-os-hub.service" && \
      ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
      fail "$restore_kill_phase kill topology left the Hub active or enabled"
  fi

  recover_old_output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$killed_transaction"
  )" || fail "recover-old failed from the $restore_kill_phase phase topology"
  recover_old_result=${recover_old_output##*$'\n'}
  [[ "$recover_old_result" == \
    hub_state_recover_old\ status=ok\ transaction="$killed_transaction"\ snapshot=*\ manifest_sha256=* ]] ||
    fail "recover-old emitted an invalid result after $restore_kill_phase"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" ]] ||
    fail "recover-old did not restore the preserved tree after $restore_kill_phase"
  [[ -f "$killed_journal/rolled_back" && ! -e "$killed_journal/committed" ]] ||
    fail "recover-old did not durably journal rollback after $restore_kill_phase"
  [[ ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" ]] ||
    fail "recover-old did not clear all recovery gates after $restore_kill_phase"
  [[ -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "recover-old did not sign off the service after $restore_kill_phase"
  killed_aborted_state="$test_root/var/lib/agent-os/hub.aborted-new-$killed_transaction"
  if [[ -d "$killed_aborted_state" && ! -L "$killed_aborted_state" ]]; then
    aborted_count=1
  else
    aborted_count=0
  fi
  if [[ "$restore_kill_phase" == prepared ]]; then
    [[ "$aborted_count" == 0 ]] ||
      fail 'prepared recover-old mislabeled the preserved old tree as aborted-new'
  else
    [[ "$aborted_count" == 1 && \
      "$(semantic_tree_sha256 "$killed_aborted_state")" == "$phase_target_tree" ]] ||
      fail "recover-old did not retain exactly one real target tree after $restore_kill_phase"
  fi
  [[ ! -e "$test_root/var/lib/agent-os/.hub.restore-$killed_transaction" && \
    ! -e "$test_root/var/lib/agent-os/.hub.recover-old-$killed_transaction" ]] ||
    fail "recover-old retained a staging tree after $restore_kill_phase"
done

assert_recover_old_aborted_artifact_rejected() {
  local label=$1 mutation=$2 transaction=$3 aborted=$4
  local genuine="$aborted.fixture-genuine"
  local corrupt_source before after log_before expected
  local wrong_measurement wrong_tree actual_first actual_hash actual_class
  local stdout_file stderr_file stdout_text stderr_text stdout_hash stderr_hash
  local stdout_lines stderr_lines allowed_fail_closed_tail log_after containment_log
  local unexpected_log unexpected_first unexpected_hash unexpected_lines
  local runtime_preflight expected_stderr helper_error
  local stderr_summary= stderr_line stderr_line_hash stderr_line_index=0 stderr_line_class
  [[ -d "$aborted" && ! -L "$aborted" && ! -e "$genuine" && ! -L "$genuine" ]] ||
    fail "$label could not isolate its genuine aborted target"
  mv "$aborted" "$genuine" || fail "$label could not retain its genuine aborted target"
  case "$mutation" in
    wrong-tree)
      if [[ -d "$state_root" && ! -L "$state_root" ]]; then
        corrupt_source=$state_root
      else
        corrupt_source="$test_root/var/lib/agent-os/hub.pre-restore-$transaction"
      fi
      [[ -d "$corrupt_source" && ! -L "$corrupt_source" ]] ||
        fail "$label lacks a preserved-tree corruption source"
      cp -a -- "$corrupt_source" "$aborted"
      wrong_measurement="$(
        "$REAL_NODE_BIN" "$fixed_bin/state-snapshot.mjs" measure "$aborted"
      )" || fail "$label wrong-tree fixture is not semantically measurable"
      wrong_tree="$(
        "$REAL_NODE_BIN" -e \
          'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
          "$wrong_measurement"
      )" || fail "$label wrong-tree fixture emitted invalid measurement metadata"
      [[ "$wrong_tree" == "$phase_baseline_tree" && \
        "$wrong_tree" != "$phase_target_tree" ]] ||
        fail "$label wrong-tree fixture does not represent the preserved tree"
      expected='Hub deployment failed: aborted target tree does not match the recovery journal'
      ;;
    tampered)
      cp -a -- "$genuine" "$aborted"
      chmod 0600 "$aborted/events.jsonl"
      printf '{\n' >>"$aborted/events.jsonl"
      expected='Hub deployment failed: aborted target tree cannot be measured during rollback'
      helper_error='Hub state snapshot failed: event_log_invalid'
      ;;
    symlink)
      ln -s -- "${genuine##*/}" "$aborted"
      helper_error='Hub state observable-reference gate failed: mount alias inspection unavailable'
      expected='Hub deployment failed: could not stop the writer or prove its cgroup and state descriptors clear'
      ;;
    hardlink)
      cp -a -- "$genuine" "$aborted"
      ln -- "$aborted/events.jsonl" "$aborted/events.jsonl.fixture-peer"
      helper_error='Hub state observable-reference gate failed: mount alias inspection unavailable'
      expected='Hub deployment failed: could not stop the writer or prove its cgroup and state descriptors clear'
      ;;
    *) fail "$label requested an unknown aborted-target mutation" ;;
  esac
  before="$temporary/$label-$mutation.before"
  after="$temporary/$label-$mutation.after"
  state_fixture_inventory "$test_root/var/lib/agent-os" >"$before"
  log_before="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  stdout_file="$temporary/$label-$mutation.stdout"
  stderr_file="$temporary/$label-$mutation.stderr"
  : >"$stdout_file"
  : >"$stderr_file"
  chmod 0600 "$stdout_file" "$stderr_file"
  if /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
    --transaction "$transaction" >"$stdout_file" 2>"$stderr_file"; then
    fail "$label accepted a $mutation aborted target"
  fi
  stdout_text="$(<"$stdout_file")"
  stderr_text="$(<"$stderr_file")"
  stdout_hash="$(sha256_file "$stdout_file")"
  stderr_hash="$(sha256_file "$stderr_file")"
  stdout_lines="$(wc -l <"$stdout_file" | tr -d ' ')"
  stderr_lines="$(wc -l <"$stderr_file" | tr -d ' ')"
  [[ "$stdout_text" == 'hub_deploy phase=maintenance status=enabled' ]] ||
    fail "$label emitted an invalid stdout protocol while rejecting $mutation: stdout_sha256=$stdout_hash stdout_lines=$stdout_lines"
  allowed_fail_closed_tail='Hub old-state recovery incomplete: no preserved copy was deleted and persistent recovery blocking remains enabled'
  if [[ -n "${helper_error:-}" ]]; then
    expected_stderr="$helper_error"$'\n'"$expected"$'\n'"$allowed_fail_closed_tail"
  else
    expected_stderr="$expected"$'\n'"$allowed_fail_closed_tail"
  fi
  if [[ "$stderr_text" != "$expected_stderr" ]]; then
    actual_first=${stderr_text%%$'\n'*}
    actual_hash=$stderr_hash
    actual_class=unrecognized
    case "$actual_first" in
      'Hub deployment failed: aborted target tree cannot be measured during rollback')
        actual_class=aborted-measure-failed ;;
      'Hub deployment failed: aborted target tree does not match the recovery journal')
        actual_class=aborted-tree-mismatch ;;
      'Hub deployment failed: aborted target rollback artifact is invalid')
        actual_class=aborted-topology-invalid ;;
      'Hub deployment failed: restore recovery journal changed during recovery preflight')
        actual_class=journal-preflight-changed ;;
      'Hub deployment failed: preserved pre-restore snapshot changed during recovery preflight')
        actual_class=snapshot-preflight-changed ;;
      'Hub state snapshot failed: event_log_invalid')
        actual_class=snapshot-event-log-invalid ;;
      'Hub state snapshot failed: unsafe_state_tree')
        actual_class=snapshot-unsafe-state-tree ;;
      'Hub state observable-reference gate failed: mount alias inspection unavailable')
        actual_class=observable-reference-alias-unavailable ;;
      'Hub state recovery incomplete: service is stopped and persistent recovery blocking remains enabled')
        actual_class=recovery-fail-closed ;;
    esac
    while IFS= read -r stderr_line; do
      stderr_line_index=$((stderr_line_index + 1))
      stderr_line_hash="$(printf '%s' "$stderr_line" | sha256sum | awk '{print $1}')"
      stderr_line_class=redacted
      if [[ "$stderr_line" =~ ^Hub\ (deployment\ failed|state\ snapshot\ failed|old-state\ recovery\ incomplete):\ [A-Za-z0-9._\ -]+$ ]]; then
        stderr_line_class=$stderr_line
      fi
      stderr_summary+="line${stderr_line_index}=${stderr_line_class},sha256=${stderr_line_hash};"
    done <"$stderr_file"
    fail "$label rejected a $mutation aborted target for the wrong reason: class=$actual_class stderr_sha256=$actual_hash stderr_lines=$stderr_lines stderr_classes=$stderr_summary"
  fi
  state_fixture_inventory "$test_root/var/lib/agent-os" >"$after"
  cmp -s "$before" "$after" ||
    fail "$label mutated state while rejecting a $mutation aborted target"
  log_after="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  containment_log="$temporary/$label-$mutation.systemctl"
  sed -n "$((log_before + 1)),${log_after}p" \
    "$AGENT_OS_MOCK_SYSTEMCTL_LOG" >"$containment_log"
  [[ -s "$containment_log" ]] ||
    fail "$label did not contain the service while rejecting a $mutation aborted target"
  runtime_preflight="$(head -n 4 "$containment_log")"
  [[ "$runtime_preflight" == \
    $'daemon-reload \nshow --property=FragmentPath --value agent-os-hub.service\nshow --property=DropInPaths --value agent-os-hub.service\nshow --property=NeedDaemonReload --value agent-os-hub.service' ]] ||
    fail "$label did not execute the exact installed-runtime trust preflight before containment"
  [[ "$(grep -Fxc 'daemon-reload ' "$containment_log")" == 1 && \
    "$(grep -Fxc 'show --property=FragmentPath --value agent-os-hub.service' "$containment_log")" == 1 && \
    "$(grep -Fxc 'show --property=DropInPaths --value agent-os-hub.service' "$containment_log")" == 1 && \
    "$(grep -Fxc 'show --property=NeedDaemonReload --value agent-os-hub.service' "$containment_log")" == 1 ]] ||
    fail "$label repeated or omitted an installed-runtime trust preflight action"
  unexpected_log="$temporary/$label-$mutation.systemctl-unexpected"
  grep -Ev \
    '^(daemon-reload $|is-active --quiet|show --property=(FragmentPath|DropInPaths|NeedDaemonReload|MainPID|ActiveState|ControlGroup) --value|stop |disable |is-enabled --quiet)' \
    "$containment_log" >"$unexpected_log" || true
  if [[ -s "$unexpected_log" ]]; then
    unexpected_first="$(head -n 1 "$unexpected_log" | \
      sed 's/agent-os-hub\.service/<service>/g' | cut -c 1-256)"
    unexpected_hash="$(sha256_file "$unexpected_log")"
    unexpected_lines="$(wc -l <"$unexpected_log" | tr -d ' ')"
    fail "$label used an unauthorized service action while rejecting a $mutation aborted target: first=$unexpected_first sha256=$unexpected_hash lines=$unexpected_lines"
  fi
  grep -Fxq 'stop agent-os-hub.service' "$containment_log" ||
    fail "$label did not stop the service while rejecting a $mutation aborted target"
  grep -Fxq 'disable agent-os-hub.service' "$containment_log" ||
    fail "$label did not disable the service while rejecting a $mutation aborted target"
  if grep -Eq '^(start|enable|reset-failed)( |$)' "$containment_log"; then
    fail "$label restarted the service while rejecting a $mutation aborted target"
  fi
  [[ ! -e "$mock_state/active.agent-os-hub.service" && \
    ! -e "$mock_state/enabled.agent-os-hub.service" && \
    -f "$recovery_block" && ! -L "$recovery_block" && \
    "$(<"$recovery_block")" == \
      "agent-os-hub-recovery-block-v1:$transaction" && \
    -f "$runtime_maintenance" && ! -L "$runtime_maintenance" && \
    -f "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -L "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" && ! -L "$recovery_token" ]] ||
    fail "$label did not remain stopped, disabled and transaction-blocked after rejecting a $mutation aborted target"
  if [[ -L "$aborted" ]]; then
    rm -f -- "$aborted"
  else
    rm -rf -- "$aborted"
  fi
  mv "$genuine" "$aborted" || fail "$label could not restore its genuine aborted target"
}

# A recover-old process can itself disappear after any namespace rename and
# before returning from the parent-directory fsync.  Seed the exact direct
# restore phase that owns each move, then re-enter the same journal.
for recover_old_kill_case in \
  staged:staged-target-isolated \
  old_moved:old-moved-target-isolated \
  old_moved:old-state-reactivated \
  new_activated:active-target-isolated \
  new_activated:activated-old-state-reactivated; do
  recover_old_seed_phase=${recover_old_kill_case%%:*}
  recover_old_kill_boundary=${recover_old_kill_case#*:}
  printf '%s\n' "$recover_old_seed_phase" >"$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE"
  if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
    fail "$recover_old_kill_boundary seed restore ignored its phase SIGKILL probe"
  else
    recover_old_seed_status=$?
  fi
  [[ "$recover_old_seed_status" == 137 && \
    ! -e "$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE" && \
    -f "$recovery_block" && ! -L "$recovery_block" ]] ||
    fail "$recover_old_kill_boundary seed restore did not publish a recoverable journal"
  recover_old_kill_transaction="$(<"$recovery_block")"
  recover_old_kill_transaction=${recover_old_kill_transaction#agent-os-hub-recovery-block-v1:}
  [[ "$recover_old_kill_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    fail "$recover_old_kill_boundary seed transaction is invalid"
  recover_old_target_staging="$test_root/var/lib/agent-os/.hub.restore-$recover_old_kill_transaction"
  recover_old_secondary_staging="$test_root/var/lib/agent-os/.hub.recover-old-$recover_old_kill_transaction"
  recover_old_kill_aborted="$test_root/var/lib/agent-os/hub.aborted-new-$recover_old_kill_transaction"
  recover_old_kill_retired="$test_root/var/lib/agent-os/hub.pre-restore-$recover_old_kill_transaction"
  printf '%s\n' "$recover_old_kill_boundary" \
    >"$AGENT_OS_MOCK_KILL_RECOVER_OLD_BOUNDARY"
  if /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
    --transaction "$recover_old_kill_transaction" >/dev/null 2>&1; then
    fail "recover-old ignored its $recover_old_kill_boundary SIGKILL probe"
  else
    recover_old_kill_status=$?
  fi
  [[ "$recover_old_kill_status" == 137 && \
    ! -e "$AGENT_OS_MOCK_KILL_RECOVER_OLD_BOUNDARY" && \
    "$(<"$AGENT_OS_MOCK_KILL_RECOVER_OLD_REACHED")" == \
      "$recover_old_kill_boundary" ]] ||
    fail "recover-old did not prove its $recover_old_kill_boundary boundary"
  rm -f -- "$AGENT_OS_MOCK_KILL_RECOVER_OLD_REACHED"
  case "$recover_old_kill_boundary" in
    staged-target-isolated)
      [[ -d "$state_root" && ! -e "$recover_old_target_staging" && \
        ! -e "$recover_old_secondary_staging" && \
        -d "$recover_old_kill_aborted" && ! -e "$recover_old_kill_retired" && \
        "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
        "$(semantic_tree_sha256 "$recover_old_kill_aborted")" == "$phase_target_tree" ]] ||
        fail 'staged target isolation boundary confused preserved and target trees'
      ;;
    old-moved-target-isolated | active-target-isolated)
      [[ ! -e "$state_root" && ! -e "$recover_old_target_staging" && \
        ! -e "$recover_old_secondary_staging" && \
        -d "$recover_old_kill_aborted" && -d "$recover_old_kill_retired" && \
        "$(semantic_tree_sha256 "$recover_old_kill_aborted")" == "$phase_target_tree" && \
        "$(semantic_tree_sha256 "$recover_old_kill_retired")" == "$phase_baseline_tree" ]] ||
        fail "$recover_old_kill_boundary confused retired old and aborted target trees"
      ;;
    old-state-reactivated | activated-old-state-reactivated)
      [[ -d "$state_root" && ! -e "$recover_old_target_staging" && \
        ! -e "$recover_old_secondary_staging" && \
        -d "$recover_old_kill_aborted" && ! -e "$recover_old_kill_retired" && \
        "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
        "$(semantic_tree_sha256 "$recover_old_kill_aborted")" == "$phase_target_tree" ]] ||
        fail "$recover_old_kill_boundary did not reactivate only the preserved old tree"
      ;;
  esac
  for recover_old_aborted_mutation in wrong-tree tampered symlink hardlink; do
    assert_recover_old_aborted_artifact_rejected \
      "$recover_old_kill_boundary" "$recover_old_aborted_mutation" \
      "$recover_old_kill_transaction" "$recover_old_kill_aborted"
  done
  recover_old_wrong_before="$temporary/recover-old-$recover_old_kill_boundary.before"
  recover_old_wrong_after="$temporary/recover-old-$recover_old_kill_boundary.after"
  state_fixture_inventory "$test_root/var/lib/agent-os" \
    >"$recover_old_wrong_before"
  recover_old_wrong_log_before="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  expect_failure \
    "recover-old $recover_old_kill_boundary accepted a wrong transaction" \
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "restore-wrong-$recover_old_kill_boundary"
  state_fixture_inventory "$test_root/var/lib/agent-os" \
    >"$recover_old_wrong_after"
  cmp -s "$recover_old_wrong_before" "$recover_old_wrong_after" ||
    fail "wrong transaction changed the $recover_old_kill_boundary topology"
  [[ "$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')" == \
    "$recover_old_wrong_log_before" ]] ||
    fail "wrong transaction reached systemd at $recover_old_kill_boundary"

  recover_old_kill_output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$recover_old_kill_transaction"
  )" || fail "recover-old could not adopt $recover_old_kill_boundary"
  recover_old_kill_result=${recover_old_kill_output##*$'\n'}
  [[ "$recover_old_kill_result" == \
    hub_state_recover_old\ status=ok\ transaction="$recover_old_kill_transaction"\ snapshot=*\ manifest_sha256=* && \
    "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
    -f "$test_root/var/lib/agent-os-ops/private/$recover_old_kill_transaction/rolled_back" && \
    ! -e "$recover_old_target_staging" && \
    ! -e "$recover_old_secondary_staging" && \
    -d "$recover_old_kill_aborted" && \
    "$(semantic_tree_sha256 "$recover_old_kill_aborted")" == "$phase_target_tree" && \
    ! -e "$recovery_block" && ! -e "$recovery_token" && \
    ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "recover-old did not converge its $recover_old_kill_boundary phase lag"
done

restore_phase_baseline() {
  local output result
  output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" restore \
      --snapshot "$state_backup_id" \
      --manifest-sha256 "$state_backup_digest"
  )" || fail 'committed-boundary cleanup could not restore the baseline snapshot'
  result=${output##*$'\n'}
  [[ "$result" == hub_state_restore\ status=ok\ snapshot="$state_backup_id"\ manifest_sha256="$state_backup_digest"\ retained_previous=* ]] ||
    fail 'committed-boundary baseline restore emitted an invalid result contract'
  restore_phase_baseline_transaction=${result##*retained_previous=hub.pre-restore-}
  [[ "$restore_phase_baseline_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
    -f "$test_root/var/lib/agent-os-ops/private/$restore_phase_baseline_transaction/committed" ]] ||
    fail 'committed-boundary baseline restore did not expose its terminal journal'
  [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" ]] ||
    fail 'committed-boundary cleanup did not restore the baseline semantic tree'
  [[ ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" ]] ||
    fail 'committed-boundary baseline restore left a recovery gate enabled'
}

finalize_committed_restore() {
  local label=$1 transaction=$2 before_log before_tree output result aborted_count
  before_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  before_tree="$(semantic_tree_sha256 "$state_root")" ||
    fail "$label left a non-replayable committed target before finalization"
  expect_failure \
    "$label accepted an unrelated recovery transaction" \
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "restore-wrong-${label//[^A-Za-z0-9._-]/-}"
  [[ "$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')" == "$before_log" ]] ||
    fail "$label wrong-transaction rejection reached systemd"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$before_tree" ]] ||
    fail "$label wrong-transaction rejection changed the committed target"
  output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$transaction"
  )" || fail "$label could not finalize its committed restore journal"
  result=${output##*$'\n'}
  [[ "$result" == \
    hub_state_recover_old\ status=finalized\ transaction="$transaction" ]] ||
    fail "$label finalizer emitted an invalid result contract"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" ]] ||
    fail "$label finalizer rolled back or changed the committed target"
  [[ -f "$test_root/var/lib/agent-os-ops/private/$transaction/committed" && \
    ! -e "$test_root/var/lib/agent-os-ops/private/$transaction/rolled_back" ]] ||
    fail "$label finalizer changed the terminal committed journal"
  [[ ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" ]] ||
    fail "$label finalizer did not clear every recovery gate"
  [[ -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label finalizer did not prove health and restore boot enablement"
  if [[ -d "$test_root/var/lib/agent-os/hub.aborted-new-$transaction" ]]; then
    aborted_count=1
  else
    aborted_count=0
  fi
  [[ "$aborted_count" == 0 && \
    ! -e "$test_root/var/lib/agent-os/hub.failed-restore-$transaction" ]] ||
    fail "$label compensated or retained an aborted copy of the committed target"
  restore_phase_baseline
}

result_fault_runner="$temporary/state-result-fault"
cat >"$result_fault_runner" <<'RESULT_FAULT'
#!/bin/bash -p
set -ETeuo pipefail
fault_mode=$1
result_pattern=$2
admin_entry=$3
shift 3
case "$fault_mode" in
  epipe)
    trap '' PIPE
    exec 3> >(:)
    sleep 0.05
    trap 'if [[ "$BASH_COMMAND" == *"$result_pattern"* ]]; then
      printf "%s\n" "$fault_mode" >"$AGENT_OS_RESULT_FAULT_REACHED"
      exec 1>&3
    fi' DEBUG
    ;;
  term)
    trap 'if [[ "$BASH_COMMAND" == *"$result_pattern"* ]]; then
      printf "%s\n" "$fault_mode" >"$AGENT_OS_RESULT_FAULT_REACHED"
      kill -TERM "$$"
    fi' DEBUG
    ;;
  *) exit 2 ;;
esac
source "$admin_entry" "$@"
RESULT_FAULT
chmod 0755 "$result_fault_runner"
export AGENT_OS_RESULT_FAULT_REACHED="$temporary/state-result-fault-reached"

# record_recovery_phase publishes by rename and only then fsyncs the transaction
# directory.  If that final fsync returns an error or the orchestrator receives
# TERM, EXIT must recognize only an exact visible committed marker, retain the
# target and fail closed under the original restore transaction.
assert_committed_phase_fsync_fault() {
  local boundary=$1 transaction journal marker expected_body marker_mode marker_uid
  local marker_gid marker_links restore_status
  rm -f -- "$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
  printf '%s\n' "$boundary" >"$AGENT_OS_MOCK_COMMITTED_PHASE_FSYNC"
  if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
    fail "committed rename-to-fsync $boundary fault was accepted"
  else
    restore_status=$?
  fi
  [[ "$restore_status" != 0 && \
    ! -e "$AGENT_OS_MOCK_COMMITTED_PHASE_FSYNC" && \
    -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]] ||
    fail "committed rename-to-fsync $boundary fault did not reach its boundary"
  transaction="$(<"$AGENT_OS_MOCK_COMMITTED_TRANSACTION")"
  journal="$test_root/var/lib/agent-os-ops/private/$transaction"
  marker="$journal/committed"
  expected_body=$'version=1\ntransaction='"$transaction"$'\nphase=committed'
  marker_mode="$(stat -c '%a' "$marker" 2>/dev/null || stat -f '%Lp' "$marker")"
  marker_uid="$(stat -c '%u' "$marker" 2>/dev/null || stat -f '%u' "$marker")"
  marker_gid="$(stat -c '%g' "$marker" 2>/dev/null || stat -f '%g' "$marker")"
  marker_links="$(stat -c '%h' "$marker" 2>/dev/null || stat -f '%l' "$marker")"
  [[ "$transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
    -f "$marker" && ! -L "$marker" && \
    "$marker_mode" == 400 && "$marker_uid" == "$EUID" && \
    "$marker_gid" == "$(id -g)" && "$marker_links" == 1 && \
    "$(<"$marker")" == "$expected_body" && \
    ! -e "$journal/rolled_back" ]] ||
    fail "committed rename-to-fsync $boundary fault lost the exact visible marker"
  [[ -f "$recovery_block" && \
    "$(<"$recovery_block")" == \
      "agent-os-hub-recovery-block-v1:$transaction" && \
    -f "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -f "$mock_state/active.agent-os-hub.service" && \
    ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "committed rename-to-fsync $boundary fault did not fail closed under its transaction"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
    ! -e "$test_root/var/lib/agent-os/hub.failed-restore-$transaction" ]] ||
    fail "committed rename-to-fsync $boundary fault compensated its authoritative target"
  finalize_committed_restore "committed-phase-fsync-$boundary" "$transaction"
}

assert_committed_phase_fsync_fault fail
assert_committed_phase_fsync_fault term

# Visibility is deliberately stricter than existence.  Mode, link count and
# body corruption at the same rename-to-fsync boundary must take the rollback
# path.  UID is not forgeable by this non-root gate, so keep an explicit static
# assertion on the production predicate in addition to the exact positive UID
# check above.
grep -Fq '"$(stat_value '\''%u'\'' '\''%u'\'' "$phase_path")" == "$expected_uid"' \
  "$fixed_bin/state-admin.sh" ||
  fail 'committed visibility no longer checks the phase marker owner'

assert_invalid_committed_marker() {
  local kind=$1 transaction journal marker recovery_output recovery_result
  rm -f -- "$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
  printf '%s\n' "$kind" >"$AGENT_OS_MOCK_INVALID_COMMITTED_MARKER"
  expect_failure \
    "restore treated a committed marker with invalid $kind as durable" \
    /bin/bash -p "$fixed_bin/state-admin.sh" restore \
      --snapshot "$phase_target_snapshot" \
      --manifest-sha256 "$phase_target_digest"
  [[ ! -e "$AGENT_OS_MOCK_INVALID_COMMITTED_MARKER" && \
    -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]] ||
    fail "invalid committed $kind marker did not reach the phase fsync boundary"
  transaction="$(<"$AGENT_OS_MOCK_COMMITTED_TRANSACTION")"
  journal="$test_root/var/lib/agent-os-ops/private/$transaction"
  marker="$journal/committed"
  [[ -f "$recovery_block" && \
    "$(<"$recovery_block")" == \
      "agent-os-hub-recovery-block-v1:$transaction" && \
    -f "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -f "$mock_state/active.agent-os-hub.service" && \
    ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "invalid committed $kind marker did not retain exact fail-closed recovery"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
    -d "$test_root/var/lib/agent-os/hub.failed-restore-$transaction" && \
    ! -e "$journal/rolled_back" ]] ||
    fail "invalid committed $kind marker was treated as authoritative"
  case "$kind" in
    mode)
      [[ "$(stat -c '%a' "$marker" 2>/dev/null || stat -f '%Lp' "$marker")" == 600 ]] ||
        fail 'invalid committed mode probe did not alter the marker'
      ;;
    hardlink)
      [[ "$(stat -c '%h' "$marker" 2>/dev/null || stat -f '%l' "$marker")" == 2 && \
        -f "$journal/committed-invalid-peer" ]] ||
        fail 'invalid committed hardlink probe did not alter link count'
      ;;
    body)
      [[ "$(<"$marker")" == invalid-committed-body ]] ||
        fail 'invalid committed body probe did not alter marker content'
      ;;
  esac
  rm -f -- "$marker" "$journal/committed-invalid-peer"
  recovery_output="$(
    /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
      --transaction "$transaction"
  )" || fail "invalid committed $kind probe could not recover its preserved tree"
  recovery_result=${recovery_output##*$'\n'}
  [[ "$recovery_result" == \
    hub_state_recover_old\ status=ok\ transaction="$transaction"\ snapshot=*\ manifest_sha256=* && \
    -f "$journal/rolled_back" && ! -e "$journal/committed" && \
    "$(semantic_tree_sha256 "$state_root")" == "$phase_baseline_tree" && \
    ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "invalid committed $kind probe did not converge through rollback"
}

for invalid_committed_kind in mode hardlink body; do
  assert_invalid_committed_marker "$invalid_committed_kind"
done

# A crash immediately after the committed phase must retain the target tree.
# Recovery is a terminal finalize operation, never a compensation rollback.
printf '%s\n' committed >"$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE"
if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
  --snapshot "$phase_target_snapshot" \
  --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
  fail 'restore committed phase ignored the SIGKILL probe'
else
  committed_kill_status=$?
fi
[[ "$committed_kill_status" == 137 && \
  ! -e "$AGENT_OS_MOCK_KILL_AFTER_RESTORE_PHASE" ]] ||
  fail 'restore committed phase did not terminate at its durable boundary'
[[ -f "$recovery_block" && -f "$runtime_maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
  ! -e "$recovery_token" ]] ||
  fail 'committed phase crash lost its block or runtime ingress guard'
committed_kill_transaction="$(<"$recovery_block")"
committed_kill_transaction=${committed_kill_transaction#agent-os-hub-recovery-block-v1:}
[[ "$committed_kill_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
  -f "$test_root/var/lib/agent-os-ops/private/$committed_kill_transaction/committed" && \
  ! -e "$test_root/var/lib/agent-os-ops/private/$committed_kill_transaction/rolled_back" ]] ||
  fail 'committed phase crash lost its terminal restore journal'
[[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
  -d "$test_root/var/lib/agent-os/hub.pre-restore-$committed_kill_transaction" ]] ||
  fail 'committed phase crash did not retain target plus previous copy'
[[ -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'committed phase crash did not occur after health and boot enablement'
finalize_committed_restore committed-phase-kill "$committed_kill_transaction"

# Failing the runtime-directory fsync occurs after hard/normal sentinel unlink
# but before the durable block is touched. EXIT must leave that exact block as
# the resumable authority and must never compensate the committed target.
rm -f -- "$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
printf '%s\n' runtime >"$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC"
expect_failure \
  'committed restore accepted runtime-guard cleanup fsync failure' \
  /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest"
[[ ! -e "$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC" && \
  -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]] ||
  fail 'committed runtime cleanup fault did not reach the audited fsync boundary'
committed_runtime_fsync_transaction="$(<"$AGENT_OS_MOCK_COMMITTED_TRANSACTION")"
[[ -f "$recovery_block" && "$(<"$recovery_block")" == \
  "agent-os-hub-recovery-block-v1:$committed_runtime_fsync_transaction" && \
  -f "$test_root/var/lib/agent-os-ops/private/$committed_runtime_fsync_transaction/committed" ]] ||
  fail 'runtime cleanup fsync failure lost its exact committed restore block'
[[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
  ! -e "$test_root/var/lib/agent-os/hub.failed-restore-$committed_runtime_fsync_transaction" ]] ||
  fail 'runtime cleanup fsync failure compensated the authoritative target'
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  ! -f "$mock_state/enabled.agent-os-hub.service" && \
  ! -e "$runtime_maintenance" && \
  -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'runtime cleanup fsync failure did not stop, disable and fail closed behind its block'
finalize_committed_restore committed-runtime-fsync "$committed_runtime_fsync_transaction"

# A crash after the runtime-directory fsync must have removed both volatile
# sentinels while retaining the persistent block, so the same transaction can
# be finalized after restart.
rm -f -- "$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
printf '%s\n' runtime >"$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC"
if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
  --snapshot "$phase_target_snapshot" \
  --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
  fail 'committed cleanup ignored the post-runtime-fsync SIGKILL probe'
else
  committed_runtime_kill_status=$?
fi
[[ "$committed_runtime_kill_status" == 137 && \
  ! -e "$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC" && \
  -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]] ||
  fail 'committed cleanup did not terminate immediately after runtime fsync'
committed_runtime_kill_transaction="$(<"$AGENT_OS_MOCK_COMMITTED_TRANSACTION")"
[[ -f "$recovery_block" && "$(<"$recovery_block")" == \
  "agent-os-hub-recovery-block-v1:$committed_runtime_kill_transaction" && \
  ! -e "$runtime_maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'post-runtime-fsync crash did not retain only its resumable block'
[[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
  -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'post-runtime-fsync crash changed committed data or service state'
finalize_committed_restore committed-runtime-fsync-kill "$committed_runtime_kill_transaction"

# If the final persistent-block fsync fails, EXIT must republish a block bound
# to the committed restore transaction. The following recovery is killed after
# deleting the hard/normal guards and fsyncing runtime state, proving the hard
# guard cleanup boundary remains resumable before a final successful pass.
rm -f -- "$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
printf '%s\n' ops >"$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC"
expect_failure \
  'committed restore accepted persistent-block cleanup fsync failure' \
  /bin/bash -p "$fixed_bin/state-admin.sh" restore \
    --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest"
[[ ! -e "$AGENT_OS_MOCK_FAIL_COMMITTED_CLEANUP_FSYNC" && \
  -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]] ||
  fail 'committed block cleanup fault did not reach the audited fsync boundary'
committed_ops_fsync_transaction="$(<"$AGENT_OS_MOCK_COMMITTED_TRANSACTION")"
[[ -f "$recovery_block" && "$(<"$recovery_block")" == \
  "agent-os-hub-recovery-block-v1:$committed_ops_fsync_transaction" && \
  -f "$test_root/var/lib/agent-os-ops/private/$committed_ops_fsync_transaction/committed" && \
  ! -e "$test_root/var/lib/agent-os-ops/private/$committed_ops_fsync_transaction/rolled_back" ]] ||
  fail 'persistent-block fsync failure did not republish the exact committed restore block'
[[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
  ! -e "$test_root/var/lib/agent-os/hub.failed-restore-$committed_ops_fsync_transaction" ]] ||
  fail 'persistent-block fsync failure compensated the authoritative target'
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  ! -f "$mock_state/enabled.agent-os-hub.service" && \
  ! -e "$runtime_maintenance" && \
  -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'persistent-block fsync failure did not stop, disable and fail closed'
printf '%s\n' runtime >"$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC"
if /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
  --transaction "$committed_ops_fsync_transaction" >/dev/null 2>&1; then
  fail 'terminal recovery ignored the runtime-cleanup SIGKILL probe'
else
  committed_finalize_kill_status=$?
fi
[[ "$committed_finalize_kill_status" == 137 ]] ||
  fail 'terminal recovery runtime-cleanup probe did not exit from SIGKILL'
[[ ! -e "$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC" ]] ||
  fail 'terminal recovery runtime-cleanup probe did not reach its fsync boundary'
[[ -f "$recovery_block" && \
  "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$committed_ops_fsync_transaction" ]] ||
  fail 'terminal recovery runtime-cleanup crash lost its exact transaction block'
[[ ! -e "$runtime_maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'terminal recovery runtime-cleanup crash retained a volatile sentinel'
finalize_committed_restore committed-ops-fsync "$committed_ops_fsync_transaction"

# A crash after the final OPS fsync is already a completely clean terminal
# state: no recovery block or runtime guard remains, and the committed tree is
# live and enabled. It must not be "recovered" back to the previous copy.
rm -f -- "$AGENT_OS_MOCK_COMMITTED_TRANSACTION"
printf '%s\n' ops >"$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC"
if /bin/bash -p "$fixed_bin/state-admin.sh" restore \
  --snapshot "$phase_target_snapshot" \
  --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
  fail 'committed cleanup ignored the post-OPS-fsync SIGKILL probe'
else
  committed_ops_kill_status=$?
fi
[[ "$committed_ops_kill_status" == 137 && \
  ! -e "$AGENT_OS_MOCK_KILL_AFTER_COMMITTED_CLEANUP_FSYNC" && \
  -s "$AGENT_OS_MOCK_COMMITTED_TRANSACTION" ]] ||
  fail 'committed cleanup did not terminate immediately after OPS fsync'
committed_ops_kill_transaction="$(<"$AGENT_OS_MOCK_COMMITTED_TRANSACTION")"
[[ "$committed_ops_kill_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
  -f "$test_root/var/lib/agent-os-ops/private/$committed_ops_kill_transaction/committed" && \
  ! -e "$test_root/var/lib/agent-os-ops/private/$committed_ops_kill_transaction/rolled_back" ]] ||
  fail 'post-OPS-fsync cleanup crash lost its committed journal'
[[ ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
  ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
  ! -e "$recovery_token" ]] ||
  fail 'post-OPS-fsync cleanup crash was not fully clean'
[[ "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
  -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'post-OPS-fsync cleanup crash changed data or service state after commit'
AGENT_OS_NODE_BIN="$node_mock" AGENT_OS_SYSTEMCTL_BIN="$systemctl_mock" \
  AGENT_OS_SS_BIN="$ss_mock" AGENT_OS_CURL_BIN="$curl_mock" \
  /bin/bash -p "$fixed_bin/health-check.sh" \
  --config "$test_root/etc/agent-os/hub.env" \
  --unit agent-os-hub.service --live >/dev/null ||
  fail 'fully clean post-OPS-fsync committed state did not pass exact health'
if [[ -d "$test_root/var/lib/agent-os/hub.aborted-new-$committed_ops_kill_transaction" ]]; then
  ops_kill_aborted_count=1
else
  ops_kill_aborted_count=0
fi
[[ "$ops_kill_aborted_count" == 0 && \
  ! -e "$test_root/var/lib/agent-os/hub.failed-restore-$committed_ops_kill_transaction" ]] ||
  fail 'fully clean post-OPS-fsync state compensated its committed target'
restore_phase_baseline

# Once terminal cleanup is durable, a caller disappearing while the final
# machine-readable result is emitted must not invent a new recovery block.
# Exercise both EPIPE and TERM against pre-existing aborted, rolled_back and
# committed journals, and prove every original journal remains byte-identical.
terminal_aborted_transaction=restore-result-aborted-probe
terminal_aborted_parent=recovery-pre-result-aborted-probe
# An orphan intent is the durable residue of a restore that stopped before it
# could publish metadata.  Model that topology faithfully: the service is
# already inactive and disabled when recover-old adopts the signed intent.
terminal_aborted_log_before="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
"$systemctl_mock" stop agent-os-hub.service
"$systemctl_mock" disable agent-os-hub.service
[[ ! -e "$mock_state/active.agent-os-hub.service" && \
  ! -e "$mock_state/enabled.agent-os-hub.service" && \
  ! -e "$recovery_block" && ! -e "$recovery_token" ]] ||
  fail 'orphan-intent result fixture did not begin inactive, disabled and unblocked'
/bin/bash -p -c \
  'source "$1"; record_restore_intent "$2" "$3" "$4" "$5" "$6"' \
  _ "$fixed_bin/lib.sh" \
  "$terminal_aborted_transaction" "$state_backup_id" \
  "$state_backup_digest" "$phase_baseline_tree" "$terminal_aborted_parent" ||
  fail 'could not create the signed orphan-intent result fixture'
printf 'agent-os-hub-recovery-block-v1:%s\n' "$terminal_aborted_parent" \
  >"$recovery_block"
chmod 0444 "$recovery_block"
[[ "$(<"$recovery_block")" == \
    "agent-os-hub-recovery-block-v1:$terminal_aborted_parent" && \
  ! -e "$recovery_token" ]] ||
  fail 'orphan-intent result fixture did not publish its exact parent block'
terminal_aborted_output="$(
  /bin/bash -p "$fixed_bin/state-admin.sh" recover-old \
    --transaction "$terminal_aborted_transaction"
)" || fail 'could not establish the terminal aborted result fixture'
terminal_aborted_result=${terminal_aborted_output##*$'\n'}
[[ "$terminal_aborted_result" == \
  hub_state_recover_old\ status=aborted\ transaction="$terminal_aborted_transaction" && \
  -f "$ops_root/private/$terminal_aborted_transaction/aborted" && \
  ! -e "$recovery_block" && ! -e "$recovery_token" && \
  -f "$mock_state/active.agent-os-hub.service" && \
  -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'orphan-intent recovery did not publish an aborted terminal journal'
terminal_aborted_log_delta="$(
  tail -n "+$((terminal_aborted_log_before + 1))" \
    "$AGENT_OS_MOCK_SYSTEMCTL_LOG"
)"
[[ "$terminal_aborted_log_delta" == *'stop agent-os-hub.service'* && \
  "$terminal_aborted_log_delta" == *'disable agent-os-hub.service'* && \
  "$terminal_aborted_log_delta" == *'reset-failed agent-os-hub.service'* && \
  "$terminal_aborted_log_delta" == *'start agent-os-hub.service'* && \
  "$terminal_aborted_log_delta" == *'enable agent-os-hub.service'* ]] ||
  fail 'orphan-intent recovery did not traverse the audited stop, tokenized start and enable path'

assert_terminal_recover_result_fault() {
  local label=$1 transaction=$2 binding=$3 mode=$4 journal before_journal
  local before_tree fault_status
  journal="$ops_root/private/$transaction"
  before_journal="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$journal")" ||
    fail "$label $mode could not hash its terminal journal"
  before_tree="$(semantic_tree_sha256 "$state_root")" ||
    fail "$label $mode began with an invalid current tree"
  printf 'agent-os-hub-recovery-block-v1:%s\n' "$binding" >"$recovery_block"
  chmod 0444 "$recovery_block"
  rm -f -- "$AGENT_OS_RESULT_FAULT_REACHED"
  if /bin/bash -p "$result_fault_runner" "$mode" \
    'hub_state_recover_old status=' "$fixed_bin/state-admin.sh" \
    recover-old --transaction "$transaction" >/dev/null 2>&1; then
    fail "$label $mode result fault returned success"
  else
    fault_status=$?
  fi
  [[ "$fault_status" != 0 && \
    "$(<"$AGENT_OS_RESULT_FAULT_REACHED")" == "$mode" ]] ||
    fail "$label $mode did not fault at the final result boundary"
  [[ "$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$journal")" == \
    "$before_journal" ]] ||
    fail "$label $mode changed its original terminal journal"
  [[ "$(semantic_tree_sha256 "$state_root")" == "$before_tree" && \
    ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" && \
    -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label $mode result fault generated a block or changed terminal state"
}

terminal_rolled_back_transaction=$metadata_only_transaction
terminal_committed_transaction=$restore_phase_baseline_transaction
for terminal_result_mode in epipe term; do
  assert_terminal_recover_result_fault \
    aborted "$terminal_aborted_transaction" "$terminal_aborted_parent" \
    "$terminal_result_mode"
  assert_terminal_recover_result_fault \
    rolled-back "$terminal_rolled_back_transaction" \
    "$terminal_rolled_back_transaction" "$terminal_result_mode"
  assert_terminal_recover_result_fault \
    committed "$terminal_committed_transaction" \
    "$terminal_committed_transaction" "$terminal_result_mode"
done

assert_direct_restore_result_fault() {
  local mode=$1 before_list after_list new_list transaction journal fault_status
  before_list="$temporary/direct-restore-$mode.before"
  after_list="$temporary/direct-restore-$mode.after"
  new_list="$temporary/direct-restore-$mode.new"
  find "$ops_root/private" -mindepth 1 -maxdepth 1 -type d -name 'restore-*' \
    -exec basename {} \; | sort >"$before_list"
  rm -f -- "$AGENT_OS_RESULT_FAULT_REACHED"
  if /bin/bash -p "$result_fault_runner" "$mode" \
    'hub_state_restore status=' "$fixed_bin/state-admin.sh" \
    restore --snapshot "$phase_target_snapshot" \
    --manifest-sha256 "$phase_target_digest" >/dev/null 2>&1; then
    fail "direct restore $mode result fault returned success"
  else
    fault_status=$?
  fi
  [[ "$fault_status" != 0 && \
    "$(<"$AGENT_OS_RESULT_FAULT_REACHED")" == "$mode" ]] ||
    fail "direct restore $mode did not fault at the final result boundary"
  find "$ops_root/private" -mindepth 1 -maxdepth 1 -type d -name 'restore-*' \
    -exec basename {} \; | sort >"$after_list"
  comm -13 "$before_list" "$after_list" >"$new_list"
  [[ "$(wc -l <"$new_list" | tr -d ' ')" == 1 ]] ||
    fail "direct restore $mode did not publish exactly one transaction journal"
  transaction="$(<"$new_list")"
  journal="$ops_root/private/$transaction"
  [[ "$transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ && \
    -f "$journal/committed" && ! -e "$journal/rolled_back" && \
    "$(semantic_tree_sha256 "$state_root")" == "$phase_target_tree" && \
    ! -e "$test_root/var/lib/agent-os/hub.failed-restore-$transaction" && \
    ! -e "$recovery_block" && ! -e "$runtime_maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$recovery_token" && \
    -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "direct restore $mode result fault rolled back or generated a random block"
  restore_phase_baseline
}

assert_direct_restore_result_fault epipe
assert_direct_restore_result_fault term

run_forensic_recovery_case
fi

assert_no_owned_test_processes() {
  local label=$1 evidence="$temporary/owned-processes.json" attempt status=0
  for ((attempt = 0; attempt < 64; attempt++)); do
    if "$REAL_NODE_BIN" -e '
      const fs = require("node:fs");
      const root = process.argv[1];
      const own = new Set(process.argv.slice(2).map(Number));
      own.add(process.pid);
      const prefix = Buffer.from(`AGENT_OS_DEPLOY_TEST_ROOT=${root}\0`);
      const found = [];
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^[0-9]+$/u.test(entry)) continue;
        const pid = Number(entry);
        if (own.has(pid)) continue;
        try {
          const environment = fs.readFileSync(`/proc/${entry}/environ`);
          if (!environment.includes(prefix)) continue;
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8").trim();
          const close = stat.lastIndexOf(")");
          if (close < 0) throw new Error("invalid proc stat");
          const fields = stat.slice(close + 2).split(/\s+/u);
          found.push({ pid, ppid: Number(fields[1]), starttime: fields[19] });
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ESRCH" && error?.code !== "EACCES") throw error;
        }
      }
      found.sort((left, right) => left.pid - right.pid);
      fs.writeFileSync(process.argv[2], `${JSON.stringify(found)}\n`, { mode: 0o600 });
      process.exit(found.length === 0 ? 0 : 1);
    ' "$test_root" "$evidence" "$$"; then
      status=0
      break
    else
      status=$?
    fi
  done
  [[ "$status" == 0 ]] ||
    fail "$label retained an owned test-root process: $(cut -c 1-512 "$evidence")"
}

assert_recovery_token_absent() {
  local label=$1 trace_tail
  record_restore_token_harness_checkpoint "$label"
  if [[ -e "$recovery_token" || -L "$recovery_token" ]]; then
    trace_tail="$(tail -n 12 "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE" | \
      tr '\r\n' ';;' | cut -c 1-2048)"
    fail "$label observed an unexpected recovery token: trace=$trace_tail"
  fi
}

assert_no_owned_test_processes restore-fault-matrix
assert_recovery_token_absent restore-fault-matrix-clean

real_snapshot_hook="$temporary/pre-upgrade-snapshot-real"
install -m 0555 "$fixed_root/pre-upgrade-snapshot" "$real_snapshot_hook"
snapshot_hook_source="$temporary/pre-upgrade-snapshot-source"
cat >"$snapshot_hook_source" <<'HOOK'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$0" in
  */.snapshot-hook-[0-9]*) [[ -r "$0" && ! -x "$0" ]] ;;
esac
[[ -f "$AGENT_OS_MOCK_MAINTENANCE" ]]
[[ ! -f "$AGENT_OS_MOCK_STATE/active.agent-os-hub.service" ]]
[[ -d "$1" && ! -e "$2" ]]
"$AGENT_OS_MOCK_REAL_SNAPSHOT_HOOK" "$1" "$2" >/dev/null
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
export AGENT_OS_MOCK_REAL_SNAPSHOT_HOOK="$real_snapshot_hook"

upgrade() {
  local revision=$1
  bash "$fixed_bin/upgrade.sh" --archive "$archive" --envelope "$envelope" \
    --revision "$revision"
}

upgrade_with_snapshot_hook() {
  local revision=$1 hook=$2
  bash "$fixed_bin/upgrade.sh" --archive "$archive" --envelope "$envelope" \
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

assert_candidate_contract_rejected_before_start() {
  local label=$1 revision=$2
  [[ ! -e "$AGENT_OS_MOCK_CANDIDATE_START_MARKER" ]] ||
    fail "$label reached the candidate process before rejection"
  [[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 ]] ||
    fail "$label changed the active release"
  [[ -f "$mock_state/active.agent-os-hub.service" ]] ||
    fail "$label stopped the signed-off live service"
  [[ ! -e "$test_root/run/agent-os/hub-maintenance" && \
    ! -e "$test_root/run/agent-os/hub-maintenance-hard" && \
    ! -e "$test_root/var/lib/agent-os-ops/hub-block" ]] ||
    fail "$label entered maintenance during candidate contract preflight"
  [[ ! -e "$test_root/run/agent-os/hub-candidates/$revision.env" ]] ||
    fail "$label published candidate credentials before contract rejection"
}

candidate_unit_installed="$test_root/etc/systemd/system/agent-os-hub-candidate@.service"
candidate_unit_saved="$temporary/candidate-unit-saved"
cp "$candidate_unit_installed" "$candidate_unit_saved"
chmod u+w "$candidate_unit_installed"
printf '%s\n' '# stale audited-template probe' >>"$candidate_unit_installed"
rm -f -- "$AGENT_OS_MOCK_CANDIDATE_START_MARKER"
expect_failure \
  'upgrade accepted a stale installed candidate template' \
  upgrade candidate-stale-template
install -m 0644 "$candidate_unit_saved" "$candidate_unit_installed"
assert_candidate_contract_rejected_before_start \
  'stale installed candidate template' candidate-stale-template

for candidate_contract_case in template-dropin instance-dropin redirected-fragment; do
  rm -f -- "$AGENT_OS_MOCK_CANDIDATE_START_MARKER"
  case "$candidate_contract_case" in
    template-dropin) : >"$AGENT_OS_MOCK_CANDIDATE_TEMPLATE_DROPIN" ;;
    instance-dropin) : >"$AGENT_OS_MOCK_CANDIDATE_INSTANCE_DROPIN" ;;
    redirected-fragment) : >"$AGENT_OS_MOCK_BAD_CANDIDATE_FRAGMENT" ;;
  esac
  expect_failure \
    "upgrade accepted candidate effective contract: $candidate_contract_case" \
    upgrade "candidate-$candidate_contract_case"
  rm -f -- \
    "$AGENT_OS_MOCK_CANDIDATE_TEMPLATE_DROPIN" \
    "$AGENT_OS_MOCK_CANDIDATE_INSTANCE_DROPIN" \
    "$AGENT_OS_MOCK_BAD_CANDIDATE_FRAGMENT"
  assert_candidate_contract_rejected_before_start \
    "candidate effective contract $candidate_contract_case" \
    "candidate-$candidate_contract_case"
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
  [[ ! -e "$test_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$test_root/run/agent-os/hub-recovery-start" ]] ||
    fail "failed $failed_revision left a persistent block or recovery token"
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
  [[ ! -e "$test_root/var/lib/agent-os-ops/hub-block" && \
    ! -e "$test_root/run/agent-os/hub-recovery-start" ]] ||
    fail "$label left a persistent block or recovery token"
}

converge_upgrade_recovery_token_before_signed_restore() {
  local label=$1 block token transaction wrong_transaction token_sha256_before
  block="$test_root/var/lib/agent-os-ops/hub-block"
  token="$test_root/run/agent-os/hub-recovery-start"
  [[ -f "$block" && ! -L "$block" ]] ||
    fail "$label lacks its persistent recovery block"
  transaction="$(<"$block")"
  transaction=${transaction#agent-os-hub-recovery-block-v1:}
  [[ "$transaction" =~ ^upgrade-[A-Za-z0-9._-]{1,128}$ ]] ||
    fail "$label has an invalid upgrade transaction binding"
  [[ -f "$token" && ! -L "$token" && "$(<"$token")" == "$transaction" && \
    "$(stat -c '%a' "$token" 2>/dev/null || stat -f '%Lp' "$token")" == 400 && \
    "$(stat -c '%h' "$token" 2>/dev/null || stat -f '%l' "$token")" == 1 ]] ||
    fail "$label lacks its exact private transaction token"
  token_sha256_before="$(sha256_file "$token")"
  wrong_transaction=upgrade-wrong-token-probe
  if /bin/bash -p -c \
    'source "$1"; start_authorized_recovery_service "$2"' \
    _ "$fixed_bin/lib.sh" "$wrong_transaction" >/dev/null 2>&1; then
    fail "$label accepted a token for the wrong transaction"
  fi
  [[ -f "$token" && ! -L "$token" && "$(<"$token")" == "$transaction" && \
    "$(sha256_file "$token")" == "$token_sha256_before" && \
    "$(<"$block")" == "agent-os-hub-recovery-block-v1:$transaction" && \
    ! -e "$mock_state/active.agent-os-hub.service" && \
    ! -e "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label wrong-transaction rejection changed recovery state"
  /bin/bash -p -c '
    source "$1"
    start_authorized_recovery_service "$2"
    health_gate live
    stop_and_prove_writer_stopped
    service_control disable "$SERVICE_NAME"
    service_is_disabled
  ' _ "$fixed_bin/lib.sh" "$transaction" >/dev/null ||
    fail "$label could not consume its token and return to a stopped state"
  [[ ! -e "$token" && ! -L "$token" && \
    -f "$block" && ! -L "$block" && \
    "$(<"$block")" == "agent-os-hub-recovery-block-v1:$transaction" && \
    ! -e "$mock_state/active.agent-os-hub.service" && \
    ! -e "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail "$label did not retain a token-free stopped parent transaction"
}

run_upgrade_maintenance_token_parent_restore_case() {
  local maintenance_previous_target
  maintenance_previous_target="$(readlink "$test_root/opt/agent-os/previous")" ||
    fail 'maintenance recovery fixture lacks its previous release pointer'
  [[ "$maintenance_previous_target" =~ ^releases/[A-Za-z0-9._-]{1,128}$ ]] ||
    fail 'maintenance recovery fixture has an invalid previous release pointer'
  printf '%s\n' revision-maintenance-fail >"$AGENT_OS_MOCK_CORRUPT_MAINTENANCE_REVISION"
  expect_failure 'upgrade accepted maintenance sentinel failure' \
    upgrade revision-maintenance-fail
  [[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
    "$(readlink "$test_root/opt/agent-os/previous")" == "$maintenance_previous_target" ]] ||
    fail 'maintenance failure did not restore pointers'
  [[ ! -f "$mock_state/active.agent-os-hub.service" && \
    ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail 'maintenance failure left the service active or enabled'
  [[ -d "$test_root/run/agent-os/hub-maintenance" && \
    -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail 'maintenance failure did not enter hard fail-closed mode'

  # The failed compensation start has already published an exact token for
  # the parent upgrade block.  Repair the malformed sentinel, consume that
  # token through the audited start gate, and return to inactive+disabled
  # before the signed restore adopts the parent transaction.
  rmdir "$test_root/run/agent-os/hub-maintenance"
  converge_upgrade_recovery_token_before_signed_restore \
    'upgrade maintenance failure'
  recover_test_state_from_signed_snapshot
}

if [[ "$VERIFY_FOCUS" == upgrade-maintenance-token-parent-restore ]]; then
  upgrade revision-3 >/dev/null ||
    fail 'focused maintenance recovery could not establish revision-3'
  /bin/bash -p "$fixed_bin/rollback.sh" --revision revision-1 >/dev/null ||
    fail 'focused maintenance recovery could not restore revision-1'
  [[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
    "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-3 && \
    -f "$mock_state/active.agent-os-hub.service" && \
    -f "$mock_state/enabled.agent-os-hub.service" ]] ||
    fail 'focused maintenance recovery did not establish canonical pointers and service state'
  expected_previous=revision-3
  run_upgrade_maintenance_token_parent_restore_case
  printf '%s\n' \
    'hub deploy focused gate: PASS upgrade-maintenance-token-parent-restore'
  exit 0
fi

# A failed first stop has no stopped-state fingerprint. Recovery therefore
# cannot infer that state is unchanged and must remain inactive + fail-closed.
: >"$AGENT_OS_MOCK_FAIL_STOP_ONCE"
assert_recovery_token_absent rollback-stop-before-failure
expect_failure 'rollback accepted an unverified stop failure' bash "$fixed_bin/rollback.sh"
assert_no_owned_test_processes rollback-stop-failure
assert_recovery_token_absent rollback-stop-after-failure
[[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
  "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-2 ]] ||
  fail 'rollback stop failure changed pointer history'
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  ! -f "$mock_state/enabled.agent-os-hub.service" ]] ||
  fail 'rollback stop failure did not leave the service inactive and disabled'
[[ -f "$test_root/run/agent-os/hub-maintenance" && \
  -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
  fail 'rollback stop failure did not block every proxied namespace'
[[ -f "$test_root/var/lib/agent-os-ops/hub-block" && \
  ! -e "$test_root/run/agent-os/hub-recovery-start" ]] ||
  fail 'rollback stop failure did not retain a token-free persistent block'

# Explicit recovery after the fail-closed stop evidence must itself use the
# audited restore transaction; deleting sentinels is never accepted recovery.
recover_test_state_from_signed_snapshot
if [[ "$VERIFY_FOCUS" != full ]]; then
  [[ -s "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE" ]] ||
    fail 'focused parent-bound restore produced no token-stage evidence'
  focused_token_trace="$temporary/focused-token-trace.current"
  awk -v label="call_label=$last_restore_token_call_label" \
    'index($0, label) { print }' "$AGENT_OS_MOCK_RESTORE_TOKEN_TRACE" \
    >"$focused_token_trace"
  [[ -s "$focused_token_trace" ]] ||
    fail 'focused parent-bound restore lacks current-call token evidence'
  printf 'focused-token-trace-summary call_label=%s lines=%s sha256=%s\n' \
    "$last_restore_token_call_label" \
    "$(wc -l <"$focused_token_trace" | tr -d ' ')" \
    "$(sha256_file "$focused_token_trace")"
  while IFS= read -r token_stage; do
    printf 'focused-token-trace %s\n' "$token_stage"
  done < <(tail -n 12 "$focused_token_trace")
  printf '%s\n' \
    "hub deploy focused gate: PASS $VERIFY_FOCUS"
  exit 0
fi

install_proc_writer_fixture() {
  local mode=$1 pid_root="$test_root/proc/9001/task/9001" uid=0 cgroup_path=
  local state_inode=
  cgroup_path=/system.slice/unrelated.service
  if [[ "$mode" == cgroup ]]; then
    cgroup_path=/system.slice/agent-os-hub.service
  elif [[ "$mode" == service-uid ]]; then
    uid=$MOCK_LIVE_UID
  elif [[ "$mode" != writable ]]; then
    fail 'unknown synthetic proc writer-fixture mode'
  fi
  write_proc_process_fixture 9001 "$uid" "$cgroup_path"
  if [[ "$mode" == writable ]]; then
    ln -s "$state_root/events.jsonl" "$pid_root/fd/7"
    state_inode="$($REAL_NODE_BIN -e \
      'process.stdout.write(String(require("node:fs").lstatSync(process.argv[1]).ino))' \
      "$state_root/events.jsonl")"
    [[ "$state_inode" =~ ^(0|[1-9][0-9]*)$ ]] ||
      fail 'synthetic proc fixture could not resolve the state inode'
    printf 'pos:\t0\nflags:\t0100002\nmnt_id:\t1\nino:\t%s\n' "$state_inode" \
      >"$pid_root/fdinfo/7"
    chmod 0600 "$pid_root/fdinfo/7"
  fi
}

assert_open_files_helper_result() {
  local probe=$1 expected_status=1 expected_stderr= expected_json=
  local marker="$temporary/open-files-reached-$probe" output="$temporary/open-files-$probe.out"
  local error="$temporary/open-files-$probe.err" status
  case "$probe" in
    clean)
      expected_status=0
      expected_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":false,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":false,"gate":"observable-reference","inspectionComplete":true,"ok":true,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":false,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":false}'
      ;;
    writable)
      expected_stderr='Hub state observable-reference gate failed: writable descriptor detected'
      expected_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":false,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":false,"gate":"observable-reference","inspectionComplete":true,"ok":false,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":false,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":true}'
      ;;
    cgroup)
      expected_stderr='Hub state observable-reference gate failed: forbidden cgroup member detected'
      expected_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":false,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":true,"gate":"observable-reference","inspectionComplete":true,"ok":false,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":false,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":false}'
      ;;
    service-uid)
      expected_stderr='Hub state observable-reference gate failed: service uid process detected'
      expected_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":false,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":false,"gate":"observable-reference","inspectionComplete":true,"ok":false,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":true,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":false}'
      ;;
    leaderless)
      expected_stderr='Hub state observable-reference gate failed: inspection unavailable'
      expected_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":false,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":false,"gate":"observable-reference","inspectionComplete":false,"ok":false,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":false,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":false}'
      ;;
    *) fail 'unknown open-file helper assertion mode' ;;
  esac
  rm -f -- "$marker" "$output" "$error"
  if AGENT_OS_MOCK_OPEN_FILES_REACHED="$marker" \
    AGENT_OS_MOCK_OPEN_FILES_CASE="$probe" \
    "$node_mock" "$fixed_bin/state-open-files.mjs" \
      "$state_root" \
      --forbidden-cgroup /system.slice/agent-os-hub.service \
      --service-uid "$MOCK_LIVE_UID" \
      --unit-inactive-proof inactive-mainpid0 \
      --proc-root "$test_root/proc" \
      --cgroup-root "$test_root/cgroup" \
      --inspector-pid 999 >"$output" 2>"$error"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" == "$expected_status" && "$(<"$output")" == "$expected_json" && \
    "$(<"$error")" == "$expected_stderr" && -f "$marker" && \
    "$(<"$marker")" == "$probe" ]] ||
    fail "real open-file helper $probe result contract did not match"
}

assert_writer_proof_failure() {
  local label=$1 probe=$2 before_log after_log new_log before_state marker
  marker="$temporary/open-files-reached-rollback-$probe"
  rm -f -- "$marker"
  before_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  before_state="$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")"
  export AGENT_OS_MOCK_OPEN_FILES_REACHED="$marker"
  export AGENT_OS_MOCK_OPEN_FILES_CASE="rollback-$probe"
  expect_failure "$label" /bin/bash -p "$fixed_bin/rollback.sh"
  unset AGENT_OS_MOCK_OPEN_FILES_REACHED AGENT_OS_MOCK_OPEN_FILES_CASE
  after_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  new_log="$(sed -n "$((before_log + 1)),${after_log}p" "$AGENT_OS_MOCK_SYSTEMCTL_LOG")"
  [[ "$new_log" != *$'start agent-os-hub.service'* ]] ||
    fail "$label restarted the Hub without writer-stop proof"
  [[ "$(readlink "$test_root/opt/agent-os/current")" == releases/revision-1 && \
    "$(readlink "$test_root/opt/agent-os/previous")" == releases/revision-2 ]] ||
    fail "$label moved release pointers without writer-stop proof"
  [[ "$($REAL_NODE_BIN "$fixed_bin/state-hash.mjs" "$state_root")" == "$before_state" ]] ||
    fail "$label changed state without writer-stop proof"
  [[ -f "$test_root/var/lib/agent-os-ops/hub-block" && \
    -f "$test_root/run/agent-os/hub-maintenance" && \
    -f "$test_root/run/agent-os/hub-maintenance-hard" ]] ||
    fail "$label removed ingress blocking without writer-stop proof"
  [[ ! -f "$mock_state/active.agent-os-hub.service" ]] ||
    fail "$label left the Hub active without writer-stop proof"
  [[ -f "$marker" && "$(<"$marker")" == "rollback-$probe" ]] ||
    fail "$label did not reach the real open-file helper"
}

assert_inactive_proof_rejected() {
  local label=$1 fault_path=$2 helper_marker
  helper_marker="$temporary/open-files-reached-inactive-$label"
  rm -f -- "$helper_marker"
  : >"$fault_path"
  "$systemctl_mock" start agent-os-hub.service
  export AGENT_OS_MOCK_OPEN_FILES_REACHED="$helper_marker"
  export AGENT_OS_MOCK_OPEN_FILES_CASE="inactive-$label"
  expect_failure \
    "writer-stop proof accepted inactive evidence: $label" \
    /bin/bash -p -c \
      'source "$1"; stop_and_prove_writer_stopped_for_path "$2"' \
      _ "$fixed_bin/lib.sh" "$state_root"
  unset AGENT_OS_MOCK_OPEN_FILES_REACHED AGENT_OS_MOCK_OPEN_FILES_CASE
  [[ ! -e "$fault_path" && ! -e "$helper_marker" && \
    ! -e "$mock_state/active.agent-os-hub.service" ]] ||
    fail "writer-stop inactive rejection $label reached the helper or left bad evidence"
}

# Exercise lib.sh through the installed admin kit and the real helper before
# injecting residual processes. Invalid account resolutions must fail before
# the first systemd mutation.
assert_inactive_proof_rejected show-failure "$AGENT_OS_MOCK_FAIL_INACTIVE_SHOW_ONCE"
assert_inactive_proof_rejected empty-mainpid "$AGENT_OS_MOCK_EMPTY_MAINPID_ONCE"
assert_inactive_proof_rejected nonzero-mainpid "$AGENT_OS_MOCK_NONZERO_MAINPID_ONCE"
assert_inactive_proof_rejected noninactive-state "$AGENT_OS_MOCK_NONINACTIVE_STATE_ONCE"
: >"$AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE"
/bin/bash -p -c \
  'source "$1"; reset_failed_or_prove_inactive agent-os-hub.service' \
  _ "$fixed_bin/lib.sh" ||
  fail 'inactive garbage-collected unit did not tolerate reset-failed not-loaded'
[[ ! -e "$AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE" ]] ||
  fail 'inactive reset-failed not-loaded probe did not reach the systemd boundary'
: >"$AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE"
"$systemctl_mock" start agent-os-hub.service
expect_failure \
  'active unit accepted reset-failed not-loaded without strict inactive proof' \
  /bin/bash -p -c \
    'source "$1"; reset_failed_or_prove_inactive agent-os-hub.service' \
    _ "$fixed_bin/lib.sh"
[[ ! -e "$AGENT_OS_MOCK_FAIL_RESET_FAILED_NOT_LOADED_ONCE" && \
  -f "$mock_state/active.agent-os-hub.service" ]] ||
  fail 'active reset-failed rejection changed service state or missed its boundary'
"$systemctl_mock" stop agent-os-hub.service
assert_open_files_helper_result clean
write_proc_process_fixture 9002 0 /system.slice/unrelated.service
rm -f -- "$test_root/proc/9002/stat"
assert_open_files_helper_result leaderless
rm -rf -- "$test_root/proc/9002" "$test_root/process-context/9002"
clean_open_files_marker="$temporary/open-files-reached-lib-clean"
rm -f -- "$clean_open_files_marker"
export AGENT_OS_MOCK_OPEN_FILES_REACHED="$clean_open_files_marker"
export AGENT_OS_MOCK_OPEN_FILES_CASE=lib-clean
"$systemctl_mock" start agent-os-hub.service
/bin/bash -p -c \
  'source "$1"; stop_and_prove_writer_stopped_for_path "$2"' \
  _ "$fixed_bin/lib.sh" "$state_root" ||
  fail 'audited lib did not accept a clean real open-file proof'
unset AGENT_OS_MOCK_OPEN_FILES_REACHED AGENT_OS_MOCK_OPEN_FILES_CASE
[[ ! -f "$mock_state/active.agent-os-hub.service" ]] ||
  fail 'clean real open-file proof did not stop the Hub'
[[ -f "$clean_open_files_marker" && \
  "$(<"$clean_open_files_marker")" == lib-clean ]] ||
  fail 'clean lib proof did not reach the real open-file helper'
"$systemctl_mock" start agent-os-hub.service

# systemd may remove an empty service cgroup before the post-stop inspection.
# The observable-reference contract must treat that exact lifecycle as clean,
# while still completing both scans of unrelated processes and aliases.
cgroup_absent_marker="$temporary/open-files-reached-cgroup-absent"
cgroup_absent_capture="$temporary/open-files-cgroup-absent"
cgroup_absent_json='{"aliasInspectionComplete":true,"cgroupDirectoryAbsent":true,"cgroupPopulatedDetected":false,"directoryDescriptorDetected":false,"forbiddenCgroupMemberDetected":false,"gate":"observable-reference","inspectionComplete":true,"ok":true,"processRootDetected":false,"scanCount":2,"serviceUidProcessDetected":false,"sharedWritableMappingDetected":false,"workingDirectoryDetected":false,"writableDescriptorDetected":false}'
rm -rf -- "$test_root/cgroup/system.slice/agent-os-hub.service"
write_proc_process_fixture 9003 0 /system.slice/unrelated-churn.service
export AGENT_OS_MOCK_OPEN_FILES_REACHED="$cgroup_absent_marker"
export AGENT_OS_MOCK_OPEN_FILES_CASE=lib-cgroup-absent
export AGENT_OS_MOCK_OPEN_FILES_CAPTURE="$cgroup_absent_capture"
/bin/bash -p -c \
  'source "$1"; stop_and_prove_writer_stopped_for_path "$2"' \
  _ "$fixed_bin/lib.sh" "$state_root" ||
  fail 'audited lib rejected a clean trimmed service-cgroup proof'
unset \
  AGENT_OS_MOCK_OPEN_FILES_REACHED \
  AGENT_OS_MOCK_OPEN_FILES_CASE \
  AGENT_OS_MOCK_OPEN_FILES_CAPTURE
[[ ! -f "$mock_state/active.agent-os-hub.service" && \
  -f "$cgroup_absent_marker" && \
  "$(<"$cgroup_absent_marker")" == lib-cgroup-absent && \
  "$(<"$cgroup_absent_capture.out")" == "$cgroup_absent_json" && \
  ! -s "$cgroup_absent_capture.err" ]] ||
  fail 'trimmed service-cgroup proof did not expose its exact observable result'
rm -rf -- "$test_root/proc/9003" "$test_root/process-context/9003"
install -d -m 0700 \
  "$test_root/cgroup/system.slice/agent-os-hub.service"
printf 'populated 0\nfrozen 0\n' \
  >"$test_root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
chmod 0600 \
  "$test_root/cgroup/system.slice/agent-os-hub.service/cgroup.events"
"$systemctl_mock" start agent-os-hub.service

valid_service_uid=$MOCK_LIVE_UID
for invalid_service_uid in 0 01 4294967296 invalid; do
  before_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  MOCK_LIVE_UID=$invalid_service_uid
  expect_failure \
    "open-file proof accepted invalid service UID $invalid_service_uid" \
    /bin/bash -p -c \
      'source "$1"; stop_and_prove_writer_stopped_for_path "$2"' \
      _ "$fixed_bin/lib.sh" "$state_root"
  after_log="$(wc -l <"$AGENT_OS_MOCK_SYSTEMCTL_LOG" | tr -d ' ')"
  [[ "$after_log" == "$before_log" ]] ||
    fail "invalid service UID $invalid_service_uid mutated systemd state"
done
MOCK_LIVE_UID=$valid_service_uid

install_proc_writer_fixture writable
assert_open_files_helper_result writable
assert_writer_proof_failure \
  'rollback accepted a globally visible writable state descriptor' writable
rm -rf -- "$test_root/proc/9001"
recover_test_state_from_signed_snapshot
install_proc_writer_fixture cgroup
assert_open_files_helper_result cgroup
assert_writer_proof_failure \
  'rollback accepted a process remaining in the forbidden Hub cgroup' cgroup
rm -rf -- "$test_root/proc/9001"
recover_test_state_from_signed_snapshot
install_proc_writer_fixture service-uid
assert_open_files_helper_result service-uid
assert_writer_proof_failure \
  'rollback accepted a process retaining the Hub service UID' service-uid
rm -rf -- "$test_root/proc/9001"
recover_test_state_from_signed_snapshot

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

# The signed restore repairs the source mutation and clears the transaction-
# bound persistent block only after verification and a one-shot start.
recover_test_state_from_signed_snapshot

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
recover_test_state_from_signed_snapshot

# Fail the final maintenance removal without changing state. The failed
# compensation start leaves a transaction-bound token; the audited recovery
# path must consume it before a signed restore can adopt the parent block.
run_upgrade_maintenance_token_parent_restore_case

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
