#!/bin/bash -p

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\n' 'lib.sh must be sourced by a Hub deployment command' >&2
  exit 2
fi

set -Eeuo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
for node_influence in \
  NODE_OPTIONS \
  NODE_PATH \
  NODE_EXTRA_CA_CERTS \
  NODE_TLS_REJECT_UNAUTHORIZED \
  OPENSSL_CONF \
  OPENSSL_CONF_INCLUDE \
  OPENSSL_ENGINES \
  OPENSSL_MODULES \
  SSL_CERT_FILE \
  SSL_CERT_DIR; do
  if [[ -n "${!node_influence+x}" ]]; then
    printf 'Hub deployment failed: deployment runtime rejects inherited variable %s\n' \
      "$node_influence" >&2
    exit 1
  fi
done

readonly_expected_legacy_admin=1f064246a0f547571aa832b374baae377a8bbfb3b8b10733ed530b459d168220
readonly_expected_legacy_runtime=a9f4727b3331d4ed3f2aeb8ea51da730a26507946259d64c352453528d677fea
readonly_current_lib_dir="$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${AGENT_OS_HUB_DEPLOY_LIB_INITIALIZED:-}" == v1 ]]; then
  if [[ "${DEPLOY_LIB_DIR:-}" != "$readonly_current_lib_dir" || \
    "${LEGACY_ADMIN_PRODUCTION_SHA256:-}" != \
      "$readonly_expected_legacy_admin" || \
    "${LEGACY_RUNTIME_PRODUCTION_SHA256:-}" != \
      "$readonly_expected_legacy_runtime" ]]; then
    printf '%s\n' 'Hub deployment failed: repeated deployment library source changed its fixed contract' >&2
    return 1
  fi
  unset readonly_expected_legacy_admin readonly_expected_legacy_runtime \
    readonly_current_lib_dir
  return 0
fi
if [[ -n "${AGENT_OS_HUB_DEPLOY_LIB_INITIALIZED+x}" || \
  -n "${LEGACY_ADMIN_PRODUCTION_SHA256+x}" || \
  -n "${LEGACY_RUNTIME_PRODUCTION_SHA256+x}" ]]; then
  printf '%s\n' 'Hub deployment failed: deployment library fixed contract was preset' >&2
  return 1
fi

readonly DEPLOY_LIB_DIR="$readonly_current_lib_dir"
readonly DEPLOY_SOURCE_ROOT="$(CDPATH= cd -- "$DEPLOY_LIB_DIR/.." && pwd -P)"
readonly SERVICE_NAME=agent-os-hub.service
readonly CANDIDATE_SERVICE_PREFIX=agent-os-hub-candidate@
readonly SERVICE_USER=agent-os
readonly SERVICE_GROUP=agent-os
readonly CANDIDATE_SERVICE_USER=agent-os-candidate
readonly CANDIDATE_SERVICE_GROUP=agent-os-candidate
readonly EXPECTED_NODE_VERSION=24.19.0
readonly EXPECTED_COREPACK_VERSION=0.35.0
readonly LEGACY_ADMIN_PRODUCTION_SHA256="$readonly_expected_legacy_admin"
readonly LEGACY_RUNTIME_PRODUCTION_SHA256="$readonly_expected_legacy_runtime"
readonly AGENT_OS_HUB_DEPLOY_LIB_INITIALIZED=v1
unset readonly_expected_legacy_admin readonly_expected_legacy_runtime \
  readonly_current_lib_dir
readonly PRODUCTION_NODE_BIN=/usr/bin/node
readonly PRODUCTION_COREPACK_BIN=/usr/bin/corepack
TEST_ROOT="${AGENT_OS_DEPLOY_TEST_ROOT:-}"
if [[ -n "$TEST_ROOT" ]]; then
  ID_BIN="${AGENT_OS_ID_BIN:-/usr/bin/id}"
  SYSTEMCTL_BIN="${AGENT_OS_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
  SS_BIN="${AGENT_OS_SS_BIN:-/usr/bin/ss}"
  FLOCK_BIN="${AGENT_OS_FLOCK_BIN:-/usr/bin/flock}"
  NODE_BIN="${AGENT_OS_NODE_BIN:-$PRODUCTION_NODE_BIN}"
else
  ID_BIN=/usr/bin/id
  if [[ -n "${AGENT_OS_SYSTEMCTL_BIN:-}" && \
    "$AGENT_OS_SYSTEMCTL_BIN" != /usr/bin/systemctl ]]; then
    printf '%s\n' 'Hub deployment failed: production rejects AGENT_OS_SYSTEMCTL_BIN override' >&2
    exit 1
  fi
  if [[ -n "${AGENT_OS_SS_BIN:-}" && "$AGENT_OS_SS_BIN" != /usr/bin/ss ]]; then
    printf '%s\n' 'Hub deployment failed: production rejects AGENT_OS_SS_BIN override' >&2
    exit 1
  fi
  if [[ -n "${AGENT_OS_FLOCK_BIN:-}" && "$AGENT_OS_FLOCK_BIN" != /usr/bin/flock ]]; then
    printf '%s\n' 'Hub deployment failed: production rejects AGENT_OS_FLOCK_BIN override' >&2
    exit 1
  fi
  if [[ -n "${AGENT_OS_NODE_BIN:-}" && "$AGENT_OS_NODE_BIN" != "$PRODUCTION_NODE_BIN" ]]; then
    printf '%s\n' 'Hub deployment failed: production rejects AGENT_OS_NODE_BIN override' >&2
    exit 1
  fi
  SYSTEMCTL_BIN=/usr/bin/systemctl
  SS_BIN=/usr/bin/ss
  FLOCK_BIN=/usr/bin/flock
  NODE_BIN=$PRODUCTION_NODE_BIN
fi
readonly ID_BIN
readonly SYSTEMCTL_BIN
readonly SS_BIN
readonly FLOCK_BIN
readonly STAT_BIN=/usr/bin/stat
readonly HEALTH_ATTEMPTS="${AGENT_OS_HEALTH_ATTEMPTS:-30}"
readonly HEALTH_INTERVAL="${AGENT_OS_HEALTH_INTERVAL:-2}"

stat_value() {
  local gnu_format=$1 bsd_format=$2 path=$3
  [[ -x "$STAT_BIN" ]] || return 1
  if "$STAT_BIN" -c "$gnu_format" "$path" >/dev/null 2>&1; then
    "$STAT_BIN" -c "$gnu_format" "$path"
  else
    "$STAT_BIN" -f "$bsd_format" "$path"
  fi
}

trusted_parent_chain() {
  local path=$1 directory remaining current component next owner mode
  directory=${path%/*}
  [[ -n "$directory" ]] || directory=/
  [[ "$directory" == /* ]] || return 1
  current=/
  owner="$(stat_value '%u' '%u' "$current")" || return 1
  mode="$(stat_value '%a' '%Lp' "$current")" || return 1
  [[ "$owner" == 0 ]] || return 1
  mode_is_safe "$mode" || return 1
  remaining=${directory#/}
  while [[ -n "$remaining" ]]; do
    component=${remaining%%/*}
    if [[ "$remaining" == */* ]]; then remaining=${remaining#*/}; else remaining=; fi
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    if [[ "$current" == / ]]; then next="/$component"; else next="$current/$component"; fi
    [[ -d "$next" ]] || return 1
    current="$(CDPATH= cd -P -- "$next" 2>/dev/null && pwd -P)" || return 1
    owner="$(stat_value '%u' '%u' "$current")" || return 1
    mode="$(stat_value '%a' '%Lp' "$current")" || return 1
    [[ "$owner" == 0 ]] || return 1
    mode_is_safe "$mode" || return 1
  done
  return 0
}

resolve_trusted_executable() {
  local label=$1 requested=$2 current directory name target owner mode hop
  [[ "$requested" == /* && "$requested" != *$'\n'* && "$requested" != *'//'* ]] ||
    die "$label executable path must be absolute"
  case "/$requested/" in
    */../* | */./*) die "$label executable path must not contain dot components" ;;
  esac
  [[ -x /usr/bin/readlink ]] || die 'fixed readlink executable is unavailable'
  current=$requested
  for ((hop = 0; hop < 32; hop += 1)); do
    directory=${current%/*}
    name=${current##*/}
    [[ -n "$directory" ]] || directory=/
    [[ -n "$name" ]] || die "$label executable path is invalid"
    directory="$(CDPATH= cd -P -- "$directory" 2>/dev/null && pwd -P)" ||
      die "$label executable parent cannot be canonicalized"
    if [[ "$directory" == / ]]; then current="/$name"; else current="$directory/$name"; fi
    if [[ -L "$current" ]]; then
      target="$(/usr/bin/readlink "$current")" ||
        die "$label executable symbolic link cannot be read"
      [[ -n "$target" && "$target" != *$'\n'* ]] ||
        die "$label executable symbolic link target is invalid"
      if [[ "$target" == /* ]]; then current=$target; else current="$directory/$target"; fi
      continue
    fi
    [[ -f "$current" && -x "$current" ]] ||
      die "$label executable must resolve to an executable regular file"
    if [[ -z "$TEST_ROOT" ]]; then
      trusted_parent_chain "$requested" ||
        die "$label executable requested path has an untrusted ancestor"
      trusted_parent_chain "$current" ||
        die "$label executable resolved path has an untrusted ancestor"
      owner="$(stat_value '%u' '%u' "$current")"
      mode="$(stat_value '%a' '%Lp' "$current")"
      [[ "$owner" == 0 ]] || die "$label executable is not root-owned"
      mode_is_safe "$mode" || die "$label executable is group/world writable"
    fi
    RESOLVED_EXECUTABLE=$current
    return 0
  done
  die "$label executable symbolic link depth exceeded the limit"
}

if [[ -n "$TEST_ROOT" ]]; then
  [[ "${AGENT_OS_DEPLOY_TEST_MODE:-}" == 1 ]] || {
    printf '%s\n' 'deployment rejected: test root requires AGENT_OS_DEPLOY_TEST_MODE=1' >&2
    exit 1
  }
  ((EUID != 0)) || {
    printf '%s\n' 'deployment rejected: test mode must never run as root' >&2
    exit 1
  }
  [[ "$TEST_ROOT" == /* && "$TEST_ROOT" != / && -d "$TEST_ROOT" && ! -L "$TEST_ROOT" ]] || {
    printf '%s\n' 'deployment rejected: test root must be a non-root absolute path' >&2
    exit 1
  }
  case "/$TEST_ROOT/" in
    */../* | */./*)
      printf '%s\n' 'deployment rejected: test root must not contain dot path components' >&2
      exit 1
      ;;
  esac
  canonical_test_root="$(CDPATH= cd -- "$TEST_ROOT" && pwd -P)" || {
    printf '%s\n' 'deployment rejected: test root cannot be canonicalized' >&2
    exit 1
  }
  [[ "$canonical_test_root" == "$TEST_ROOT" ]] || {
    printf '%s\n' 'deployment rejected: test root contains a symlink or non-canonical component' >&2
    exit 1
  }
  marker="$TEST_ROOT/.agent-os-deploy-test-root"
  nonce="${AGENT_OS_DEPLOY_TEST_NONCE:-}"
  [[ -n "$nonce" && "$nonce" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || {
    printf '%s\n' 'deployment rejected: test root nonce is missing or invalid' >&2
    exit 1
  }
  [[ -f "$marker" && ! -L "$marker" && "$(<"$marker")" == "$nonce" ]] || {
    printf '%s\n' 'deployment rejected: test root ownership marker is missing or invalid' >&2
    exit 1
  }
  marker_mode="$(stat_value '%a' '%Lp' "$marker")"
  marker_uid="$(stat_value '%u' '%u' "$marker")"
  [[ "$marker_mode" == 600 ]] || {
    printf '%s\n' 'deployment rejected: test root marker mode must be 0600' >&2
    exit 1
  }
  [[ "$marker_uid" == "$EUID" ]] || {
    printf '%s\n' 'deployment rejected: test root marker belongs to another account' >&2
    exit 1
  }
fi
readonly TEST_ROOT

admin_contract_uid() {
  if [[ -n "$TEST_ROOT" ]]; then printf '%s\n' "$EUID"; else printf '%s\n' 0; fi
}

admin_contract_gid() {
  if [[ -n "$TEST_ROOT" ]]; then "$ID_BIN" -g; else printf '%s\n' 0; fi
}

rooted() {
  local canonical=$1
  [[ "$canonical" == /* ]] || die 'internal path is not absolute'
  [[ "$canonical" != *'/../'* && "$canonical" != */.. && "$canonical" != *'/./'* ]] ||
    die 'internal path is not canonical'
  local result="${TEST_ROOT}${canonical}"
  if [[ -n "$TEST_ROOT" ]]; then
    case "$result" in
      "$TEST_ROOT"/*) ;;
      *) die 'internal path escaped the test root' ;;
    esac
  fi
  printf '%s\n' "$result"
}

readonly OPT_ROOT="$(rooted /opt/agent-os)"
readonly RELEASES_ROOT="$OPT_ROOT/releases"
readonly CURRENT_LINK="$OPT_ROOT/current"
readonly PREVIOUS_LINK="$OPT_ROOT/previous"
readonly QUARANTINE_ROOT="$OPT_ROOT/quarantine"
readonly ADMIN_PARENT="$(rooted /usr/libexec/agent-os)"
readonly ADMIN_ROOT="$(rooted /usr/libexec/agent-os/hub)"
readonly CONFIG_ROOT="$(rooted /etc/agent-os)"
readonly ENV_FILE="$CONFIG_ROOT/hub.env"
readonly STATE_PARENT="$(rooted /var/lib/agent-os)"
readonly STATE_ROOT="$(rooted /var/lib/agent-os/hub)"
readonly BACKUP_PARENT="$(rooted /var/backups/agent-os)"
readonly BACKUP_ROOT="$(rooted /var/backups/agent-os/hub)"
readonly OPS_ROOT="$(rooted /var/lib/agent-os-ops)"
readonly RECOVERY_ROOT="$OPS_ROOT/private"
readonly DURABLE_BLOCK_PATH="$OPS_ROOT/hub-block"
readonly UNIT_PATH="$(rooted /etc/systemd/system/agent-os-hub.service)"
readonly CANDIDATE_UNIT_PATH="$(rooted /etc/systemd/system/agent-os-hub-candidate@.service)"
readonly NGINX_EXAMPLE_PATH="$(rooted /etc/nginx/sites-available/agent-os-hub.conf.example)"
readonly NGINX_LIMITS_EXAMPLE_PATH="$(rooted /etc/nginx/conf.d/agent-os-hub-limits.conf.example)"
readonly RUNTIME_ROOT="$(rooted /run/agent-os)"
readonly LOCK_PATH="$RUNTIME_ROOT/hub-deploy.lock"
readonly MAINTENANCE_PATH="$RUNTIME_ROOT/hub-maintenance"
readonly FAIL_CLOSED_PATH="$RUNTIME_ROOT/hub-maintenance-hard"
readonly RECOVERY_START_PATH="$RUNTIME_ROOT/hub-recovery-start"
readonly CANDIDATE_ENV_ROOT="$RUNTIME_ROOT/hub-candidates"
readonly CANDIDATE_STATE_ROOT="$(rooted /var/lib/agent-os/hub-candidates)"

die() {
  printf 'Hub deployment failed: %s\n' "$1" >&2
  exit 1
}

notice() {
  printf 'hub_deploy phase=%s status=%s\n' "$1" "$2"
}

require_privilege() {
  if [[ -z "$TEST_ROOT" ]] && ((EUID != 0)); then
    die 'run as root'
  fi
}

require_commands() {
  local command_name
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 || die "required command is unavailable: $command_name"
  done
}

mode_is_safe() {
  local mode=$1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (((8#$mode & 8#022) == 0))
}

require_pinned_node() {
  resolve_trusted_executable Node "$NODE_BIN"
  readonly NODE_BIN
  local version
  version="$($NODE_BIN -p 'process.versions.node' 2>/dev/null)" ||
    die 'Node version check failed'
  [[ "$version" == "$EXPECTED_NODE_VERSION" ]] ||
    die "Node $EXPECTED_NODE_VERSION is required"
}

validate_revision() {
  local revision=$1
  [[ "$revision" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
    die 'revision must be a 1..128 character filesystem-safe identifier'
}

validate_checksum() {
  [[ "$1" =~ ^[A-Fa-f0-9]{64}$ ]] || die 'SHA-256 must contain exactly 64 hexadecimal characters'
}

sha256_file() {
  local file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die 'a SHA-256 implementation is required'
  fi
}

verify_archive() {
  local archive=$1 expected=$2 actual normalized_expected
  [[ -f "$archive" && ! -L "$archive" ]] || die 'release archive must be a regular file'
  validate_checksum "$expected"
  actual="$(sha256_file "$archive" | tr 'A-F' 'a-f')"
  normalized_expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  [[ "$actual" == "$normalized_expected" ]] || die 'release archive checksum mismatch'
}

install_directory() {
  local mode=$1 owner=$2 group=$3 path=$4
  if [[ -n "$TEST_ROOT" ]]; then
    install -d -m "$mode" "$path"
  else
    install -d -m "$mode" -o "$owner" -g "$group" "$path"
  fi
}

install_durable_directory() {
  local mode=$1 owner=$2 group=$3 path=$4 existed=false
  [[ -d "$path" && ! -L "$path" ]] && existed=true
  install_directory "$mode" "$owner" "$group" "$path"
  fsync_path "$path"
  if [[ "$existed" != true ]]; then fsync_path "$(dirname -- "$path")"; fi
}

install_regular_file() {
  local mode=$1 owner=$2 group=$3 source=$4 destination=$5
  [[ -f "$source" && ! -L "$source" ]] || die 'installation source must be a regular file'
  if [[ -n "$TEST_ROOT" ]]; then
    install -m "$mode" "$source" "$destination"
  else
    install -m "$mode" -o "$owner" -g "$group" "$source" "$destination"
  fi
}

ensure_system_directory() {
  local path=$1 canonical mode owner
  if [[ -n "$TEST_ROOT" ]]; then
    install_directory 0755 root root "$path"
    return 0
  fi
  [[ -d "$path" && ! -L "$path" ]] ||
    die 'required system integration directory is missing or unsafe'
  canonical="$(CDPATH= cd -- "$path" && pwd -P)" ||
    die 'required system integration directory cannot be canonicalized'
  [[ "$canonical" == "$path" ]] ||
    die 'required system integration directory contains a symbolic link'
  mode="$(stat_value '%a' '%Lp' "$path")"
  owner="$(stat_value '%u' '%u' "$path")"
  [[ "$owner" == 0 ]] || die 'required system integration directory is not root-owned'
  mode_is_safe "$mode" ||
    die 'required system integration directory is group/world writable'
}

validate_existing_identity() {
  local account_user=$1 account_group=$2 account_home_expected=$3
  local account_entry account_name account_uid account_gid account_home account_shell
  local account_status duplicate_uid_count group_entry group_name group_gid
  local numeric_uid numeric_gid primary_group group_ids

  numeric_uid="$("$ID_BIN" -u "$account_user")" ||
    die 'existing service identity UID is unavailable'
  numeric_gid="$("$ID_BIN" -g "$account_user")" ||
    die 'existing service identity GID is unavailable'
  [[ "$numeric_uid" =~ ^[0-9]+$ && "$numeric_gid" =~ ^[0-9]+$ ]] ||
    die 'existing service identity has a non-numeric UID or GID'
  ((numeric_uid != 0 && numeric_gid != 0)) ||
    die 'service identity UID and GID must both be non-root'

  primary_group="$("$ID_BIN" -gn "$account_user")" ||
    die 'existing service identity primary group is unavailable'
  [[ "$primary_group" == "$account_group" ]] ||
    die 'existing service identity has the wrong primary group'
  group_entry="$(getent group "$account_group")" ||
    die 'existing service group entry is unavailable'
  IFS=: read -r group_name _ group_gid _ <<<"$group_entry"
  [[ "$group_name" == "$account_group" && "$group_gid" == "$numeric_gid" ]] ||
    die 'existing service group entry does not match the account primary GID'
  [[ "$group_gid" =~ ^[0-9]+$ ]] && ((group_gid != 0)) ||
    die 'service identity group must have a non-root numeric GID'

  account_entry="$(getent passwd "$account_user")" ||
    die 'existing service identity passwd entry is unavailable'
  IFS=: read -r account_name _ account_uid account_gid _ account_home account_shell <<<"$account_entry"
  [[ "$account_name" == "$account_user" && "$account_uid" == "$numeric_uid" && \
    "$account_gid" == "$numeric_gid" ]] ||
    die 'existing service identity passwd entry is inconsistent'
  [[ "$account_home" == "$account_home_expected" ]] ||
    die 'existing service identity has the wrong home'
  [[ "$account_shell" == /usr/sbin/nologin || "$account_shell" == /bin/false ]] ||
    die 'existing service identity must have a non-login shell'

  duplicate_uid_count="$(getent passwd | awk -F: -v identity_uid="$numeric_uid" \
    '$3 == identity_uid { count += 1 } END { print count + 0 }')" ||
    die 'existing service identity uniqueness check failed'
  [[ "$duplicate_uid_count" == 1 ]] ||
    die 'service identity UID must map to exactly one passwd entry'

  account_status="$(passwd -S "$account_user" 2>/dev/null | awk '{print $2}')" ||
    die 'existing service identity password status is unavailable'
  [[ "$account_status" == L || "$account_status" == LK ]] ||
    die 'existing service identity must have a locked password'
  group_ids="$("$ID_BIN" -G "$account_user")" ||
    die 'existing service identity group membership is unavailable'
  [[ "$group_ids" == "$numeric_gid" ]] ||
    die 'existing service identity must not have supplementary groups'
}

ensure_locked_identity() {
  local account_user=$1 account_group=$2 account_home_expected=$3 group_entry group_gid
  [[ -n "$TEST_ROOT" ]] && return 0
  if ! getent group "$account_group" >/dev/null; then
    groupadd --system "$account_group"
  fi
  group_entry="$(getent group "$account_group")" || die 'service group entry is unavailable'
  IFS=: read -r _ _ group_gid _ <<<"$group_entry"
  [[ "$group_gid" =~ ^[0-9]+$ ]] && ((group_gid != 0)) ||
    die 'service identity group must have a non-root numeric GID'
  if ! "$ID_BIN" "$account_user" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "$account_group" \
      --home-dir "$account_home_expected" \
      --shell /usr/sbin/nologin \
      "$account_user"
  fi
  validate_existing_identity "$account_user" "$account_group" "$account_home_expected"
}

validate_identity_separation() {
  local live_uid live_gid candidate_uid candidate_gid
  live_uid="$("$ID_BIN" -u "$SERVICE_USER")" || die 'live service UID is unavailable'
  live_gid="$("$ID_BIN" -g "$SERVICE_USER")" || die 'live service GID is unavailable'
  candidate_uid="$("$ID_BIN" -u "$CANDIDATE_SERVICE_USER")" ||
    die 'candidate service UID is unavailable'
  candidate_gid="$("$ID_BIN" -g "$CANDIDATE_SERVICE_USER")" ||
    die 'candidate service GID is unavailable'
  [[ "$live_uid" =~ ^[0-9]+$ && "$live_gid" =~ ^[0-9]+$ && \
    "$candidate_uid" =~ ^[0-9]+$ && "$candidate_gid" =~ ^[0-9]+$ ]] ||
    die 'service identity separation requires numeric UID and GID values'
  ((live_uid != 0 && live_gid != 0 && candidate_uid != 0 && candidate_gid != 0)) ||
    die 'service identities must not use UID or GID zero'
  [[ "$live_uid" != "$candidate_uid" ]] ||
    die 'live and candidate services must use distinct numeric UIDs'
  [[ "$live_gid" != "$candidate_gid" ]] ||
    die 'live and candidate services must use distinct numeric GIDs'
}

ensure_service_identity() {
  ensure_locked_identity "$SERVICE_USER" "$SERVICE_GROUP" /var/lib/agent-os
  ensure_locked_identity \
    "$CANDIDATE_SERVICE_USER" \
    "$CANDIDATE_SERVICE_GROUP" \
    /var/lib/agent-os/hub-candidates
  [[ -n "$TEST_ROOT" ]] || validate_identity_separation
}

ensure_layout() {
  require_commands install chmod stat
  if [[ -z "$TEST_ROOT" ]]; then
    require_commands getent groupadd useradd id passwd awk
  fi
  ensure_service_identity
  install_directory 0755 root root "$OPT_ROOT"
  install_directory 0755 root root "$RELEASES_ROOT"
  install_directory 0700 root root "$QUARANTINE_ROOT"
  install_directory 0755 root root "$ADMIN_PARENT"
  install_directory 0700 root root "$CONFIG_ROOT"
  install_durable_directory 0755 root root "$STATE_PARENT"
  install_durable_directory 0700 "$SERVICE_USER" "$SERVICE_GROUP" "$STATE_ROOT"
  install_durable_directory 0700 root root "$BACKUP_PARENT"
  install_durable_directory 0700 root root "$BACKUP_ROOT"
  install_durable_directory 0755 root root "$OPS_ROOT"
  install_durable_directory 0700 root root "$RECOVERY_ROOT"
  ensure_system_directory "$(dirname -- "$UNIT_PATH")"
  ensure_system_directory "$(dirname -- "$NGINX_EXAMPLE_PATH")"
  ensure_system_directory "$(dirname -- "$NGINX_LIMITS_EXAMPLE_PATH")"
  install_directory 0755 root root "$RUNTIME_ROOT"
  install_directory 0700 root root "$CANDIDATE_ENV_ROOT"
  install_directory 0755 root root "$CANDIDATE_STATE_ROOT"
}

require_existing_recovery_layout() {
  local path expected_mode actual_mode actual_uid expected_uid=$EUID canonical
  while IFS=' ' read -r expected_mode path; do
    [[ -d "$path" && ! -L "$path" ]] ||
      die 'recovery layout directory is missing or unsafe'
    canonical="$(CDPATH= cd -P -- "$path" 2>/dev/null && pwd -P)" ||
      die 'recovery layout directory cannot be canonicalized'
    [[ "$canonical" == "$path" ]] ||
      die 'recovery layout directory contains a symbolic ancestor'
    actual_mode="$(stat_value '%a' '%Lp' "$path")"
    actual_uid="$(stat_value '%u' '%u' "$path")"
    [[ "$actual_mode" == "$expected_mode" && "$actual_uid" == "$expected_uid" ]] ||
      die 'recovery layout directory ownership or mode is unsafe'
  done <<EOF
755 $STATE_PARENT
700 $BACKUP_ROOT
755 $OPS_ROOT
700 $RECOVERY_ROOT
755 $RUNTIME_ROOT
EOF
}

admin_files() {
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
    systemd/agent-os-hub-candidate@.service
  printf '%s\n' pre-upgrade-snapshot
}

legacy_admin_files() {
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

legacy_runtime_files() {
  printf '%s\n' \
    "0644|systemd/agent-os-hub.service|$UNIT_PATH|hub-unit" \
    "0644|systemd/agent-os-hub-candidate@.service|$CANDIDATE_UNIT_PATH|candidate-unit" \
    "0644|nginx/agent-os-hub.conf|$NGINX_EXAMPLE_PATH|nginx-example" \
    "0644|nginx/agent-os-hub-limits.conf|$NGINX_LIMITS_EXAMPLE_PATH|nginx-limits" \
    "0600|env.example|$CONFIG_ROOT/hub.env.example|env-example"
}

tree_sha256_for() {
  local root=$1 summary
  summary="$("$NODE_BIN" "$DEPLOY_SOURCE_ROOT/bin/tree-digest.mjs" "$root")" ||
    return 1
  "$NODE_BIN" -e \
    'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
    "$summary"
}

canonical_root_tree_sha256_for() {
  local root=$1 summary
  summary="$("$NODE_BIN" "$DEPLOY_SOURCE_ROOT/bin/tree-digest.mjs" \
    --canonical-root-owner "$root")" || return 1
  "$NODE_BIN" -e \
    'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
    "$summary"
}

verify_legacy_admin_kit() {
  local root=$1 expected_digest=$2 path relative expected_uid expected_gid
  local owner group mode links
  local actual_digest allowed=false count=0 expected_mode
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  validate_checksum "$expected_digest"
  expected_digest="$(printf '%s' "$expected_digest" | tr 'A-F' 'a-f')"
  [[ "$expected_digest" == "$LEGACY_ADMIN_PRODUCTION_SHA256" ]] || return 1
  [[ -d "$root" && ! -L "$root" ]] || return 1
  [[ "$(stat_value '%u' '%u' "$root")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$root")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$root")" == 555 ]] || return 1
  while IFS= read -r -d '' path; do
    relative=${path#"$root"/}
    if [[ -d "$path" && ! -L "$path" ]]; then
      case "$relative" in bin | nginx | systemd) ;; *) return 1 ;; esac
      [[ "$(stat_value '%u' '%u' "$path")" == "$expected_uid" && \
        "$(stat_value '%g' '%g' "$path")" == "$expected_gid" && \
        "$(stat_value '%a' '%Lp' "$path")" == 555 ]] || return 1
      continue
    fi
    [[ -f "$path" && ! -L "$path" ]] || return 1
    allowed=false
    while IFS= read -r expected; do
      if [[ "$relative" == "$expected" ]]; then allowed=true; break; fi
    done < <(legacy_admin_files)
    [[ "$allowed" == true ]] || return 1
    owner="$(stat_value '%u' '%u' "$path")" || return 1
    group="$(stat_value '%g' '%g' "$path")" || return 1
    mode="$(stat_value '%a' '%Lp' "$path")" || return 1
    links="$(stat_value '%h' '%l' "$path")" || return 1
    expected_mode=444
    [[ "$relative" == *.sh ]] && expected_mode=555
    [[ "$owner" == "$expected_uid" && "$group" == "$expected_gid" && \
      "$links" == 1 && \
      "$mode" == "$expected_mode" ]] || return 1
    count=$((count + 1))
  done < <(find "$root" -mindepth 1 -print0)
  [[ "$count" == 17 ]] || return 1
  while IFS= read -r relative; do
    [[ -f "$root/$relative" && ! -L "$root/$relative" ]] || return 1
  done < <(legacy_admin_files)
  actual_digest="$(canonical_root_tree_sha256_for "$root")" || return 1
  [[ "$actual_digest" == "$expected_digest" ]]
}

verify_legacy_runtime_contract() {
  local legacy_root=$1 mode relative destination label expected_uid expected_gid
  local owner group actual_mode links
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  while IFS='|' read -r mode relative destination label; do
    [[ -f "$destination" && ! -L "$destination" ]] || return 1
    owner="$(stat_value '%u' '%u' "$destination")" || return 1
    group="$(stat_value '%g' '%g' "$destination")" || return 1
    actual_mode="$(stat_value '%a' '%Lp' "$destination")" || return 1
    links="$(stat_value '%h' '%l' "$destination")" || return 1
    [[ "$owner" == "$expected_uid" && "$group" == "$expected_gid" && \
      "$actual_mode" == "${mode#0}" && \
      "$links" == 1 ]] || return 1
    /usr/bin/cmp -s "$destination" "$legacy_root/$relative" || return 1
  done < <(legacy_runtime_files)
}

verify_admin_kit() {
  local root=$1 name path stat_mode stat_uid stat_gid stat_links directory
  local expected_uid expected_gid
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  [[ -d "$root" && ! -L "$root" ]] || return 1
  stat_uid="$(stat_value '%u' '%u' "$root")"
  stat_gid="$(stat_value '%g' '%g' "$root")"
  stat_mode="$(stat_value '%a' '%Lp' "$root")"
  [[ "$stat_uid" == "$expected_uid" && "$stat_gid" == "$expected_gid" ]] ||
    return 1
  mode_is_safe "$stat_mode" || return 1
  while IFS= read -r name; do
    path="$root/$name"
    [[ -f "$path" && ! -L "$path" ]] || return 1
    directory="$(dirname -- "$path")"
    while [[ "$directory" != "$root" ]]; do
      [[ -d "$directory" && ! -L "$directory" ]] || return 1
      stat_uid="$(stat_value '%u' '%u' "$directory")"
      stat_gid="$(stat_value '%g' '%g' "$directory")"
      stat_mode="$(stat_value '%a' '%Lp' "$directory")"
      [[ "$stat_uid" == "$expected_uid" && "$stat_gid" == "$expected_gid" ]] ||
        return 1
      mode_is_safe "$stat_mode" || return 1
      directory="$(dirname -- "$directory")"
    done
    stat_uid="$(stat_value '%u' '%u' "$path")"
    stat_gid="$(stat_value '%g' '%g' "$path")"
    stat_mode="$(stat_value '%a' '%Lp' "$path")"
    stat_links="$(stat_value '%h' '%l' "$path")"
    [[ "$stat_uid" == "$expected_uid" && "$stat_gid" == "$expected_gid" && \
      "$stat_links" == 1 ]] || return 1
    mode_is_safe "$stat_mode" || return 1
  done < <(admin_files)
}

verify_admin_source() {
  local root=$1 relative path stat_mode stat_uid stat_links directory
  [[ -d "$root" && ! -L "$root" ]] || die 'admin source must be a real directory'
  if [[ -z "$TEST_ROOT" ]]; then
    directory="$root"
    while [[ "$directory" != / ]]; do
      [[ -d "$directory" && ! -L "$directory" ]] || die 'admin source path is not trusted'
      stat_uid="$(stat_value '%u' '%u' "$directory")"
      stat_mode="$(stat_value '%a' '%Lp' "$directory")"
      [[ "$stat_uid" == 0 ]] || die 'admin source must be rooted in root-owned directories'
      mode_is_safe "$stat_mode" ||
        die 'admin source directories must not be group/world writable'
      directory="$(dirname -- "$directory")"
    done
  fi
  while IFS= read -r relative; do
    path="$root/$relative"
    [[ -f "$path" && ! -L "$path" ]] || die 'admin source is incomplete'
    stat_links="$(stat_value '%h' '%l' "$path")"
    [[ "$stat_links" == 1 ]] || die 'admin source files must be single-link regular files'
    if [[ -z "$TEST_ROOT" ]]; then
      stat_uid="$(stat_value '%u' '%u' "$path")"
      stat_mode="$(stat_value '%a' '%Lp' "$path")"
      [[ "$stat_uid" == 0 ]] || die 'admin source files must be owned by root'
      mode_is_safe "$stat_mode" ||
        die 'admin source files must not be group/world writable'
    fi
  done < <(admin_files)
}

install_admin_kit() {
  if [[ -e "$ADMIN_ROOT" || -L "$ADMIN_ROOT" ]]; then
    verify_admin_kit "$ADMIN_ROOT" || die 'existing Hub admin kit is not trusted'
    return 0
  fi
  verify_admin_source "$DEPLOY_SOURCE_ROOT"
  local staging="$ADMIN_PARENT/.hub-admin-$$" relative mode destination
  [[ ! -e "$staging" && ! -L "$staging" ]] || die 'admin-kit staging path already exists'
  install_directory 0700 root root "$staging"
  while IFS= read -r relative; do
    mode=0444
    [[ "$relative" == *.sh || "$relative" == pre-upgrade-snapshot ]] && mode=0555
    destination="$staging/$relative"
    install_directory 0700 root root "$(dirname -- "$destination")"
    install_regular_file "$mode" root root "$DEPLOY_SOURCE_ROOT/$relative" "$destination"
  done < <(admin_files)
  if [[ -z "$TEST_ROOT" ]]; then chown -hR root:root "$staging"; fi
  find "$staging" -type d -exec chmod 0555 {} +
  mv "$staging" "$ADMIN_ROOT"
  verify_admin_kit "$ADMIN_ROOT" || die 'installed Hub admin kit failed verification'
}

replace_admin_kit_cold() {
  local expected_digest=$1 actual_digest actual_summary staging previous failed relative mode destination
  validate_checksum "$expected_digest"
  expected_digest="$(printf '%s' "$expected_digest" | tr 'A-F' 'a-f')"
  verify_admin_source "$DEPLOY_SOURCE_ROOT"
  previous="$ADMIN_PARENT/hub.previous-$expected_digest"
  if [[ ! -e "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" && \
    -d "$previous" && ! -L "$previous" ]]; then
    actual_summary="$("$NODE_BIN" "$DEPLOY_SOURCE_ROOT/bin/tree-digest.mjs" "$previous")" ||
      die 'interrupted cold replacement preserved kit cannot be fingerprinted'
    actual_digest="$(
      "$NODE_BIN" -e \
        'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
        "$actual_summary"
    )" || die 'interrupted cold replacement digest is invalid'
    [[ "$actual_digest" == "$expected_digest" ]] ||
      die 'interrupted cold replacement preserved kit does not match the pinned digest'
    mv "$previous" "$ADMIN_ROOT" ||
      die 'interrupted cold replacement could not restore the preserved kit'
    fsync_path "$ADMIN_PARENT"
  fi
  [[ -d "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" ]] ||
    die 'cold admin-kit replacement requires an existing real admin directory'
  for target in \
    "$ENV_FILE" \
    "$CURRENT_LINK" \
    "$PREVIOUS_LINK" \
    "$UNIT_PATH" \
    "$CANDIDATE_UNIT_PATH" \
    "$NGINX_EXAMPLE_PATH" \
    "$NGINX_LIMITS_EXAMPLE_PATH"; do
    [[ ! -e "$target" && ! -L "$target" ]] ||
      die 'cold admin-kit replacement refuses an installed runtime contract'
  done
  service_is_inactive || die 'cold admin-kit replacement requires an inactive Hub'
  service_is_disabled || die 'cold admin-kit replacement requires a disabled Hub'
  require_clean_maintenance_state
  actual_summary="$("$NODE_BIN" "$DEPLOY_SOURCE_ROOT/bin/tree-digest.mjs" "$ADMIN_ROOT")" ||
    die 'existing admin-kit tree cannot be fingerprinted'
  actual_digest="$(
    "$NODE_BIN" -e \
      'const v=JSON.parse(process.argv[1]); if(!(/^[a-f0-9]{64}$/u.test(v.treeSha256))) process.exit(1); process.stdout.write(v.treeSha256)' \
      "$actual_summary"
  )" || die 'existing admin-kit digest is invalid'
  [[ "$actual_digest" == "$expected_digest" ]] ||
    die 'existing admin-kit tree does not match the operator-pinned digest'

  staging="$ADMIN_PARENT/.hub-admin-replacement-$$-${RANDOM}"
  previous="$ADMIN_PARENT/hub.previous-$actual_digest"
  failed="$ADMIN_PARENT/hub.failed-replacement-$$-${RANDOM}"
  for target in "$staging" "$previous" "$failed"; do
    [[ ! -e "$target" && ! -L "$target" ]] ||
      die 'admin-kit replacement transaction path already exists'
  done
  install_directory 0700 root root "$staging"
  while IFS= read -r relative; do
    mode=0444
    [[ "$relative" == *.sh || "$relative" == pre-upgrade-snapshot ]] && mode=0555
    destination="$staging/$relative"
    install_directory 0700 root root "$(dirname -- "$destination")"
    install_regular_file "$mode" root root "$DEPLOY_SOURCE_ROOT/$relative" "$destination"
  done < <(admin_files)
  if [[ -z "$TEST_ROOT" ]]; then chown -hR root:root "$staging"; fi
  find "$staging" -type d -exec chmod 0555 {} +
  verify_admin_kit "$staging" || die 'replacement admin-kit staging failed verification'
  while IFS= read -r relative; do
    fsync_path "$staging/$relative"
  done < <(admin_files)
  while IFS= read -r destination; do
    fsync_path "$destination"
  done < <(find "$staging" -depth -type d -print)

  mv "$ADMIN_ROOT" "$previous" || die 'existing admin-kit could not be preserved'
  fsync_path "$ADMIN_PARENT"
  if ! mv "$staging" "$ADMIN_ROOT"; then
    mv "$previous" "$ADMIN_ROOT" ||
      die 'admin-kit replacement failed and the preserved kit could not be restored'
    fsync_path "$ADMIN_PARENT"
    die 'replacement admin-kit could not be activated'
  fi
  fsync_path "$ADMIN_PARENT"
  if ! verify_admin_kit "$ADMIN_ROOT"; then
    mv "$ADMIN_ROOT" "$failed" ||
      die 'invalid replacement admin-kit could not be isolated'
    if ! mv "$previous" "$ADMIN_ROOT"; then
      die 'invalid replacement admin-kit was isolated but the preserved kit could not be restored'
    fi
    fsync_path "$ADMIN_PARENT"
    die 'replacement admin-kit failed post-publish verification and was rolled back'
  fi
  notice admin_kit_replacement ok
}

ADMIN_MIGRATION_ACTIVE=false
ADMIN_MIGRATION_COMPLETE=false
ADMIN_MIGRATION_TRANSACTION=
ADMIN_MIGRATION_ROOT=
ADMIN_MIGRATION_ATTEMPT=
ADMIN_MIGRATION_ATTEMPT_TOKEN=
ADMIN_MIGRATION_FORMAT=
ADMIN_MIGRATION_EXPECTED_OLD=
ADMIN_MIGRATION_NEW_DIGEST=
ADMIN_MIGRATION_OLD_RUNTIME_DIGEST=
ADMIN_MIGRATION_NEW_RUNTIME_DIGEST=
ADMIN_MIGRATION_PREDECESSOR_TRANSACTION=none
ADMIN_MIGRATION_PREDECESSOR_TERMINAL=none
ADMIN_MIGRATION_PREDECESSOR_JOURNAL_SHA256=none
ADMIN_MIGRATION_STAGE=
ADMIN_MIGRATION_PREVIOUS=
ADMIN_MIGRATION_FAILED=
ADMIN_MIGRATION_FAILED_STAGE=
ADMIN_MIGRATION_LIVE_COPY_TEMP_PREFIX=
ADMIN_MIGRATION_STAGING_PUBLISHED=false
ADMIN_MIGRATION_JOURNAL_TEMP_COUNT=0
ADMIN_MIGRATION_SCAN_MAX_ATTEMPT=0
ADMIN_MIGRATION_SCAN_ROOTS=()
ADMIN_MIGRATION_SCAN_FORMATS=()
ADMIN_MIGRATION_SCAN_TRANSACTIONS=()
readonly ADMIN_MIGRATION_ATTEMPT_WIDTH=6
readonly ADMIN_MIGRATION_MAX_ATTEMPT=999999

admin_migration_attempt_token() {
  local attempt=$1
  [[ "$attempt" =~ ^[1-9][0-9]*$ ]] || return 1
  ((attempt <= ADMIN_MIGRATION_MAX_ATTEMPT)) || return 1
  printf '%0*d\n' "$ADMIN_MIGRATION_ATTEMPT_WIDTH" "$attempt"
}

set_admin_migration_attempt_paths() {
  local expected_digest=$1 attempt=$2 format=$3 short token
  validate_checksum "$expected_digest"
  expected_digest="$(printf '%s' "$expected_digest" | tr 'A-F' 'a-f')"
  [[ "$expected_digest" == "$LEGACY_ADMIN_PRODUCTION_SHA256" ]] ||
    die 'installed admin migration supports only the allowlisted legacy release'
  token="$(admin_migration_attempt_token "$attempt")" ||
    die 'admin migration attempt is invalid'
  short=${expected_digest:0:32}
  ADMIN_MIGRATION_EXPECTED_OLD=$expected_digest
  ADMIN_MIGRATION_ATTEMPT=$attempt
  ADMIN_MIGRATION_ATTEMPT_TOKEN=$token
  ADMIN_MIGRATION_FORMAT=$format
  case "$format" in
    legacy)
      [[ "$attempt" == 1 ]] || die 'legacy admin migration journal must be attempt one'
      ADMIN_MIGRATION_TRANSACTION="upgrade-admin-migration-$short"
      ADMIN_MIGRATION_STAGE="$ADMIN_PARENT/.hub-admin-migration-$short"
      ADMIN_MIGRATION_PREVIOUS="$ADMIN_PARENT/hub.legacy-$expected_digest"
      ADMIN_MIGRATION_FAILED="$ADMIN_PARENT/hub.failed-migration-$short"
      ADMIN_MIGRATION_FAILED_STAGE="$ADMIN_PARENT/hub.failed-migration-stage-$short"
      ADMIN_MIGRATION_LIVE_COPY_TEMP_PREFIX=".agent-os-admin-migration-$short"
      ;;
    attempt)
      ADMIN_MIGRATION_TRANSACTION="upgrade-admin-migration-$expected_digest-attempt-$token"
      ADMIN_MIGRATION_STAGE="$ADMIN_PARENT/.hub-admin-migration-$expected_digest-attempt-$token"
      ADMIN_MIGRATION_PREVIOUS="$ADMIN_PARENT/hub.legacy-$expected_digest-attempt-$token"
      ADMIN_MIGRATION_FAILED="$ADMIN_PARENT/hub.failed-migration-$expected_digest-attempt-$token"
      ADMIN_MIGRATION_FAILED_STAGE="$ADMIN_PARENT/hub.failed-migration-stage-$expected_digest-attempt-$token"
      ADMIN_MIGRATION_LIVE_COPY_TEMP_PREFIX=".agent-os-admin-migration-$expected_digest-attempt-$token"
      ;;
    *) die 'admin migration journal format is invalid' ;;
  esac
  ADMIN_MIGRATION_ROOT="$RECOVERY_ROOT/$ADMIN_MIGRATION_TRANSACTION"
}

initialize_admin_migration_paths() {
  local expected_digest=$1
  [[ -n "$ADMIN_MIGRATION_ATTEMPT" && -n "$ADMIN_MIGRATION_FORMAT" ]] ||
    die 'admin migration attempt has not been selected'
  set_admin_migration_attempt_paths \
    "$expected_digest" "$ADMIN_MIGRATION_ATTEMPT" "$ADMIN_MIGRATION_FORMAT"
}

parse_admin_migration_transaction() {
  local expected_digest=$1 transaction=$2 short token attempt
  expected_digest="$(printf '%s' "$expected_digest" | tr 'A-F' 'a-f')"
  short=${expected_digest:0:32}
  ADMIN_MIGRATION_PARSED_ATTEMPT=
  ADMIN_MIGRATION_PARSED_FORMAT=
  if [[ "$transaction" == "upgrade-admin-migration-$short" ]]; then
    ADMIN_MIGRATION_PARSED_ATTEMPT=1
    ADMIN_MIGRATION_PARSED_FORMAT=legacy
    return 0
  fi
  if [[ "$transaction" =~ ^upgrade-admin-migration-${expected_digest}-attempt-([0-9]{${ADMIN_MIGRATION_ATTEMPT_WIDTH}})$ ]]; then
    token=${BASH_REMATCH[1]}
    attempt=$((10#$token))
    ((attempt >= 1 && attempt <= ADMIN_MIGRATION_MAX_ATTEMPT)) || return 1
    [[ "$(admin_migration_attempt_token "$attempt")" == "$token" ]] || return 1
    ADMIN_MIGRATION_PARSED_ATTEMPT=$attempt
    ADMIN_MIGRATION_PARSED_FORMAT=attempt
    return 0
  fi
  return 1
}

admin_migration_phase_path() {
  printf '%s/%s\n' "$ADMIN_MIGRATION_ROOT" "$1"
}

admin_migration_entry_name_is_valid() {
  case "$1" in
    intent | metadata | disabled | blocked | stopped | prepared | runtime_activated | admin_activated | daemon_reloaded | started | verified | enabled | committed | rollback_started | rolled_back | finalized) return 0 ;;
    *) return 1 ;;
  esac
}

admin_migration_journal_temporary_name_is_valid() {
  [[ "$1" =~ ^\.(intent|metadata|disabled|blocked|stopped|prepared|runtime_activated|admin_activated|daemon_reloaded|started|verified|enabled|committed|rollback_started|rolled_back|finalized)-[0-9]+-[0-9]+\.tmp$ ]]
}

write_admin_migration_entry() {
  local name=$1 body=$2 destination temporary expected_uid expected_gid
  expected_uid="$(admin_contract_uid)" || die 'admin migration journal UID is unavailable'
  expected_gid="$(admin_contract_gid)" || die 'admin migration journal GID is unavailable'
  admin_migration_entry_name_is_valid "$name" ||
    die 'admin migration journal entry name is invalid'
  [[ -d "$ADMIN_MIGRATION_ROOT" && ! -L "$ADMIN_MIGRATION_ROOT" ]] ||
    die 'admin migration journal root is missing or unsafe'
  destination="$ADMIN_MIGRATION_ROOT/$name"
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" && \
      "$(stat_value '%u' '%u' "$destination")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$destination")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$destination")" == 400 && \
      "$(stat_value '%h' '%l' "$destination")" == 1 && \
      "$(<"$destination")" == "${body%$'\n'}" ]] ||
      die 'admin migration journal entry changed or is unsafe'
    # A prior process may have died after rename but before the journal
    # directory fsync. Re-establish both child and namespace durability before
    # treating an idempotently visible phase as committed.
    fsync_path "$destination"
    fsync_path "$ADMIN_MIGRATION_ROOT"
    return 0
  fi
  temporary="$ADMIN_MIGRATION_ROOT/.$name-$$-${RANDOM}.tmp"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'admin migration journal temporary already exists'
  umask 0377
  printf '%s' "$body" >"$temporary"
  chmod 0400 "$temporary"
  if [[ -z "$TEST_ROOT" ]]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv "$temporary" "$destination"
  fsync_path "$ADMIN_MIGRATION_ROOT"
}

record_admin_migration_phase() {
  local phase=$1 body
  printf -v body \
    'version=1\ntransaction=%s\nphase=%s\n' \
    "$ADMIN_MIGRATION_TRANSACTION" \
    "$phase"
  write_admin_migration_entry "$phase" "$body"
  notice "admin_migration_$phase" recorded
}

load_admin_migration_journal() {
  local expected_digest=$1 intent metadata key value body line line_number=0
  intent="$ADMIN_MIGRATION_ROOT/intent"
  [[ -d "$ADMIN_MIGRATION_ROOT" && ! -L "$ADMIN_MIGRATION_ROOT" && \
    -f "$intent" && ! -L "$intent" ]] || return 1
  ADMIN_MIGRATION_INTENT_VERSION=
  ADMIN_MIGRATION_INTENT_TRANSACTION=
  ADMIN_MIGRATION_INTENT_ATTEMPT=
  ADMIN_MIGRATION_INTENT_PREDECESSOR_TRANSACTION=
  ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL=
  ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256=
  ADMIN_MIGRATION_INTENT_OLD_DIGEST=
  body="$(<"$intent")"
  if [[ "$ADMIN_MIGRATION_FORMAT" == legacy ]]; then
    [[ "$body" == \
      $'version=1\n'"transaction=$ADMIN_MIGRATION_TRANSACTION"$'\n'"old_admin_sha256=$ADMIN_MIGRATION_EXPECTED_OLD" ]] || return 1
    ADMIN_MIGRATION_INTENT_VERSION=1
    ADMIN_MIGRATION_INTENT_TRANSACTION=$ADMIN_MIGRATION_TRANSACTION
    ADMIN_MIGRATION_INTENT_ATTEMPT=1
    ADMIN_MIGRATION_INTENT_PREDECESSOR_TRANSACTION=none
    ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL=none
    ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256=none
    ADMIN_MIGRATION_INTENT_OLD_DIGEST=$ADMIN_MIGRATION_EXPECTED_OLD
  else
    while IFS= read -r line || [[ -n "$line" ]]; do
      line_number=$((line_number + 1))
      key=${line%%=*}
      value=${line#*=}
      [[ "$line" == *=* && -n "$key" && -n "$value" ]] || return 1
      case "$line_number:$key" in
        1:version) ADMIN_MIGRATION_INTENT_VERSION=$value ;;
        2:transaction) ADMIN_MIGRATION_INTENT_TRANSACTION=$value ;;
        3:attempt) ADMIN_MIGRATION_INTENT_ATTEMPT=$value ;;
        4:predecessor_transaction) ADMIN_MIGRATION_INTENT_PREDECESSOR_TRANSACTION=$value ;;
        5:predecessor_terminal) ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL=$value ;;
        6:predecessor_journal_sha256) ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256=$value ;;
        7:old_admin_sha256) ADMIN_MIGRATION_INTENT_OLD_DIGEST=$value ;;
        *) return 1 ;;
      esac
    done <<<"$body"
    [[ "$line_number" == 7 && \
      "$ADMIN_MIGRATION_INTENT_VERSION" == 2 && \
      "$ADMIN_MIGRATION_INTENT_TRANSACTION" == "$ADMIN_MIGRATION_TRANSACTION" && \
      "$ADMIN_MIGRATION_INTENT_ATTEMPT" == "$ADMIN_MIGRATION_ATTEMPT_TOKEN" && \
      "$ADMIN_MIGRATION_INTENT_OLD_DIGEST" == "$ADMIN_MIGRATION_EXPECTED_OLD" && \
      ("$ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL" == none || \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL" == rolled_back) && \
      ("$ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256" == none || \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256" =~ ^[a-f0-9]{64}$) ]] || return 1
  fi
  ADMIN_MIGRATION_PREDECESSOR_TRANSACTION=$ADMIN_MIGRATION_INTENT_PREDECESSOR_TRANSACTION
  ADMIN_MIGRATION_PREDECESSOR_TERMINAL=$ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL
  ADMIN_MIGRATION_PREDECESSOR_JOURNAL_SHA256=$ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256
  metadata="$ADMIN_MIGRATION_ROOT/metadata"
  ADMIN_MIGRATION_NEW_DIGEST=
  ADMIN_MIGRATION_OLD_RUNTIME_DIGEST=
  ADMIN_MIGRATION_NEW_RUNTIME_DIGEST=
  local metadata_version= metadata_transaction=
  if [[ -e "$metadata" || -L "$metadata" ]]; then
    [[ -f "$metadata" && ! -L "$metadata" ]] || return 1
    while IFS='=' read -r key value; do
      case "$key" in
        version) [[ -z "$metadata_version" && "$value" == 1 ]] || return 1; metadata_version=$value ;;
        transaction) [[ -z "$metadata_transaction" && "$value" == "$ADMIN_MIGRATION_TRANSACTION" ]] || return 1; metadata_transaction=$value ;;
        new_admin_sha256) [[ -z "$ADMIN_MIGRATION_NEW_DIGEST" && "$value" =~ ^[a-f0-9]{64}$ ]] || return 1; ADMIN_MIGRATION_NEW_DIGEST=$value ;;
        old_runtime_sha256) [[ -z "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" && "$value" =~ ^[a-f0-9]{64}$ ]] || return 1; ADMIN_MIGRATION_OLD_RUNTIME_DIGEST=$value ;;
        new_runtime_sha256) [[ -z "$ADMIN_MIGRATION_NEW_RUNTIME_DIGEST" && "$value" =~ ^[a-f0-9]{64}$ ]] || return 1; ADMIN_MIGRATION_NEW_RUNTIME_DIGEST=$value ;;
        *) return 1 ;;
      esac
    done <"$metadata"
    [[ "$metadata_version" == 1 && \
      "$metadata_transaction" == "$ADMIN_MIGRATION_TRANSACTION" && \
      -n "$ADMIN_MIGRATION_NEW_DIGEST" && \
      -n "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" && \
      -n "$ADMIN_MIGRATION_NEW_RUNTIME_DIGEST" && \
      "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" == \
        "$LEGACY_RUNTIME_PRODUCTION_SHA256" ]] || return 1
  fi
}

validate_admin_migration_journal() {
  local expected_digest=$1 allow_temporaries=${2:-false}
  local entry name expected_uid expected_gid
  local gap=false phase
  local -a entries=()
  local -a phases=(disabled blocked stopped prepared runtime_activated admin_activated daemon_reloaded started verified enabled committed finalized)
  local -a rollback_prefix=(disabled blocked stopped prepared runtime_activated admin_activated daemon_reloaded started verified enabled)
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  load_admin_migration_journal "$expected_digest" || return 1
  [[ "$(stat_value '%u' '%u' "$ADMIN_MIGRATION_ROOT")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$ADMIN_MIGRATION_ROOT")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$ADMIN_MIGRATION_ROOT")" == 700 ]] || return 1
  ADMIN_MIGRATION_JOURNAL_TEMP_COUNT=0
  shopt -s nullglob dotglob
  entries=("$ADMIN_MIGRATION_ROOT"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    name=${entry##*/}
    if admin_migration_journal_temporary_name_is_valid "$name"; then
      [[ "$allow_temporaries" == true ]] || return 1
      [[ -f "$entry" && ! -L "$entry" && \
        "$(stat_value '%u' '%u' "$entry")" == "$expected_uid" && \
        "$(stat_value '%g' '%g' "$entry")" == "$expected_gid" && \
        "$(stat_value '%a' '%Lp' "$entry")" == 400 && \
        "$(stat_value '%h' '%l' "$entry")" == 1 ]] || return 1
      ADMIN_MIGRATION_JOURNAL_TEMP_COUNT=$((ADMIN_MIGRATION_JOURNAL_TEMP_COUNT + 1))
      continue
    fi
    case "$name" in
      intent | metadata | old-runtime | new-runtime | disabled | blocked | stopped | prepared | runtime_activated | admin_activated | daemon_reloaded | started | verified | enabled | committed | rollback_started | rolled_back | finalized) ;;
      *) return 1 ;;
    esac
    if [[ "$name" == old-runtime || "$name" == new-runtime ]]; then
      [[ -d "$entry" && ! -L "$entry" ]] || return 1
      continue
    fi
    [[ -f "$entry" && ! -L "$entry" && \
      "$(stat_value '%u' '%u' "$entry")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$entry")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$entry")" == 400 && \
      "$(stat_value '%h' '%l' "$entry")" == 1 ]] || return 1
    if [[ "$name" != intent && "$name" != metadata ]]; then
      [[ "$(<"$entry")" == \
        $'version=1\n'"transaction=$ADMIN_MIGRATION_TRANSACTION"$'\n'"phase=$name" ]] || return 1
    fi
  done
  if [[ -e "$ADMIN_MIGRATION_ROOT/finalized" && \
    "$ADMIN_MIGRATION_JOURNAL_TEMP_COUNT" != 0 ]]; then
    return 1
  fi
  [[ ! -e "$ADMIN_MIGRATION_ROOT/committed" || ! -e "$ADMIN_MIGRATION_ROOT/rolled_back" ]] || return 1
  if [[ -e "$ADMIN_MIGRATION_ROOT/prepared" ]]; then
    [[ -n "$ADMIN_MIGRATION_NEW_DIGEST" && \
      -n "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" && \
      -n "$ADMIN_MIGRATION_NEW_RUNTIME_DIGEST" ]] || return 1
  fi
  if [[ -e "$ADMIN_MIGRATION_ROOT/rollback_started" ]]; then
    [[ ! -e "$ADMIN_MIGRATION_ROOT/committed" && \
      -e "$ADMIN_MIGRATION_ROOT/blocked" && \
      -e "$ADMIN_MIGRATION_ROOT/stopped" ]] || return 1
    gap=false
    for phase in "${rollback_prefix[@]}"; do
      if [[ -e "$ADMIN_MIGRATION_ROOT/$phase" ]]; then
        [[ "$gap" == false ]] || return 1
      else
        gap=true
      fi
    done
    [[ ! -e "$ADMIN_MIGRATION_ROOT/finalized" || \
      -e "$ADMIN_MIGRATION_ROOT/rolled_back" ]] || return 1
  elif [[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" ]]; then
    return 1
  else
    for phase in "${phases[@]}"; do
      if [[ -e "$ADMIN_MIGRATION_ROOT/$phase" ]]; then
        [[ "$gap" == false ]] || return 1
      else
        gap=true
      fi
    done
  fi
}

cleanup_admin_migration_journal_temporaries() {
  local expected_digest=$1 entry name removed=false
  local -a entries=()
  validate_admin_migration_journal "$expected_digest" true ||
    die 'admin migration journal is invalid before temporary cleanup'
  if [[ "$ADMIN_MIGRATION_JOURNAL_TEMP_COUNT" != 0 ]]; then
    [[ ! -e "$ADMIN_MIGRATION_ROOT/finalized" ]] ||
      die 'finalized admin migration history is immutable'
    shopt -s nullglob dotglob
    entries=("$ADMIN_MIGRATION_ROOT"/.*.tmp)
    shopt -u nullglob dotglob
    for entry in "${entries[@]}"; do
      name=${entry##*/}
      admin_migration_journal_temporary_name_is_valid "$name" ||
        die 'admin migration journal contains an unrecognized temporary'
      rm -f -- "$entry" || die 'admin migration journal temporary cleanup failed'
      removed=true
    done
    if [[ "$removed" == true ]]; then fsync_path "$ADMIN_MIGRATION_ROOT"; fi
  fi
  validate_admin_migration_journal "$expected_digest" false ||
    die 'admin migration journal changed during temporary cleanup'
  shopt -s nullglob dotglob
  entries=("$ADMIN_MIGRATION_ROOT"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    fsync_path "$entry"
  done
  fsync_path "$ADMIN_MIGRATION_ROOT"
}

scan_admin_migration_attempts() {
  local expected_digest=$1 allow_latest_temporaries=${2:-false}
  local migration name attempt format index allow_temporaries=false
  local previous_transaction=none previous_terminal=none previous_digest=none
  local -a migrations=()
  validate_checksum "$expected_digest"
  expected_digest="$(printf '%s' "$expected_digest" | tr 'A-F' 'a-f')"
  [[ "$expected_digest" == "$LEGACY_ADMIN_PRODUCTION_SHA256" ]] ||
    die 'admin migration history uses an unsupported legacy digest'
  ADMIN_MIGRATION_SCAN_MAX_ATTEMPT=0
  ADMIN_MIGRATION_SCAN_ROOTS=()
  ADMIN_MIGRATION_SCAN_FORMATS=()
  ADMIN_MIGRATION_SCAN_TRANSACTIONS=()
  [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]] || return 0
  shopt -s nullglob
  migrations=("$RECOVERY_ROOT"/upgrade-admin-migration-*)
  shopt -u nullglob
  for migration in "${migrations[@]+"${migrations[@]}"}"; do
    name=${migration##*/}
    parse_admin_migration_transaction "$expected_digest" "$name" ||
      die 'admin migration history contains an unknown transaction name'
    attempt=$ADMIN_MIGRATION_PARSED_ATTEMPT
    format=$ADMIN_MIGRATION_PARSED_FORMAT
    [[ -d "$migration" && ! -L "$migration" ]] ||
      die 'admin migration history root is unsafe'
    [[ -z "${ADMIN_MIGRATION_SCAN_ROOTS[$attempt]+present}" ]] ||
      die 'admin migration history contains duplicate attempt numbers'
    ADMIN_MIGRATION_SCAN_ROOTS[$attempt]=$migration
    ADMIN_MIGRATION_SCAN_FORMATS[$attempt]=$format
    ADMIN_MIGRATION_SCAN_TRANSACTIONS[$attempt]=$name
    if ((attempt > ADMIN_MIGRATION_SCAN_MAX_ATTEMPT)); then
      ADMIN_MIGRATION_SCAN_MAX_ATTEMPT=$attempt
    fi
  done
  if ((ADMIN_MIGRATION_SCAN_MAX_ATTEMPT > 0)) && \
    ((${#ADMIN_MIGRATION_SCAN_ROOTS[@]} != ADMIN_MIGRATION_SCAN_MAX_ATTEMPT)); then
    die 'admin migration history contains an attempt gap'
  fi
  for ((index = 1; index <= ADMIN_MIGRATION_SCAN_MAX_ATTEMPT; index += 1)); do
    [[ -n "${ADMIN_MIGRATION_SCAN_ROOTS[$index]+present}" ]] ||
      die 'admin migration history contains an attempt gap'
    set_admin_migration_attempt_paths \
      "$expected_digest" "$index" "${ADMIN_MIGRATION_SCAN_FORMATS[$index]}"
    [[ "$ADMIN_MIGRATION_ROOT" == "${ADMIN_MIGRATION_SCAN_ROOTS[$index]}" ]] ||
      die 'admin migration history path does not match its attempt identity'
    allow_temporaries=false
    if [[ "$allow_latest_temporaries" == true && \
      "$index" == "$ADMIN_MIGRATION_SCAN_MAX_ATTEMPT" ]]; then
      allow_temporaries=true
    fi
    validate_admin_migration_journal "$expected_digest" "$allow_temporaries" ||
      die 'admin migration history journal is invalid'
    if ((index == 1)); then
      [[ "$ADMIN_MIGRATION_INTENT_PREDECESSOR_TRANSACTION" == none && \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL" == none && \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256" == none ]] ||
        die 'first admin migration attempt has an invalid predecessor binding'
    else
      [[ "$ADMIN_MIGRATION_FORMAT" == attempt && \
        "$ADMIN_MIGRATION_INTENT_VERSION" == 2 && \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_TRANSACTION" == \
          "$previous_transaction" && \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_TERMINAL" == \
          "$previous_terminal" && \
        "$ADMIN_MIGRATION_INTENT_PREDECESSOR_JOURNAL_SHA256" == \
          "$previous_digest" ]] ||
        die 'admin migration attempt predecessor binding is invalid'
    fi
    if ((index < ADMIN_MIGRATION_SCAN_MAX_ATTEMPT)); then
      [[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" && \
        -e "$ADMIN_MIGRATION_ROOT/finalized" && \
        ! -e "$ADMIN_MIGRATION_ROOT/committed" && \
        "$ADMIN_MIGRATION_JOURNAL_TEMP_COUNT" == 0 ]] ||
        die 'only a finalized rolled-back attempt may precede another attempt'
      validate_finalized_admin_migration_forensic_artifact ||
        die 'historical admin migration forensic artifact changed'
      previous_transaction=$ADMIN_MIGRATION_TRANSACTION
      previous_terminal=rolled_back
      previous_digest="$(canonical_root_tree_sha256_for "$ADMIN_MIGRATION_ROOT")" ||
        die 'historical admin migration journal cannot be fingerprinted'
    elif [[ -e "$ADMIN_MIGRATION_ROOT/finalized" ]]; then
      validate_finalized_admin_migration_forensic_artifact ||
        die 'finalized admin migration forensic artifact changed'
    fi
  done
  if ((ADMIN_MIGRATION_SCAN_MAX_ATTEMPT > 0)); then
    index=$ADMIN_MIGRATION_SCAN_MAX_ATTEMPT
    set_admin_migration_attempt_paths \
      "$expected_digest" "$index" "${ADMIN_MIGRATION_SCAN_FORMATS[$index]}"
    allow_temporaries=false
    [[ "$allow_latest_temporaries" == true ]] && allow_temporaries=true
    validate_admin_migration_journal "$expected_digest" "$allow_temporaries" ||
      die 'latest admin migration journal changed during history scan'
  else
    ADMIN_MIGRATION_ATTEMPT=
    ADMIN_MIGRATION_ATTEMPT_TOKEN=
    ADMIN_MIGRATION_FORMAT=
    ADMIN_MIGRATION_TRANSACTION=
    ADMIN_MIGRATION_ROOT=
  fi
}

admin_migration_intent_body() {
  local output_name=$1
  if [[ "$ADMIN_MIGRATION_FORMAT" == legacy ]]; then
    printf -v "$output_name" \
      'version=1\ntransaction=%s\nold_admin_sha256=%s\n' \
      "$ADMIN_MIGRATION_TRANSACTION" \
      "$ADMIN_MIGRATION_EXPECTED_OLD"
    return 0
  fi
  [[ "$ADMIN_MIGRATION_FORMAT" == attempt && \
    -n "$ADMIN_MIGRATION_ATTEMPT_TOKEN" ]] || return 1
  printf -v "$output_name" \
    'version=2\ntransaction=%s\nattempt=%s\npredecessor_transaction=%s\npredecessor_terminal=%s\npredecessor_journal_sha256=%s\nold_admin_sha256=%s\n' \
    "$ADMIN_MIGRATION_TRANSACTION" \
    "$ADMIN_MIGRATION_ATTEMPT_TOKEN" \
    "$ADMIN_MIGRATION_PREDECESSOR_TRANSACTION" \
    "$ADMIN_MIGRATION_PREDECESSOR_TERMINAL" \
    "$ADMIN_MIGRATION_PREDECESSOR_JOURNAL_SHA256" \
    "$ADMIN_MIGRATION_EXPECTED_OLD"
}

select_admin_migration_attempt() {
  local expected_digest=$1 action=$2 latest next predecessor_digest short
  local -a legacy_staging_roots=()
  [[ "$action" == forward || "$action" == rollback ]] ||
    die 'admin migration action is invalid'
  scan_admin_migration_attempts "$expected_digest" true
  latest=$ADMIN_MIGRATION_SCAN_MAX_ATTEMPT
  if ((latest == 0)); then
    [[ "$action" == forward ]] ||
      die 'admin migration rollback requires an existing migration journal'
    ADMIN_MIGRATION_PREDECESSOR_TRANSACTION=none
    ADMIN_MIGRATION_PREDECESSOR_TERMINAL=none
    ADMIN_MIGRATION_PREDECESSOR_JOURNAL_SHA256=none
    short=${expected_digest:0:32}
    if [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]]; then
      shopt -s nullglob
      legacy_staging_roots=(
        "$RECOVERY_ROOT"/.upgrade-admin-migration-"$short"-*.tmp
      )
      shopt -u nullglob
    fi
    if ((${#legacy_staging_roots[@]} > 0)); then
      # A previously published v1 bootstrap may have died before moving its
      # intent staging directory to the fixed final root. Select that exact
      # transaction so locked recovery can validate/adopt it; a concurrent v2
      # staging root is rejected by the selected-staging exclusivity check.
      set_admin_migration_attempt_paths "$expected_digest" 1 legacy
    else
      set_admin_migration_attempt_paths "$expected_digest" 1 attempt
    fi
    return 0
  fi

  set_admin_migration_attempt_paths \
    "$expected_digest" "$latest" "${ADMIN_MIGRATION_SCAN_FORMATS[$latest]}"
  validate_admin_migration_journal "$expected_digest" true ||
    die 'latest admin migration journal is invalid'
  if [[ ! -e "$ADMIN_MIGRATION_ROOT/finalized" ]]; then
    if [[ "$action" == rollback && -e "$ADMIN_MIGRATION_ROOT/committed" ]]; then
      die 'a committed admin migration can only be finalized forward'
    fi
    if [[ "$action" == forward && \
      (-e "$ADMIN_MIGRATION_ROOT/rollback_started" || \
        -e "$ADMIN_MIGRATION_ROOT/rolled_back") ]]; then
      die 'a rolled-back admin migration can only be finalized as rollback'
    fi
    return 0
  fi

  # A prior process may have died after publishing the terminal phase but
  # before fsyncing this attempt directory. Re-establish the predecessor
  # journal boundary before accepting it as terminal or binding N+1 to it.
  cleanup_admin_migration_journal_temporaries "$expected_digest"
  validate_admin_migration_journal "$expected_digest" false ||
    die 'finalized admin migration journal changed during recovery'

  if [[ -e "$ADMIN_MIGRATION_ROOT/committed" ]]; then
    [[ "$action" == forward ]] ||
      die 'a committed admin migration can only be finalized forward'
    return 0
  fi
  [[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" ]] ||
    die 'finalized admin migration has no terminal outcome'
  if [[ "$action" == rollback ]]; then return 0; fi
  ((latest < ADMIN_MIGRATION_MAX_ATTEMPT)) ||
    die 'admin migration attempt limit is exhausted'
  finalized_admin_migration_is_healthy "$expected_digest" ||
    die 'rolled-back admin migration no longer matches its terminal state'
  validate_finalized_admin_migration_forensic_artifact ||
    die 'rolled-back admin migration history changed before a new attempt'
  predecessor_digest="$(canonical_root_tree_sha256_for "$ADMIN_MIGRATION_ROOT")" ||
    die 'rolled-back admin migration journal cannot be fingerprinted'
  ADMIN_MIGRATION_PREDECESSOR_TRANSACTION=$ADMIN_MIGRATION_TRANSACTION
  ADMIN_MIGRATION_PREDECESSOR_TERMINAL=rolled_back
  ADMIN_MIGRATION_PREDECESSOR_JOURNAL_SHA256=$predecessor_digest
  next=$((latest + 1))
  set_admin_migration_attempt_paths "$expected_digest" "$next" attempt
}

validate_admin_migration_intent_staging_dir() {
  local staging=$1 expected_uid expected_gid entry name body entry_count=0
  local -a entries=()
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  name=${staging##*/}
  [[ "$name" =~ ^\.${ADMIN_MIGRATION_TRANSACTION}-[0-9]+-[0-9]+\.tmp$ && \
    -d "$staging" && ! -L "$staging" && \
    "$(stat_value '%u' '%u' "$staging")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$staging")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$staging")" == 700 ]] || return 1
  ADMIN_MIGRATION_STAGING_PUBLISHED=false
  shopt -s nullglob dotglob
  entries=("$staging"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    entry_count=$((entry_count + 1))
    ((entry_count <= 1)) || return 1
    name=${entry##*/}
    [[ "$name" == intent || \
      "$name" =~ ^\.intent-[0-9]+-[0-9]+\.tmp$ ]] || return 1
    [[ -f "$entry" && ! -L "$entry" && \
      "$(stat_value '%u' '%u' "$entry")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$entry")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$entry")" == 400 && \
      "$(stat_value '%h' '%l' "$entry")" == 1 ]] || return 1
    if [[ "$name" == intent ]]; then
      admin_migration_intent_body body || return 1
      [[ "$(<"$entry")" == "${body%$'\n'}" ]] || return 1
      ADMIN_MIGRATION_STAGING_PUBLISHED=true
    fi
  done
}

inspect_admin_migration_intent_staging() {
  local expected_digest=$1 staging published_count=0
  local -a staging_roots=()
  initialize_admin_migration_paths "$expected_digest"
  [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]] || return 0
  shopt -s nullglob
  staging_roots=("$RECOVERY_ROOT"/."$ADMIN_MIGRATION_TRANSACTION"-*.tmp)
  shopt -u nullglob
  for staging in "${staging_roots[@]+"${staging_roots[@]}"}"; do
    validate_admin_migration_intent_staging_dir "$staging" ||
      die 'admin migration intent staging directory is invalid'
    if [[ "$ADMIN_MIGRATION_STAGING_PUBLISHED" == true ]]; then
      published_count=$((published_count + 1))
    fi
  done
  ((published_count <= 1)) ||
    die 'admin migration has multiple published intent staging directories'
}

require_only_selected_admin_migration_intent_staging() {
  local staging
  local -a staging_roots=()
  [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]] || return 0
  shopt -s nullglob
  staging_roots=("$RECOVERY_ROOT"/.upgrade-admin-migration-*.tmp)
  shopt -u nullglob
  for staging in "${staging_roots[@]+"${staging_roots[@]}"}"; do
    [[ "${staging##*/}" =~ \
      ^\.${ADMIN_MIGRATION_TRANSACTION}-[0-9]+-[0-9]+\.tmp$ ]] ||
      die 'another admin migration intent staging directory requires explicit recovery'
    validate_admin_migration_intent_staging_dir "$staging" ||
      die 'admin migration intent staging directory is invalid'
  done
}

remove_admin_migration_intent_staging_dir() {
  local staging=$1 entry
  local -a entries=()
  validate_admin_migration_intent_staging_dir "$staging" ||
    die 'admin migration intent staging changed before cleanup'
  shopt -s nullglob dotglob
  entries=("$staging"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    rm -f -- "$entry" || die 'admin migration intent staging file cleanup failed'
  done
  rmdir -- "$staging" || die 'admin migration intent staging directory cleanup failed'
  fsync_path "$RECOVERY_ROOT"
}

recover_admin_migration_temporaries() {
  local expected_digest=$1 action=$2 staging adopted=false final_root
  local -a staging_roots=()
  verify_admin_migration_carrier_contract ||
    die 'admin migration carrier directories are unsafe before journal recovery'
  select_admin_migration_attempt "$expected_digest" "$action"
  require_only_selected_admin_migration_intent_staging
  inspect_admin_migration_intent_staging "$expected_digest"
  final_root=$ADMIN_MIGRATION_ROOT
  shopt -s nullglob
  staging_roots=("$RECOVERY_ROOT"/."$ADMIN_MIGRATION_TRANSACTION"-*.tmp)
  shopt -u nullglob
  if [[ ! -e "$final_root" && ! -L "$final_root" ]]; then
    for staging in "${staging_roots[@]+"${staging_roots[@]}"}"; do
      validate_admin_migration_intent_staging_dir "$staging" ||
        die 'admin migration intent staging changed before adoption'
      if [[ "$ADMIN_MIGRATION_STAGING_PUBLISHED" == true ]]; then
        fsync_path "$staging/intent"
        fsync_path "$staging"
        mv "$staging" "$final_root" ||
          die 'admin migration published intent staging could not be adopted'
        fsync_path "$RECOVERY_ROOT"
        adopted=true
        break
      fi
    done
  fi
  for staging in "${staging_roots[@]+"${staging_roots[@]}"}"; do
    [[ -e "$staging" || -L "$staging" ]] || continue
    remove_admin_migration_intent_staging_dir "$staging"
  done
  ADMIN_MIGRATION_ROOT=$final_root
  if [[ -e "$ADMIN_MIGRATION_ROOT" || -L "$ADMIN_MIGRATION_ROOT" ]]; then
    # A prior process may have died after publishing the final journal root but
    # before fsyncing its parent namespace. Re-establish that rename boundary
    # before accepting any visible journal as durable.
    fsync_path "$RECOVERY_ROOT"
    validate_admin_migration_journal "$expected_digest" true ||
      die 'admin migration journal is invalid after intent recovery'
    cleanup_admin_migration_journal_temporaries "$expected_digest"
  elif [[ "$adopted" == true ]]; then
    die 'adopted admin migration intent disappeared'
  fi
  select_admin_migration_attempt "$expected_digest" "$action"
}

create_admin_migration_intent() {
  local expected_digest=$1 temporary body
  initialize_admin_migration_paths "$expected_digest"
  [[ ! -e "$ADMIN_MIGRATION_ROOT" && ! -L "$ADMIN_MIGRATION_ROOT" ]] ||
    die 'admin migration journal already exists'
  temporary="$RECOVERY_ROOT/.${ADMIN_MIGRATION_TRANSACTION}-$$-${RANDOM}.tmp"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'admin migration intent staging path already exists'
  install_directory 0700 root root "$temporary"
  ADMIN_MIGRATION_ROOT=$temporary
  admin_migration_intent_body body ||
    die 'admin migration intent body is invalid'
  write_admin_migration_entry intent "$body"
  fsync_path "$temporary"
  mv "$temporary" "$RECOVERY_ROOT/$ADMIN_MIGRATION_TRANSACTION"
  ADMIN_MIGRATION_ROOT="$RECOVERY_ROOT/$ADMIN_MIGRATION_TRANSACTION"
  fsync_path "$RECOVERY_ROOT"
}

ensure_admin_migration_intent_layout() {
  # A 658cd6c installation predates the durable operations namespace. Create
  # only the root-owned audit/journal parents needed for the pure intent; do
  # not run the general layout installer, which would touch state, runtime,
  # release or admin metadata before the migration is durably explained.
  local mode path expected_uid expected_gid canonical
  expected_uid="$(admin_contract_uid)" ||
    die 'admin migration intent layout UID is unavailable'
  expected_gid="$(admin_contract_gid)" ||
    die 'admin migration intent layout GID is unavailable'
  while IFS=' ' read -r mode path; do
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -d "$path" && ! -L "$path" && \
        "$(stat_value '%u' '%u' "$path")" == "$expected_uid" && \
        "$(stat_value '%g' '%g' "$path")" == "$expected_gid" && \
        "$(stat_value '%a' '%Lp' "$path")" == "$mode" ]] ||
        die 'admin migration intent layout is unsafe'
      canonical="$(CDPATH= cd -P -- "$path" 2>/dev/null && pwd -P)" ||
        die 'admin migration intent layout cannot be canonicalized'
      [[ "$canonical" == "$path" ]] ||
        die 'admin migration intent layout contains a symbolic ancestor'
      fsync_path "$path"
    else
      install_durable_directory "0$mode" root root "$path"
    fi
  done <<EOF
755 $OPS_ROOT
700 $RECOVERY_ROOT
EOF
}

copy_admin_migration_temporary() {
  local source=$1 temporary=$2 mode=$3
  [[ -f "$source" && ! -L "$source" && \
    ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'admin migration copy endpoints are unsafe'
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [source, target, rawMode] = process.argv.slice(1);
    const mode = Number.parseInt(rawMode, 8);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) process.exit(2);
    const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let targetFd;
    try {
      const before = fs.fstatSync(sourceFd, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error("unsafe_source");
      }
      process.umask(0);
      targetFd = fs.openSync(
        target,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        mode,
      );
      fs.fchmodSync(targetFd, mode);
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (true) {
        const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        let written = 0;
        while (written < count) {
          const length = fs.writeSync(
            targetFd,
            buffer,
            written,
            count - written,
            offset + written,
          );
          if (length === 0) throw new Error("short_write");
          written += length;
        }
        offset += count;
      }
      const after = fs.fstatSync(sourceFd, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(offset) !== before.size
      ) {
        throw new Error("source_changed");
      }
      fs.fsyncSync(targetFd);
    } finally {
      if (targetFd !== undefined) fs.closeSync(targetFd);
      fs.closeSync(sourceFd);
    }
  ' "$source" "$temporary" "$mode" ||
    die 'admin migration temporary copy failed'
}

install_admin_migration_file_atomically() {
  local source=$1 destination=$2 mode=$3 temporary=$4
  local expected_uid expected_gid parent owner group links actual_mode
  expected_uid="$(admin_contract_uid)" || die 'admin migration file UID is unavailable'
  expected_gid="$(admin_contract_gid)" || die 'admin migration file GID is unavailable'
  parent="$(dirname -- "$destination")"
  [[ -d "$parent" && ! -L "$parent" && \
    "$temporary" == "$parent"/* && "$temporary" != "$destination" ]] ||
    die 'admin migration file staging path is invalid'
  if [[ -e "$temporary" || -L "$temporary" ]]; then
    [[ -f "$temporary" && ! -L "$temporary" ]] ||
      die 'admin migration file temporary is unsafe'
    owner="$(stat_value '%u' '%u' "$temporary")" ||
      die 'admin migration file temporary owner is unavailable'
    group="$(stat_value '%g' '%g' "$temporary")" ||
      die 'admin migration file temporary group is unavailable'
    actual_mode="$(stat_value '%a' '%Lp' "$temporary")" ||
      die 'admin migration file temporary mode is unavailable'
    links="$(stat_value '%h' '%l' "$temporary")" ||
      die 'admin migration file temporary link count is unavailable'
    [[ "$owner" == "$expected_uid" && "$group" == "$expected_gid" && \
      "$actual_mode" == "${mode#0}" && \
      "$links" == 1 ]] || die 'admin migration file temporary is unsafe'
    rm -f -- "$temporary" || die 'admin migration stale file temporary cleanup failed'
    fsync_path "$parent"
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" ]] ||
      die 'admin migration file destination is unsafe'
    owner="$(stat_value '%u' '%u' "$destination")" ||
      die 'admin migration file destination owner is unavailable'
    group="$(stat_value '%g' '%g' "$destination")" ||
      die 'admin migration file destination group is unavailable'
    links="$(stat_value '%h' '%l' "$destination")" ||
      die 'admin migration file destination link count is unavailable'
    [[ "$owner" == "$expected_uid" && "$group" == "$expected_gid" && \
      "$links" == 1 ]] ||
      die 'admin migration file destination is unsafe'
    actual_mode="$(stat_value '%a' '%Lp' "$destination")" ||
      die 'admin migration file destination mode is unavailable'
    if [[ "$actual_mode" == "${mode#0}" ]] && \
      /usr/bin/cmp -s "$destination" "$source"; then
      fsync_path "$parent"
      return 0
    fi
  fi
  copy_admin_migration_temporary "$source" "$temporary" "$mode"
  fsync_path "$temporary"
  mv "$temporary" "$destination" || die 'admin migration file publication failed'
  fsync_path "$parent"
  [[ -f "$destination" && ! -L "$destination" && \
    "$(stat_value '%u' '%u' "$destination")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$destination")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$destination")" == "${mode#0}" && \
    "$(stat_value '%h' '%l' "$destination")" == 1 ]] && \
    /usr/bin/cmp -s "$destination" "$source" ||
    die 'admin migration published file failed verification'
}

verify_exact_admin_migration_kit() {
  local root=$1 path relative expected allowed=false count=0 expected_uid
  local expected_gid owner group mode links expected_mode
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  verify_admin_kit "$root" || return 1
  [[ "$(stat_value '%u' '%u' "$root")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$root")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$root")" == 555 ]] || return 1
  while IFS= read -r -d '' path; do
    relative=${path#"$root"/}
    if [[ -d "$path" && ! -L "$path" ]]; then
      case "$relative" in bin | nginx | systemd) ;; *) return 1 ;; esac
      [[ "$(stat_value '%u' '%u' "$path")" == "$expected_uid" && \
        "$(stat_value '%g' '%g' "$path")" == "$expected_gid" && \
        "$(stat_value '%a' '%Lp' "$path")" == 555 ]] || return 1
      continue
    fi
    [[ -f "$path" && ! -L "$path" ]] || return 1
    allowed=false
    while IFS= read -r expected; do
      if [[ "$relative" == "$expected" ]]; then allowed=true; break; fi
    done < <(admin_files)
    [[ "$allowed" == true ]] || return 1
    expected_mode=444
    [[ "$relative" == *.sh || "$relative" == pre-upgrade-snapshot ]] && expected_mode=555
    owner="$(stat_value '%u' '%u' "$path")" || return 1
    group="$(stat_value '%g' '%g' "$path")" || return 1
    mode="$(stat_value '%a' '%Lp' "$path")" || return 1
    links="$(stat_value '%h' '%l' "$path")" || return 1
    [[ "$owner" == "$expected_uid" && "$group" == "$expected_gid" && \
      "$mode" == "$expected_mode" && \
      "$links" == 1 ]] || return 1
    count=$((count + 1))
  done < <(find "$root" -mindepth 1 -print0)
  [[ "$count" == 25 ]]
}

verify_admin_migration_candidate_matches_source() {
  local root=$1 relative
  verify_exact_admin_migration_kit "$root" || return 1
  while IFS= read -r relative; do
    /usr/bin/cmp -s "$root/$relative" "$DEPLOY_SOURCE_ROOT/$relative" || return 1
  done < <(admin_files)
}

verify_admin_migration_candidate_matches_metadata() {
  local root=$1 digest
  [[ -n "$ADMIN_MIGRATION_NEW_DIGEST" ]] || return 1
  verify_exact_admin_migration_kit "$root" || return 1
  digest="$(tree_sha256_for "$root")" || return 1
  [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]]
}

verify_admin_migration_candidate_for_action() {
  local root=$1 action=$2
  verify_admin_migration_candidate_matches_metadata "$root" || return 1
  if [[ "$action" == forward ]]; then
    verify_admin_migration_candidate_matches_source "$root" || return 1
  else
    [[ "$action" == rollback ]] || return 1
  fi
}

ADMIN_MIGRATION_FROZEN_CANDIDATE=

verify_admin_migration_frozen_candidate_topology() {
  local path selected= count=0
  ADMIN_MIGRATION_FROZEN_CANDIDATE=
  [[ -e "$ADMIN_MIGRATION_ROOT/metadata" ]] || return 1
  for path in \
    "$ADMIN_MIGRATION_STAGE" \
    "$ADMIN_ROOT" \
    "$ADMIN_MIGRATION_FAILED" \
    "$ADMIN_MIGRATION_FAILED_STAGE"; do
    if [[ ! -e "$path" && ! -L "$path" ]]; then continue; fi
    [[ -d "$path" && ! -L "$path" ]] || return 1
    if verify_admin_migration_candidate_matches_metadata "$path"; then
      selected=$path
      count=$((count + 1))
    elif [[ "$path" != "$ADMIN_ROOT" ]]; then
      return 1
    fi
  done
  if [[ -e "$ADMIN_MIGRATION_PREVIOUS" || \
    -L "$ADMIN_MIGRATION_PREVIOUS" ]]; then
    [[ -d "$ADMIN_MIGRATION_PREVIOUS" && \
      ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] || return 1
  fi
  [[ "$count" == 1 ]] || return 1
  ADMIN_MIGRATION_FROZEN_CANDIDATE=$selected
}

verify_admin_migration_current_source_matches_frozen_candidate() {
  verify_admin_migration_frozen_candidate_topology || return 1
  verify_admin_migration_candidate_matches_source \
    "$ADMIN_MIGRATION_FROZEN_CANDIDATE"
}

verify_admin_migration_frozen_payloads() {
  [[ -e "$ADMIN_MIGRATION_ROOT/metadata" ]] || return 1
  verify_admin_migration_runtime_payloads || return 1
  verify_admin_migration_runtime_payload_digests || return 1
  [[ -n "$ADMIN_MIGRATION_NEW_DIGEST" ]]
}

validate_finalized_admin_migration_forensic_artifact() {
  if [[ -e "$ADMIN_MIGRATION_ROOT/committed" ]]; then
    [[ ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
      ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" && \
      -d "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] ||
      return 1
    verify_legacy_admin_kit \
      "$ADMIN_MIGRATION_PREVIOUS" "$ADMIN_MIGRATION_EXPECTED_OLD" || return 1
    verify_admin_migration_frozen_payloads || return 1
    return 0
  fi
  [[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" && \
    ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" && \
    ! -e "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] ||
    return 1
  if [[ -e "$ADMIN_MIGRATION_ROOT/prepared" ]]; then
    verify_admin_migration_frozen_payloads || return 1
    if [[ -d "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
      ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]]; then
      verify_admin_migration_candidate_matches_metadata "$ADMIN_MIGRATION_FAILED" ||
        return 1
    elif [[ -d "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]]; then
      verify_admin_migration_candidate_matches_metadata \
        "$ADMIN_MIGRATION_FAILED_STAGE" || return 1
    else
      return 1
    fi
  else
    [[ ! -e "$ADMIN_MIGRATION_ROOT/metadata" && \
      ! -e "$ADMIN_MIGRATION_ROOT/old-runtime" && \
      ! -e "$ADMIN_MIGRATION_ROOT/new-runtime" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
      ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]] || return 1
  fi
}

stage_admin_migration_kit() {
  local relative mode destination temporary
  if [[ -e "$ADMIN_MIGRATION_STAGE" || -L "$ADMIN_MIGRATION_STAGE" ]]; then
    [[ -d "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" ]] ||
      die 'admin migration staging root is unsafe'
    chmod 0700 "$ADMIN_MIGRATION_STAGE"
  else
    install_directory 0700 root root "$ADMIN_MIGRATION_STAGE"
    fsync_path "$ADMIN_PARENT"
  fi
  while IFS= read -r relative; do
    mode=0444
    [[ "$relative" == *.sh || "$relative" == pre-upgrade-snapshot ]] && mode=0555
    destination="$ADMIN_MIGRATION_STAGE/$relative"
    install_directory 0700 root root "$(dirname -- "$destination")"
    temporary="$destination.admin-migration.tmp"
    install_admin_migration_file_atomically \
      "$DEPLOY_SOURCE_ROOT/$relative" \
      "$destination" \
      "$mode" \
      "$temporary"
  done < <(admin_files)
  if [[ -z "$TEST_ROOT" ]]; then chown -hR root:root "$ADMIN_MIGRATION_STAGE"; fi
  find "$ADMIN_MIGRATION_STAGE" -type d -exec chmod 0555 {} +
  while IFS= read -r destination; do fsync_path "$destination"; done < <(
    find "$ADMIN_MIGRATION_STAGE" -depth -type d -print
  )
  verify_exact_admin_migration_kit "$ADMIN_MIGRATION_STAGE" ||
    die 'admin migration staging kit failed verification'
}

isolate_admin_migration_stage_for_rollback() {
  if [[ -e "$ADMIN_MIGRATION_STAGE" || -L "$ADMIN_MIGRATION_STAGE" ]]; then
    [[ -e "$ADMIN_MIGRATION_ROOT/prepared" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]] ||
      die 'admin migration rollback candidate staging lacks a prepared journal or conflicts with an activated candidate'
    [[ ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]] ||
      die 'admin migration rollback has ambiguous candidate staging topology'
    verify_admin_migration_candidate_matches_metadata "$ADMIN_MIGRATION_STAGE" ||
      die 'admin migration rollback candidate staging is unsafe'
    [[ "$(tree_sha256_for "$ADMIN_MIGRATION_STAGE")" == \
      "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
      die 'admin migration rollback candidate staging changed from metadata'
    mv "$ADMIN_MIGRATION_STAGE" "$ADMIN_MIGRATION_FAILED_STAGE" ||
      die 'admin migration rollback candidate staging could not be isolated'
    fsync_path "$ADMIN_PARENT"
  elif [[ -e "$ADMIN_MIGRATION_FAILED_STAGE" || \
    -L "$ADMIN_MIGRATION_FAILED_STAGE" ]]; then
    [[ -e "$ADMIN_MIGRATION_ROOT/prepared" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]] ||
      die 'isolated admin migration candidate staging conflicts with rollback topology'
    verify_admin_migration_candidate_matches_metadata \
      "$ADMIN_MIGRATION_FAILED_STAGE" ||
      die 'isolated admin migration candidate staging is unsafe'
    [[ "$(tree_sha256_for "$ADMIN_MIGRATION_FAILED_STAGE")" == \
      "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
      die 'isolated admin migration candidate staging changed from metadata'
    fsync_path "$ADMIN_PARENT"
  fi
}

prepare_admin_migration_runtime_payloads() {
  local set payload_root mode relative destination label payload source temporary
  local expected_uid expected_gid
  expected_uid="$(admin_contract_uid)" ||
    die 'admin migration runtime payload UID is unavailable'
  expected_gid="$(admin_contract_gid)" ||
    die 'admin migration runtime payload GID is unavailable'
  for set in old new; do
    payload_root="$ADMIN_MIGRATION_ROOT/$set-runtime"
    if [[ -e "$payload_root" || -L "$payload_root" ]]; then
      [[ -d "$payload_root" && ! -L "$payload_root" ]] ||
        die 'admin migration runtime payload root is unsafe'
      [[ "$(stat_value '%u' '%u' "$payload_root")" == "$expected_uid" && \
        "$(stat_value '%g' '%g' "$payload_root")" == "$expected_gid" ]] ||
        die 'admin migration runtime payload root has the wrong owner'
      chmod 0700 "$payload_root"
    else
      install_directory 0700 root root "$payload_root"
    fi
    while IFS='|' read -r mode relative destination label; do
      payload="$payload_root/$label"
      if [[ "$set" == old ]]; then source=$destination; else source="$DEPLOY_SOURCE_ROOT/$relative"; fi
      temporary="$payload.admin-migration.tmp"
      install_admin_migration_file_atomically \
        "$source" \
        "$payload" \
        0400 \
        "$temporary"
    done < <(legacy_runtime_files)
    chmod 0500 "$payload_root"
    fsync_path "$payload_root"
  done
  fsync_path "$ADMIN_MIGRATION_ROOT"
}

verify_admin_migration_runtime_payloads() {
  local set payload_root mode relative destination label payload path name allowed count
  local expected_uid expected_gid
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  for set in old new; do
    payload_root="$ADMIN_MIGRATION_ROOT/$set-runtime"
    [[ -d "$payload_root" && ! -L "$payload_root" && \
      "$(stat_value '%u' '%u' "$payload_root")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$payload_root")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$payload_root")" == 500 ]] || return 1
    count=0
    while IFS= read -r -d '' path; do
      [[ -f "$path" && ! -L "$path" ]] || return 1
      name=${path##*/}
      allowed=false
      while IFS='|' read -r mode relative destination label; do
        if [[ "$name" == "$label" ]]; then allowed=true; break; fi
      done < <(legacy_runtime_files)
      [[ "$allowed" == true ]] || return 1
      count=$((count + 1))
    done < <(find "$payload_root" -mindepth 1 -print0)
    [[ "$count" == 5 ]] || return 1
    while IFS='|' read -r mode relative destination label; do
      payload="$payload_root/$label"
      [[ -f "$payload" && ! -L "$payload" && \
        "$(stat_value '%u' '%u' "$payload")" == "$expected_uid" && \
        "$(stat_value '%g' '%g' "$payload")" == "$expected_gid" && \
        "$(stat_value '%a' '%Lp' "$payload")" == 400 && \
        "$(stat_value '%h' '%l' "$payload")" == 1 ]] || return 1
    done < <(legacy_runtime_files)
  done
}

verify_admin_migration_runtime_payload_digests() {
  [[ -n "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" && \
    -n "$ADMIN_MIGRATION_NEW_RUNTIME_DIGEST" ]] || return 1
  [[ "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" == \
      "$LEGACY_RUNTIME_PRODUCTION_SHA256" && \
    "$(canonical_root_tree_sha256_for "$ADMIN_MIGRATION_ROOT/old-runtime")" == \
      "$ADMIN_MIGRATION_OLD_RUNTIME_DIGEST" && \
    "$(tree_sha256_for "$ADMIN_MIGRATION_ROOT/new-runtime")" == \
      "$ADMIN_MIGRATION_NEW_RUNTIME_DIGEST" ]]
}

verify_admin_migration_runtime_transition_set() {
  local mode relative destination label expected_uid expected_gid
  local old_payload new_payload
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  verify_admin_migration_runtime_payloads || return 1
  verify_admin_migration_runtime_payload_digests || return 1
  while IFS='|' read -r mode relative destination label; do
    old_payload="$ADMIN_MIGRATION_ROOT/old-runtime/$label"
    new_payload="$ADMIN_MIGRATION_ROOT/new-runtime/$label"
    [[ -f "$destination" && ! -L "$destination" && \
      "$(stat_value '%u' '%u' "$destination")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$destination")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$destination")" == "${mode#0}" && \
      "$(stat_value '%h' '%l' "$destination")" == 1 ]] || return 1
    if ! /usr/bin/cmp -s "$destination" "$old_payload" && \
      ! /usr/bin/cmp -s "$destination" "$new_payload"; then
      return 1
    fi
  done < <(legacy_runtime_files)
}

record_admin_migration_metadata() {
  local digest=$1 old_runtime_digest=$2 new_runtime_digest=$3 body
  validate_checksum "$digest"
  validate_checksum "$old_runtime_digest"
  validate_checksum "$new_runtime_digest"
  digest="$(printf '%s' "$digest" | tr 'A-F' 'a-f')"
  old_runtime_digest="$(printf '%s' "$old_runtime_digest" | tr 'A-F' 'a-f')"
  new_runtime_digest="$(printf '%s' "$new_runtime_digest" | tr 'A-F' 'a-f')"
  [[ "$old_runtime_digest" == "$LEGACY_RUNTIME_PRODUCTION_SHA256" ]] ||
    die 'legacy runtime payload is not an allowlisted migration source'
  printf -v body \
    'version=1\ntransaction=%s\nnew_admin_sha256=%s\nold_runtime_sha256=%s\nnew_runtime_sha256=%s\n' \
    "$ADMIN_MIGRATION_TRANSACTION" \
    "$digest" \
    "$old_runtime_digest" \
    "$new_runtime_digest"
  write_admin_migration_entry metadata "$body"
  ADMIN_MIGRATION_NEW_DIGEST=$digest
  ADMIN_MIGRATION_OLD_RUNTIME_DIGEST=$old_runtime_digest
  ADMIN_MIGRATION_NEW_RUNTIME_DIGEST=$new_runtime_digest
}

prepare_admin_migration_payloads() {
  local action=$1 digest old_runtime_digest new_runtime_digest
  [[ "$action" == forward || "$action" == rollback ]] ||
    die 'admin migration payload action is invalid'
  if [[ -e "$ADMIN_MIGRATION_ROOT/metadata" ]]; then
    validate_admin_migration_journal "$ADMIN_MIGRATION_EXPECTED_OLD" ||
      die 'frozen admin migration journal is invalid'
    verify_admin_migration_runtime_payloads ||
      die 'frozen admin migration runtime payload changed'
    verify_admin_migration_runtime_payload_digests ||
      die 'frozen admin migration runtime payload digest changed'
    verify_admin_migration_runtime_transition_set ||
      die 'installed runtime is outside the journaled old-to-new transition set'
    [[ -n "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
      die 'prepared admin migration metadata is missing'
    if [[ -d "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" ]]; then
      [[ ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
        ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]] ||
        die 'prepared admin migration has multiple candidate locations'
      verify_admin_migration_candidate_for_action \
        "$ADMIN_MIGRATION_STAGE" "$action" ||
        die 'prepared admin migration staging kit is invalid'
      digest="$(tree_sha256_for "$ADMIN_MIGRATION_STAGE")" ||
        die 'prepared admin migration staging kit cannot be fingerprinted'
      [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
        die 'prepared admin migration staging kit changed'
      if [[ -d "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" && \
        ! -e "$ADMIN_MIGRATION_PREVIOUS" && \
        ! -L "$ADMIN_MIGRATION_PREVIOUS" ]]; then
        verify_legacy_admin_kit "$ADMIN_ROOT" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
          die 'legacy admin kit changed before prepared migration resumed'
      elif [[ ! -e "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" && \
        -d "$ADMIN_MIGRATION_PREVIOUS" && \
        ! -L "$ADMIN_MIGRATION_PREVIOUS" ]]; then
        verify_legacy_admin_kit \
          "$ADMIN_MIGRATION_PREVIOUS" \
          "$ADMIN_MIGRATION_EXPECTED_OLD" ||
          die 'preserved legacy admin kit changed during activation recovery'
      else
        die 'prepared staged migration has an unsafe legacy admin topology'
      fi
    elif [[ -d "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" ]]; then
      [[ ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" ]] ||
        die 'prepared admin migration has an unsafe extra staging path'
      if verify_admin_migration_candidate_for_action "$ADMIN_ROOT" "$action"; then
        [[ ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
          ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
          ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]] ||
          die 'prepared admin migration has multiple candidate locations'
        digest="$(tree_sha256_for "$ADMIN_ROOT")" ||
          die 'activated admin migration kit cannot be fingerprinted'
        [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
          die 'activated admin migration kit changed'
        verify_legacy_admin_kit \
          "$ADMIN_MIGRATION_PREVIOUS" \
          "$ADMIN_MIGRATION_EXPECTED_OLD" ||
          die 'preserved legacy admin kit changed before migration resume'
      elif [[ -d "$ADMIN_MIGRATION_FAILED" && \
        ! -L "$ADMIN_MIGRATION_FAILED" && \
        ! -e "$ADMIN_MIGRATION_PREVIOUS" && \
        ! -L "$ADMIN_MIGRATION_PREVIOUS" && \
        ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]]; then
        verify_legacy_admin_kit "$ADMIN_ROOT" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
          die 'prepared rollback has neither a trusted legacy current nor a trusted candidate'
        verify_admin_migration_candidate_for_action \
          "$ADMIN_MIGRATION_FAILED" "$action" ||
          die 'isolated activated admin migration candidate is invalid'
        digest="$(tree_sha256_for "$ADMIN_MIGRATION_FAILED")" ||
          die 'isolated activated admin migration candidate cannot be fingerprinted'
        [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
          die 'isolated activated admin migration candidate changed'
      elif [[ -d "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -L "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -e "$ADMIN_MIGRATION_PREVIOUS" && \
        ! -L "$ADMIN_MIGRATION_PREVIOUS" && \
        ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]]; then
        verify_legacy_admin_kit "$ADMIN_ROOT" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
          die 'prepared rollback has neither a trusted legacy current nor a trusted candidate'
        verify_admin_migration_candidate_for_action \
          "$ADMIN_MIGRATION_FAILED_STAGE" "$action" ||
          die 'isolated staged admin migration candidate is invalid'
        digest="$(tree_sha256_for "$ADMIN_MIGRATION_FAILED_STAGE")" ||
          die 'isolated staged admin migration candidate cannot be fingerprinted'
        [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
          die 'isolated staged admin migration candidate changed'
      else
        die 'prepared admin migration candidate topology is invalid'
      fi
    elif [[ -d "$ADMIN_MIGRATION_PREVIOUS" && \
      ! -L "$ADMIN_MIGRATION_PREVIOUS" && \
      -d "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
      ! -e "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" && \
      ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" && \
      ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]]; then
      verify_legacy_admin_kit \
        "$ADMIN_MIGRATION_PREVIOUS" \
        "$ADMIN_MIGRATION_EXPECTED_OLD" ||
        die 'preserved legacy admin kit changed during rollback recovery'
      verify_admin_migration_candidate_for_action \
        "$ADMIN_MIGRATION_FAILED" "$action" ||
        die 'isolated activated admin migration candidate is invalid'
      digest="$(tree_sha256_for "$ADMIN_MIGRATION_FAILED")" ||
        die 'isolated activated admin migration candidate cannot be fingerprinted'
      [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
        die 'isolated activated admin migration candidate changed'
    else
      die 'prepared admin migration has no candidate kit'
    fi
    if [[ ! -e "$ADMIN_MIGRATION_ROOT/prepared" ]]; then
      record_admin_migration_phase prepared
    fi
    return 0
  fi
  stage_admin_migration_kit
  prepare_admin_migration_runtime_payloads
  digest="$(tree_sha256_for "$ADMIN_MIGRATION_STAGE")" ||
    die 'admin migration staging kit cannot be fingerprinted'
  old_runtime_digest="$(canonical_root_tree_sha256_for \
    "$ADMIN_MIGRATION_ROOT/old-runtime")" ||
    die 'legacy runtime payload cannot be fingerprinted'
  [[ "$old_runtime_digest" == "$LEGACY_RUNTIME_PRODUCTION_SHA256" ]] ||
    die 'legacy runtime payload does not match the supported source release'
  new_runtime_digest="$(tree_sha256_for "$ADMIN_MIGRATION_ROOT/new-runtime")" ||
    die 'new runtime payload cannot be fingerprinted'
  record_admin_migration_metadata \
    "$digest" \
    "$old_runtime_digest" \
    "$new_runtime_digest"
  record_admin_migration_phase prepared
}

publish_admin_migration_runtime_set() {
  local set=$1 payload_root mode relative destination label payload temporary
  [[ "$set" == old || "$set" == new ]] || die 'admin migration runtime set is invalid'
  payload_root="$ADMIN_MIGRATION_ROOT/$set-runtime"
  verify_admin_migration_runtime_payloads ||
    die 'admin migration runtime payload verification failed'
  verify_admin_migration_runtime_payload_digests ||
    die 'admin migration runtime payload digest verification failed'
  while IFS='|' read -r mode relative destination label; do
    payload="$payload_root/$label"
    [[ -f "$destination" && ! -L "$destination" ]] ||
      die 'admin migration runtime destination is missing or unsafe'
    temporary="$(dirname -- "$destination")/${ADMIN_MIGRATION_LIVE_COPY_TEMP_PREFIX}-$label.tmp"
    install_admin_migration_file_atomically \
      "$payload" \
      "$destination" \
      "$mode" \
      "$temporary"
  done < <(legacy_runtime_files)
  verify_admin_migration_runtime_set "$set" ||
    die 'admin migration runtime set failed post-publication verification'
}

verify_admin_migration_runtime_set() {
  local set=$1 payload_root mode relative destination label payload expected_uid
  local expected_gid
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  [[ "$set" == old || "$set" == new ]] || return 1
  payload_root="$ADMIN_MIGRATION_ROOT/$set-runtime"
  verify_admin_migration_runtime_payloads || return 1
  verify_admin_migration_runtime_payload_digests || return 1
  while IFS='|' read -r mode relative destination label; do
    payload="$payload_root/$label"
    [[ -f "$destination" && ! -L "$destination" && \
      "$(stat_value '%u' '%u' "$destination")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$destination")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$destination")" == "${mode#0}" && \
      "$(stat_value '%h' '%l' "$destination")" == 1 ]] && \
      /usr/bin/cmp -s "$destination" "$payload" || return 1
  done < <(legacy_runtime_files)
}

activate_new_admin_migration_kit() {
  local digest
  if [[ -d "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" ]] &&
    verify_admin_migration_candidate_matches_source "$ADMIN_ROOT"; then
    digest="$(tree_sha256_for "$ADMIN_ROOT")" ||
      die 'activated admin kit cannot be fingerprinted'
    [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" && \
      -d "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" && \
      ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" ]] ||
      die 'activated admin migration topology is invalid'
    verify_legacy_admin_kit \
      "$ADMIN_MIGRATION_PREVIOUS" \
      "$ADMIN_MIGRATION_EXPECTED_OLD" ||
      die 'preserved legacy admin kit changed after migration activation'
    fsync_path "$ADMIN_PARENT"
    return 0
  fi
  if [[ -d "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" ]]; then
    verify_legacy_admin_kit "$ADMIN_ROOT" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
      die 'legacy admin kit changed before migration activation'
    [[ ! -e "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] ||
      die 'legacy admin migration preservation path already exists'
    mv "$ADMIN_ROOT" "$ADMIN_MIGRATION_PREVIOUS"
    fsync_path "$ADMIN_PARENT"
  fi
  [[ ! -e "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" && \
    -d "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" && \
    -d "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" ]] ||
    die 'admin migration activation topology is invalid'
  verify_legacy_admin_kit "$ADMIN_MIGRATION_PREVIOUS" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
    die 'preserved legacy admin kit changed'
  digest="$(tree_sha256_for "$ADMIN_MIGRATION_STAGE")" ||
    die 'admin migration candidate kit cannot be fingerprinted'
  [[ "$digest" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
    die 'admin migration candidate kit does not match metadata'
  # The visible legacy-preserved topology may be recovery from a crash after
  # the first rename but before its parent-directory fsync completed. Rebuild
  # that namespace durability boundary before publishing the candidate.
  fsync_path "$ADMIN_PARENT"
  mv "$ADMIN_MIGRATION_STAGE" "$ADMIN_ROOT"
  fsync_path "$ADMIN_PARENT"
  verify_admin_migration_candidate_matches_source "$ADMIN_ROOT" ||
    die 'activated admin migration kit is invalid'
}

restore_legacy_admin_migration_kit() {
  local digest
  if verify_legacy_admin_kit "$ADMIN_ROOT" "$ADMIN_MIGRATION_EXPECTED_OLD"; then
    [[ ! -e "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] ||
      die 'rolled-back admin migration retained a duplicate legacy kit'
    fsync_path "$ADMIN_PARENT"
    return 0
  fi
  [[ -d "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] ||
    die 'admin migration rollback has no preserved legacy kit'
  verify_legacy_admin_kit "$ADMIN_MIGRATION_PREVIOUS" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
    die 'preserved legacy admin kit changed before rollback'
  if [[ -e "$ADMIN_ROOT" || -L "$ADMIN_ROOT" ]]; then
    [[ -d "$ADMIN_ROOT" && ! -L "$ADMIN_ROOT" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]] ||
      die 'admin migration rollback candidate topology is unsafe'
    mv "$ADMIN_ROOT" "$ADMIN_MIGRATION_FAILED"
    fsync_path "$ADMIN_PARENT"
  fi
  # A retry may observe candidate-isolated after the preceding rename became
  # visible but its parent fsync did not. Do not advance to legacy activation
  # until that already-visible boundary has been made durable again.
  fsync_path "$ADMIN_PARENT"
  mv "$ADMIN_MIGRATION_PREVIOUS" "$ADMIN_ROOT"
  fsync_path "$ADMIN_PARENT"
  verify_legacy_admin_kit "$ADMIN_ROOT" "$ADMIN_MIGRATION_EXPECTED_OLD" ||
    die 'rolled-back legacy admin kit failed verification'
}

verify_admin_migration_carrier_directory() {
  local path=$1 policy=$2 expected_uid expected_gid actual_mode canonical
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  [[ -d "$path" && ! -L "$path" && \
    "$(stat_value '%u' '%u' "$path")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$path")" == "$expected_gid" ]] || return 1
  actual_mode="$(stat_value '%a' '%Lp' "$path")" || return 1
  if [[ "$policy" == safe ]]; then
    mode_is_safe "$actual_mode" || return 1
  else
    [[ "$actual_mode" == "$policy" ]] || return 1
  fi
  canonical="$(CDPATH= cd -P -- "$path" 2>/dev/null && pwd -P)" || return 1
  [[ "$canonical" == "$path" ]] || return 1
  if [[ -z "$TEST_ROOT" ]]; then
    trusted_parent_chain "$path/.agent-os-migration-carrier" || return 1
  fi
}

verify_admin_migration_carrier_contract() {
  local path policy
  while IFS='|' read -r policy path; do
    verify_admin_migration_carrier_directory "$path" "$policy" || return 1
  done <<EOF
755|$ADMIN_PARENT
700|$CONFIG_ROOT
755|$STATE_PARENT
755|$OPT_ROOT
755|$RELEASES_ROOT
safe|$(dirname -- "$RUNTIME_ROOT")
safe|$(dirname -- "$UNIT_PATH")
safe|$(dirname -- "$NGINX_EXAMPLE_PATH")
safe|$(dirname -- "$NGINX_LIMITS_EXAMPLE_PATH")
EOF
  # The pre-SVR-03 runtime and durable-operation namespaces may legitimately
  # be absent after reboot or before the first migration attempt. If visible,
  # however, they are trusted carriers and must be rejected rather than
  # repaired before journal recovery or the first migration mutation.
  while IFS='|' read -r policy path; do
    if [[ -e "$path" || -L "$path" ]]; then
      verify_admin_migration_carrier_directory "$path" "$policy" || return 1
    fi
  done <<EOF
755|$RUNTIME_ROOT
755|$OPS_ROOT
700|$RECOVERY_ROOT
EOF
}

verify_admin_migration_identity_contract() {
  # The fake-root gate supplies numeric ownership explicitly. Production must
  # additionally re-prove the exact locked, unique, no-supplementary-group
  # identities on which the observable-reference stop gate relies.
  [[ -n "$TEST_ROOT" ]] && return 0
  require_commands getent passwd awk
  validate_existing_identity "$SERVICE_USER" "$SERVICE_GROUP" /var/lib/agent-os
  validate_existing_identity \
    "$CANDIDATE_SERVICE_USER" \
    "$CANDIDATE_SERVICE_GROUP" \
    /var/lib/agent-os/hub-candidates
  validate_identity_separation
}

verify_admin_migration_env_contract() {
  local expected_uid expected_gid
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && \
    "$(stat_value '%u' '%u' "$ENV_FILE")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$ENV_FILE")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$ENV_FILE")" == 600 && \
    "$(stat_value '%h' '%l' "$ENV_FILE")" == 1 ]] || return 1
  "$NODE_BIN" "$DEPLOY_SOURCE_ROOT/bin/validate-config.mjs" "$ENV_FILE" >/dev/null
}

verify_admin_migration_state_root_contract() {
  local expected_uid expected_gid actual_uid actual_gid
  if [[ -n "$TEST_ROOT" ]]; then
    expected_uid=$EUID
    expected_gid="$($ID_BIN -g)" || return 1
  else
    expected_uid="$($ID_BIN -u "$SERVICE_USER")" || return 1
    expected_gid="$($ID_BIN -g "$SERVICE_USER")" || return 1
  fi
  [[ "$expected_uid" =~ ^(0|[1-9][0-9]*)$ && \
    "$expected_gid" =~ ^(0|[1-9][0-9]*)$ && \
    -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || return 1
  actual_uid="$(stat_value '%u' '%u' "$STATE_ROOT")" || return 1
  actual_gid="$(stat_value '%g' '%g' "$STATE_ROOT")" || return 1
  [[ "$actual_uid" == "$expected_uid" && "$actual_gid" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$STATE_ROOT")" == 700 ]]
}

verify_admin_migration_release_root_contract() {
  local release_root=$1 expected_uid=$2 expected_gid=$3 directory server_entry
  for directory in \
    "$release_root" \
    "$release_root/apps" \
    "$release_root/apps/chat-spike" \
    "$release_root/apps/chat-spike/src"; do
    [[ -d "$directory" && ! -L "$directory" && \
      "$(stat_value '%u' '%u' "$directory")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$directory")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$directory")" == 555 ]] || return 1
  done
  server_entry="$release_root/apps/chat-spike/src/server.mjs"
  [[ -f "$server_entry" && ! -L "$server_entry" && \
    "$(stat_value '%u' '%u' "$server_entry")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$server_entry")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$server_entry")" == 444 && \
    "$(stat_value '%h' '%l' "$server_entry")" == 1 ]]
}

verify_admin_migration_release_pointer_contract() {
  local entry release_root expected_uid expected_gid previous_entry
  local previous_release_root
  expected_uid="$(admin_contract_uid)" || return 1
  expected_gid="$(admin_contract_gid)" || return 1
  entry="$(read_revision_link "$CURRENT_LINK")" || return 1
  [[ -n "$entry" ]] || return 1
  release_root="$RELEASES_ROOT/$entry"
  verify_admin_migration_release_root_contract \
    "$release_root" "$expected_uid" "$expected_gid" || return 1
  if [[ -e "$PREVIOUS_LINK" || -L "$PREVIOUS_LINK" ]]; then
    previous_entry="$(read_revision_link "$PREVIOUS_LINK")" || return 1
    previous_release_root="$RELEASES_ROOT/$previous_entry"
    verify_admin_migration_release_root_contract \
      "$previous_release_root" "$expected_uid" "$expected_gid" || return 1
  fi
}

preflight_installed_admin_migration() {
  local expected_digest=$1 action=$2 migration
  local -a migrations=()
  validate_checksum "$expected_digest"
  expected_digest="$(printf '%s' "$expected_digest" | tr 'A-F' 'a-f')"
  [[ "$expected_digest" == "$LEGACY_ADMIN_PRODUCTION_SHA256" ]] ||
    die 'installed admin migration supports only the allowlisted legacy release'
  verify_admin_source "$DEPLOY_SOURCE_ROOT"
  verify_admin_migration_carrier_contract ||
    die 'installed legacy migration carrier directories are unsafe'
  verify_admin_migration_identity_contract
  select_admin_migration_attempt "$expected_digest" "$action"
  if [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]]; then
    shopt -s nullglob
    migrations=("$RECOVERY_ROOT"/upgrade-admin-migration-*)
    shopt -u nullglob
    for migration in "${migrations[@]+"${migrations[@]}"}"; do
      [[ -d "$migration" && ! -L "$migration" ]] ||
        die 'admin migration history root is unsafe'
    done
    require_only_selected_admin_migration_intent_staging
  fi
  inspect_admin_migration_intent_staging "$expected_digest"
  verify_admin_migration_env_contract ||
    die 'installed legacy Hub environment file is unsafe or invalid'
  verify_admin_migration_state_root_contract ||
    die 'installed legacy Hub state root ownership or mode is unsafe'
  verify_admin_migration_release_pointer_contract ||
    die 'installed legacy release pointer contract is unsafe or incomplete'
  if [[ -e "$ADMIN_MIGRATION_ROOT" || -L "$ADMIN_MIGRATION_ROOT" ]]; then
    # The bootstrap calls this pure preflight once before taking the deploy
    # lock and running recovery. Permit only the already-selected latest
    # journal's strictly validated transaction-owned temporary here; locked
    # recovery removes it and the second preflight observes a clean journal.
    validate_admin_migration_journal "$expected_digest" true ||
      die 'existing admin migration journal is invalid'
    if [[ -e "$ADMIN_MIGRATION_ROOT/metadata" ]]; then
      verify_admin_migration_frozen_payloads ||
        die 'frozen admin migration payload changed'
      verify_admin_migration_runtime_transition_set ||
        die 'installed runtime is outside the frozen old-to-new transition set'
      verify_admin_migration_frozen_candidate_topology ||
        die 'frozen admin migration candidate topology changed'
      if [[ "$action" == forward ]]; then
        verify_admin_migration_candidate_matches_source \
          "$ADMIN_MIGRATION_FROZEN_CANDIDATE" ||
          die 'current admin source does not match frozen migration metadata'
      fi
    fi
    return 0
  fi
  [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
    ! -e "$MAINTENANCE_PATH" && ! -L "$MAINTENANCE_PATH" && \
    ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" ]] ||
    die 'admin migration requires a clean maintenance state'
  verify_legacy_admin_kit "$ADMIN_ROOT" "$expected_digest" ||
    die 'installed legacy admin kit does not match the operator-pinned digest'
  verify_legacy_runtime_contract "$ADMIN_ROOT" ||
    die 'installed legacy runtime files do not match the pinned admin kit'
}

admin_migration_guard_is_clean() {
  [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
    ! -e "$MAINTENANCE_PATH" && ! -L "$MAINTENANCE_PATH" && \
    ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" && \
    ! -e "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]]
}

stop_and_prove_admin_migration_writer_stopped() {
  local helper="$DEPLOY_SOURCE_ROOT/bin/state-open-files.mjs"
  local expected_control_group="/system.slice/$SERVICE_NAME"
  local observed_control_group= service_uid=
  local -a proc_arguments=()
  [[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || return 1
  verify_admin_source "$DEPLOY_SOURCE_ROOT"
  [[ -f "$helper" && ! -L "$helper" ]] || return 1
  service_uid="$($ID_BIN -u "$SERVICE_USER" 2>/dev/null)" || return 1
  [[ "$service_uid" =~ ^(0|[1-9][0-9]*)$ && "$service_uid" != 0 ]] || return 1
  if ((${#service_uid} > 10)) || ((service_uid > 4294967295)); then
    return 1
  fi
  if service_control is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    observed_control_group="$(
      service_control show --property=ControlGroup --value "$SERVICE_NAME" 2>/dev/null
    )" || return 1
    [[ "$observed_control_group" == "$expected_control_group" ]] || return 1
  fi
  service_control stop "$SERVICE_NAME" || return 1
  service_unit_is_inactive "$SERVICE_NAME" || return 1
  if [[ -n "$TEST_ROOT" ]]; then
    proc_arguments=(
      --proc-root "$TEST_ROOT/proc"
      --cgroup-root "$TEST_ROOT/cgroup"
      --inspector-pid 999
    )
  fi
  "$NODE_BIN" "$helper" \
    "$STATE_ROOT" \
    --forbidden-cgroup "$expected_control_group" \
    --service-uid "$service_uid" \
    --unit-inactive-proof inactive-mainpid0 \
    "${proc_arguments[@]}" >/dev/null || return 1
}

prove_admin_migration_state_quiescent() {
  local helper="$DEPLOY_SOURCE_ROOT/bin/state-snapshot.mjs"
  verify_admin_source "$DEPLOY_SOURCE_ROOT"
  [[ -f "$helper" && ! -L "$helper" ]] || return 1
  "$NODE_BIN" "$helper" measure "$STATE_ROOT" >/dev/null
}

ensure_admin_migration_guard() {
  ADMIN_MIGRATION_ACTIVE=true
  # The legacy live proxy already understands the /run sentinel. Publish it
  # first after strict service-disable proof so a non-rebooting crash stops new
  # ingress; a reboot may clear /run, but the unit is already disabled then.
  create_normal_maintenance_sentinel
  durable_recovery_on \
    state-admin-migration \
    blocked \
    "$ADMIN_MIGRATION_TRANSACTION"
  maintenance_on_for_recovery
  record_admin_migration_phase blocked
}

admin_migration_fail_closed() {
  [[ -n "${ADMIN_MIGRATION_TRANSACTION:-}" ]] || return 0
  service_control stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  service_control disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  maintenance_fail_closed \
    admin-migration-failed \
    blocked \
    "$ADMIN_MIGRATION_TRANSACTION" >/dev/null 2>&1 || true
  return 1
}

finalized_admin_migration_is_healthy() {
  local expected_digest=$1
  validate_admin_migration_journal "$expected_digest" || return 1
  verify_admin_migration_env_contract || return 1
  verify_admin_migration_state_root_contract || return 1
  verify_admin_migration_release_pointer_contract || return 1
  [[ -e "$ADMIN_MIGRATION_ROOT/finalized" ]] || return 1
  admin_migration_guard_is_clean || return 1
  if [[ -e "$ADMIN_MIGRATION_ROOT/committed" ]]; then
    verify_admin_migration_candidate_matches_metadata "$ADMIN_ROOT" || return 1
    verify_legacy_admin_kit "$ADMIN_MIGRATION_PREVIOUS" "$expected_digest" ||
      return 1
    [[ ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" && \
      ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -L "$ADMIN_MIGRATION_FAILED_STAGE" && \
      ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]] ||
      return 1
    [[ "$(tree_sha256_for "$ADMIN_ROOT")" == "$ADMIN_MIGRATION_NEW_DIGEST" ]] ||
      return 1
    verify_admin_migration_runtime_set new || return 1
  elif [[ -e "$ADMIN_MIGRATION_ROOT/rolled_back" ]]; then
    verify_legacy_admin_kit "$ADMIN_ROOT" "$expected_digest" || return 1
    [[ ! -e "$ADMIN_MIGRATION_STAGE" && ! -L "$ADMIN_MIGRATION_STAGE" && \
      ! -e "$ADMIN_MIGRATION_PREVIOUS" && ! -L "$ADMIN_MIGRATION_PREVIOUS" ]] ||
      return 1
    if [[ -e "$ADMIN_MIGRATION_ROOT/prepared" ]]; then
      verify_admin_migration_runtime_set old || return 1
      if [[ -d "$ADMIN_MIGRATION_FAILED" && \
        ! -L "$ADMIN_MIGRATION_FAILED" && \
        ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]]; then
        verify_admin_migration_candidate_matches_metadata "$ADMIN_MIGRATION_FAILED" ||
          return 1
        [[ "$(tree_sha256_for "$ADMIN_MIGRATION_FAILED")" == \
          "$ADMIN_MIGRATION_NEW_DIGEST" ]] || return 1
      elif [[ -d "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -L "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" ]]; then
        verify_admin_migration_candidate_matches_metadata \
          "$ADMIN_MIGRATION_FAILED_STAGE" || return 1
        [[ "$(tree_sha256_for "$ADMIN_MIGRATION_FAILED_STAGE")" == \
          "$ADMIN_MIGRATION_NEW_DIGEST" ]] || return 1
      else
        return 1
      fi
    else
      [[ ! -e "$ADMIN_MIGRATION_ROOT/metadata" && \
        ! -e "$ADMIN_MIGRATION_ROOT/old-runtime" && \
        ! -e "$ADMIN_MIGRATION_ROOT/new-runtime" && \
        ! -e "$ADMIN_MIGRATION_FAILED" && ! -L "$ADMIN_MIGRATION_FAILED" && \
        ! -e "$ADMIN_MIGRATION_FAILED_STAGE" && \
        ! -L "$ADMIN_MIGRATION_FAILED_STAGE" ]] || return 1
      verify_legacy_runtime_contract "$ADMIN_ROOT" || return 1
    fi
  else
    return 1
  fi
  effective_unit_contract_is_current "$SERVICE_NAME" "$UNIT_PATH" || return 1
  # A finalized retry is validation-only. It must never start or enable a
  # service while ADMIN_MIGRATION_ACTIVE is false and no durable guard exists.
  service_control is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1 || return 1
  health_gate live || return 1
  service_control is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1
}

migrate_installed_admin_kit() {
  local expected_digest=$1 action=$2 journal_existed=false
  [[ "$action" == forward || "$action" == rollback ]] ||
    die 'admin migration action is invalid'
  select_admin_migration_attempt "$expected_digest" "$action"
  if [[ -e "$ADMIN_MIGRATION_ROOT" || -L "$ADMIN_MIGRATION_ROOT" ]]; then
    journal_existed=true
    cleanup_admin_migration_journal_temporaries "$expected_digest"
    validate_admin_migration_journal "$expected_digest" ||
      die 'admin migration journal failed locked revalidation'
  fi
  if [[ "$journal_existed" != true && "$action" == rollback ]]; then
    die 'admin migration rollback requires an existing migration journal'
  fi
  if [[ "$journal_existed" == true ]]; then
    if [[ "$action" == rollback && -e "$ADMIN_MIGRATION_ROOT/committed" ]]; then
      die 'a committed admin migration can only be finalized forward'
    fi
    if [[ "$action" == forward && \
      (-e "$ADMIN_MIGRATION_ROOT/rollback_started" || \
        -e "$ADMIN_MIGRATION_ROOT/rolled_back") ]]; then
      die 'a rolled-back admin migration can only be finalized as rollback'
    fi
    if [[ -e "$ADMIN_MIGRATION_ROOT/finalized" && \
      ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]]; then
      # Terminal retries validate the already-published contract before any
      # layout repair or service mutation. Journal-temp recovery and the
      # deployment lock are the only permitted bootstrap-side canonicalization.
      finalized_admin_migration_is_healthy "$expected_digest" ||
        die 'finalized admin migration no longer matches its terminal state'
      ADMIN_MIGRATION_COMPLETE=true
      ADMIN_MIGRATION_ACTIVE=false
      return 0
    fi
  fi
  ensure_admin_migration_intent_layout
  if [[ "$journal_existed" != true ]]; then
    create_admin_migration_intent "$expected_digest"
  fi
  load_admin_migration_journal "$expected_digest" ||
    die 'admin migration intent changed before guard publication'

  if [[ "$action" == rollback && -e "$ADMIN_MIGRATION_ROOT/committed" ]]; then
    die 'a committed admin migration can only be finalized forward'
  fi
  if [[ "$action" == forward && \
    (-e "$ADMIN_MIGRATION_ROOT/rollback_started" || \
      -e "$ADMIN_MIGRATION_ROOT/rolled_back") ]]; then
    die 'a rolled-back admin migration can only be finalized as rollback'
  fi

  # The intent is audit-only: no admin, runtime or state mutation is allowed
  # before this point. Disable and durably record auto-start prevention before
  # `blocked`, because the legacy unit has no recovery-start gate and /run is
  # cleared at reboot.
  service_control disable "$SERVICE_NAME" ||
    die 'admin migration could not disable the Hub service'
  service_is_strictly_disabled ||
    die 'Hub service disable state could not be proved during admin migration'
  record_admin_migration_phase disabled
  ensure_admin_migration_guard
  stop_and_prove_admin_migration_writer_stopped ||
    die 'admin migration could not prove the legacy writer stopped'
  record_admin_migration_phase stopped
  if [[ "$action" == forward ]]; then
    prove_admin_migration_state_quiescent ||
      die 'legacy Hub state is corrupt or contains active work after writer stop'
  fi

  if [[ "$action" == rollback ]]; then
    record_admin_migration_phase rollback_started
    if [[ -e "$ADMIN_MIGRATION_ROOT/prepared" || \
      -e "$ADMIN_MIGRATION_ROOT/metadata" || \
      -e "$ADMIN_MIGRATION_ROOT/old-runtime" || \
      -e "$ADMIN_MIGRATION_ROOT/new-runtime" || \
      -e "$ADMIN_MIGRATION_STAGE" || -L "$ADMIN_MIGRATION_STAGE" ]]; then
      prepare_admin_migration_payloads rollback
      publish_admin_migration_runtime_set old
      restore_legacy_admin_migration_kit
    else
      verify_legacy_admin_kit "$ADMIN_ROOT" "$expected_digest" ||
        die 'pre-prepare migration rollback found a changed legacy kit'
      verify_legacy_runtime_contract "$ADMIN_ROOT" ||
        die 'pre-prepare migration rollback found changed runtime files'
    fi
    isolate_admin_migration_stage_for_rollback
    verify_legacy_runtime_contract "$ADMIN_ROOT" ||
      die 'rolled-back legacy runtime contract failed exact verification'
    # Revalidate the effective legacy unit after daemon-reload, including its
    # fragment path, absence of drop-ins and NeedDaemonReload state, before any
    # rollback path is allowed to start the old Hub.
    require_installed_runtime_contract
    record_admin_migration_phase rolled_back
    # The legacy SVR-02 unit has no recovery-start gate, so it can be started
    # while the exact normal+persistent ingress guard remains published. Keep
    # it disabled, prove direct loopback liveness, and only then remove the
    # guard. A reboot before cleanup cannot auto-start it, and public traffic
    # never reaches an unverified rollback process.
    reset_failed_or_prove_inactive "$SERVICE_NAME" ||
      die 'legacy Hub reset-failed failed after migration rollback'
    service_control start "$SERVICE_NAME" ||
      die 'legacy Hub failed to start after migration rollback'
    health_gate live || die 'legacy Hub failed liveness after migration rollback'
    maintenance_off "$ADMIN_MIGRATION_TRANSACTION"
    service_enable
    # `finalized` is the terminal validation-only boundary. Publish it only
    # after the service is active, healthy and enabled so a crash cannot leave
    # an unrepairable finalized+disabled topology.
    record_admin_migration_phase finalized
    ADMIN_MIGRATION_COMPLETE=true
    ADMIN_MIGRATION_ACTIVE=false
    return 0
  fi

  if [[ ! -e "$ADMIN_MIGRATION_ROOT/prepared" ]]; then
    verify_legacy_admin_kit "$ADMIN_ROOT" "$expected_digest" ||
      die 'legacy admin kit changed before migration preparation'
    verify_legacy_runtime_contract "$ADMIN_ROOT" ||
      die 'legacy runtime changed before migration preparation'
  fi
  prepare_admin_migration_payloads forward
  publish_admin_migration_runtime_set new
  record_admin_migration_phase runtime_activated
  activate_new_admin_migration_kit
  record_admin_migration_phase admin_activated
  service_control daemon-reload || die 'new admin runtime daemon-reload failed'
  require_installed_runtime_contract
  record_admin_migration_phase daemon_reloaded
  start_authorized_recovery_service "$ADMIN_MIGRATION_TRANSACTION" ||
    die 'migrated Hub failed its transaction-bound start'
  record_admin_migration_phase started
  health_gate live || die 'migrated Hub failed exact liveness'
  record_admin_migration_phase verified
  service_enable
  record_admin_migration_phase enabled
  record_admin_migration_phase committed
  maintenance_off "$ADMIN_MIGRATION_TRANSACTION"
  record_admin_migration_phase finalized
  ADMIN_MIGRATION_COMPLETE=true
  ADMIN_MIGRATION_ACTIVE=false
}

require_fixed_admin_execution() {
  [[ "$DEPLOY_LIB_DIR" == "$ADMIN_ROOT/bin" ]] ||
    die 'run this operation from the fixed root-owned Hub admin kit'
  verify_admin_kit "$ADMIN_ROOT" || die 'fixed Hub admin kit failed its trust check'
}

require_unit_file_contract() {
  local installed=$1 audited=$2 label=$3
  local unit_owner unit_group unit_mode unit_links expected_uid expected_gid
  expected_uid="$(admin_contract_uid)" || die "installed $label unit UID is unavailable"
  expected_gid="$(admin_contract_gid)" || die "installed $label unit GID is unavailable"
  [[ -f "$installed" && ! -L "$installed" ]] ||
    die "installed $label unit is missing or unsafe"
  unit_owner="$(stat_value '%u' '%u' "$installed")"
  unit_group="$(stat_value '%g' '%g' "$installed")"
  unit_mode="$(stat_value '%a' '%Lp' "$installed")"
  unit_links="$(stat_value '%h' '%l' "$installed")"
  [[ "$unit_owner" == "$expected_uid" && "$unit_group" == "$expected_gid" && \
    "$unit_mode" == 644 && "$unit_links" == 1 ]] ||
    die "installed $label unit ownership, mode or link count is unsafe"
  /usr/bin/cmp -s "$installed" "$audited" ||
    die "installed $label unit is stale; install the audited admin unit before operations"
}

effective_unit_contract_is_current() {
  local unit=$1 expected_fragment=$2 fragment dropins reload_state
  fragment="$(service_control show --property=FragmentPath --value "$unit" 2>/dev/null)" ||
    return 1
  dropins="$(service_control show --property=DropInPaths --value "$unit" 2>/dev/null)" ||
    return 1
  reload_state="$(service_control show --property=NeedDaemonReload --value "$unit" 2>/dev/null)" ||
    return 1
  [[ "$fragment" == "$expected_fragment" && -z "$dropins" && \
    "$reload_state" == no ]]
}

require_installed_runtime_contract() {
  require_unit_file_contract \
    "$UNIT_PATH" \
    "$ADMIN_ROOT/systemd/agent-os-hub.service" \
    'Hub'
  service_control daemon-reload || die 'systemd daemon-reload failed before state operation'
  effective_unit_contract_is_current "$SERVICE_NAME" "$UNIT_PATH" ||
    die 'effective Hub unit is stale, redirected or modified by a drop-in'
}

require_candidate_runtime_contract() {
  local revision=$1 unit fragment dropins reload_state
  validate_revision "$revision"
  unit="${CANDIDATE_SERVICE_PREFIX}${revision}.service"
  require_unit_file_contract \
    "$CANDIDATE_UNIT_PATH" \
    "$ADMIN_ROOT/systemd/agent-os-hub-candidate@.service" \
    'Hub candidate'
  service_control daemon-reload || die 'systemd daemon-reload failed before candidate preflight'
  fragment="$(service_control show --property=FragmentPath --value "$unit" 2>/dev/null)" ||
    die 'candidate unit fragment cannot be inspected'
  dropins="$(service_control show --property=DropInPaths --value "$unit" 2>/dev/null)" ||
    die 'candidate unit drop-ins cannot be inspected'
  reload_state="$(service_control show --property=NeedDaemonReload --value "$unit" 2>/dev/null)" ||
    die 'candidate unit reload state cannot be inspected'
  [[ "$fragment" == "$CANDIDATE_UNIT_PATH" && -z "$dropins" && "$reload_state" == no ]] ||
    die 'effective candidate unit is stale, redirected or modified by a drop-in'
}

acquire_deploy_lock() {
  require_commands "$FLOCK_BIN" install chmod stat
  # This root-owned runtime directory and lock file are the only mutation
  # allowed before the fail-closed sentinels are checked. They serialize that
  # check with every later deployment-layout mutation.
  if [[ -e "$RUNTIME_ROOT" || -L "$RUNTIME_ROOT" ]]; then
    [[ -d "$RUNTIME_ROOT" && ! -L "$RUNTIME_ROOT" ]] ||
      die 'deployment runtime root is not a real directory'
  fi
  install_directory 0755 root root "$RUNTIME_ROOT"
  [[ ! -L "$LOCK_PATH" ]] || die 'deployment lock must not be a symbolic link'
  if [[ ! -e "$LOCK_PATH" ]]; then
    umask 077
    : >"$LOCK_PATH"
    chmod 0600 "$LOCK_PATH"
    if [[ -z "$TEST_ROOT" ]]; then chown root:root "$LOCK_PATH"; fi
  fi
  [[ -f "$LOCK_PATH" && ! -L "$LOCK_PATH" ]] || die 'deployment lock is not a regular file'
  local lock_mode lock_uid lock_links expected_uid
  lock_mode="$(stat_value '%a' '%Lp' "$LOCK_PATH")"
  lock_uid="$(stat_value '%u' '%u' "$LOCK_PATH")"
  lock_links="$(stat_value '%h' '%l' "$LOCK_PATH")"
  expected_uid=$EUID
  [[ "$lock_mode" == 600 && "$lock_uid" == "$expected_uid" && "$lock_links" == 1 ]] ||
    die 'deployment lock ownership, mode or link count is unsafe'
  exec 9<>"$LOCK_PATH"
  "$FLOCK_BIN" -n 9 || die 'another Hub deployment operation holds the global lock'
}

stage_release() {
  local archive=$1 checksum=$2 revision=$3
  validate_revision "$revision"
  verify_archive "$archive" "$checksum"
  local destination="$RELEASES_ROOT/$revision"
  if [[ -d "$destination" && ! -L "$destination" ]]; then
    local installed_checksum
    installed_checksum="$(/bin/cat -- "$destination/.artifact.sha256" 2>/dev/null || true)"
    [[ "$installed_checksum" == "$(printf '%s' "$checksum" | tr 'A-F' 'a-f')" ]] ||
      die 'release revision already exists with a different artifact'
    "$NODE_BIN" "$ADMIN_ROOT/bin/verify-release.mjs" "$destination"
    return 0
  fi
  [[ ! -e "$destination" && ! -L "$destination" ]] || die 'release revision path is unsafe'

  ARTIFACT_COPY="$RELEASES_ROOT/.artifact-${revision}-$$.tar.gz"
  [[ ! -e "$ARTIFACT_COPY" && ! -L "$ARTIFACT_COPY" ]] ||
    die 'artifact staging path already exists'
  "$NODE_BIN" "$ADMIN_ROOT/bin/copy-artifact.mjs" "$archive" "$ARTIFACT_COPY"
  verify_archive "$ARTIFACT_COPY" "$checksum"

  STAGING_PATH="$RELEASES_ROOT/.staging-${revision}-$$"
  [[ ! -e "$STAGING_PATH" ]] || die 'staging path already exists'
  install_directory 0700 root root "$STAGING_PATH"
  "$NODE_BIN" "$ADMIN_ROOT/bin/extract-release.mjs" "$ARTIFACT_COPY" "$STAGING_PATH"
  "$NODE_BIN" "$ADMIN_ROOT/bin/verify-release.mjs" "$STAGING_PATH"
  "$NODE_BIN" --check "$STAGING_PATH/apps/chat-spike/src/server.mjs" >/dev/null
  printf '%s\n' "$(printf '%s' "$checksum" | tr 'A-F' 'a-f')" >"$STAGING_PATH/.artifact.sha256"

  find "$STAGING_PATH" -type d -exec chmod 0555 {} +
  find "$STAGING_PATH" -type f -exec chmod 0444 {} +
  if [[ -z "$TEST_ROOT" ]]; then chown -hR root:root "$STAGING_PATH"; fi
  mv "$STAGING_PATH" "$destination"
  fsync_path "$RELEASES_ROOT"
  STAGING_PATH=
  rm -f -- "$ARTIFACT_COPY"
  ARTIFACT_COPY=
  notice stage_release ok
}

cleanup_staging() {
  if [[ -n "${STAGING_PATH:-}" ]]; then
    [[ "$(dirname -- "$STAGING_PATH")" == "$RELEASES_ROOT" ]] || {
      printf '%s\n' 'refusing staging cleanup outside the release root' >&2
      return 1
    }
    case "$(basename -- "$STAGING_PATH")" in
      .staging-*) ;;
      *)
        printf '%s\n' 'refusing staging cleanup for an unowned directory name' >&2
        return 1
        ;;
    esac
    if [[ -e "$STAGING_PATH" ]]; then
      find "$STAGING_PATH" -type d -exec chmod u+rwx {} + || return 1
      find "$STAGING_PATH" -type f -exec chmod u+rw {} + || return 1
      rm -rf -- "$STAGING_PATH" || return 1
    fi
    [[ ! -e "$STAGING_PATH" ]] || return 1
    STAGING_PATH=
  fi

  if [[ -n "${ARTIFACT_COPY:-}" ]]; then
    [[ "$(dirname -- "$ARTIFACT_COPY")" == "$RELEASES_ROOT" ]] || {
      printf '%s\n' 'refusing artifact cleanup outside the release root' >&2
      return 1
    }
    case "$(basename -- "$ARTIFACT_COPY")" in
      .artifact-*.tar.gz) ;;
      *)
        printf '%s\n' 'refusing artifact cleanup for an unowned filename' >&2
        return 1
        ;;
    esac
    rm -f -- "$ARTIFACT_COPY" || return 1
    [[ ! -e "$ARTIFACT_COPY" ]] || return 1
    ARTIFACT_COPY=
  fi
}

link_revision() {
  local link=$1 revision=$2 temporary
  validate_revision "$revision"
  [[ -d "$RELEASES_ROOT/$revision" && ! -L "$RELEASES_ROOT/$revision" ]] ||
    die 'requested release is not installed'
  [[ ! -e "$link" || -L "$link" ]] || die 'release pointer is not a symbolic link'
  temporary="${link}.$$.$RANDOM.tmp"
  ln -s "releases/$revision" "$temporary"
  if ! "$NODE_BIN" -e \
    'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
    "$temporary" "$link"; then
    rm -f -- "$temporary"
    die 'atomic release pointer replacement failed'
  fi
  fsync_path "$OPT_ROOT"
}

remove_revision_link() {
  local link=$1
  [[ ! -e "$link" || -L "$link" ]] || die 'release pointer is not a symbolic link'
  if [[ -L "$link" ]]; then
    rm -f -- "$link"
    fsync_path "$OPT_ROOT"
  fi
  return 0
}

read_revision_link() {
  local link=$1 target
  [[ -L "$link" ]] || return 1
  target="$(readlink "$link")"
  [[ "$target" =~ ^releases/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$ ]] ||
    die 'release pointer target is invalid'
  printf '%s\n' "${BASH_REMATCH[1]}"
}

activate_revision() {
  local next=$1
  link_revision "$CURRENT_LINK" "$next"
  notice activate_release ok
}

record_previous_revision() {
  local revision=${1:-}
  if [[ -n "$revision" ]]; then
    link_revision "$PREVIOUS_LINK" "$revision"
  else
    remove_revision_link "$PREVIOUS_LINK"
  fi
}

quarantine_release() {
  local revision=$1 destination
  validate_revision "$revision"
  [[ "$(read_revision_link "$CURRENT_LINK" 2>/dev/null || true)" != "$revision" ]] ||
    die 'refusing to quarantine the active release'
  [[ "$(read_revision_link "$PREVIOUS_LINK" 2>/dev/null || true)" != "$revision" ]] ||
    die 'refusing to quarantine the recorded previous release'
  [[ -d "$RELEASES_ROOT/$revision" && ! -L "$RELEASES_ROOT/$revision" ]] || return 0
  destination="$QUARANTINE_ROOT/${revision}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  [[ ! -e "$destination" && ! -L "$destination" ]] || die 'quarantine destination already exists'
  chmod u+w "$RELEASES_ROOT/$revision"
  if ! mv "$RELEASES_ROOT/$revision" "$destination"; then
    chmod u-w "$RELEASES_ROOT/$revision" >/dev/null 2>&1 || true
    return 1
  fi
  fsync_path "$RELEASES_ROOT"
  fsync_path "$QUARANTINE_ROOT"
  chmod u-w "$destination"
  notice quarantine_release ok
}

service_control() {
  "$SYSTEMCTL_BIN" "$@"
}

service_unit_is_inactive() {
  local unit=$1 pid active_state
  pid="$(service_control show --property=MainPID --value "$unit" 2>/dev/null)" ||
    return 1
  active_state="$(
    service_control show --property=ActiveState --value "$unit" 2>/dev/null
  )" || return 1
  [[ "$pid" == 0 && "$active_state" == inactive ]]
}

# systemd may garbage-collect a clean inactive unit even though its audited
# fragment is present. In that state a unit-scoped reset-failed returns
# "not loaded". Continue only after an independent, strict inactive/MainPID=0
# proof; a genuinely failed, transitioning or uninspectable unit still stops
# the operation.
reset_failed_or_prove_inactive() {
  local unit=$1
  if service_control reset-failed "$unit"; then
    return 0
  fi
  service_unit_is_inactive "$unit"
}

service_is_inactive() {
  service_unit_is_inactive "$SERVICE_NAME"
}

stop_and_prove_writer_stopped_for_path() {
  local inspection_root=$1
  local expected_control_group="/system.slice/$SERVICE_NAME" observed_control_group= service_uid=
  local -a proc_arguments=()
  [[ "$inspection_root" == /* && -d "$inspection_root" && ! -L "$inspection_root" ]] ||
    return 1
  service_uid="$($ID_BIN -u "$SERVICE_USER" 2>/dev/null)" || return 1
  [[ "$service_uid" =~ ^(0|[1-9][0-9]*)$ && "$service_uid" != 0 ]] || return 1
  if ((${#service_uid} > 10)) || ((service_uid > 4294967295)); then
    return 1
  fi
  if service_control is-active --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    observed_control_group="$(
      service_control show --property=ControlGroup --value "$SERVICE_NAME" 2>/dev/null
    )" || return 1
    [[ "$observed_control_group" == "$expected_control_group" ]] || return 1
  fi
  service_control stop "$SERVICE_NAME" || return 1
  service_is_inactive || return 1
  if [[ -n "$TEST_ROOT" ]]; then
    proc_arguments=(
      --proc-root "$TEST_ROOT/proc"
      --cgroup-root "$TEST_ROOT/cgroup"
      --inspector-pid 999
    )
  fi
  "$NODE_BIN" "$ADMIN_ROOT/bin/state-open-files.mjs" \
    "$inspection_root" \
    --forbidden-cgroup "$expected_control_group" \
    --service-uid "$service_uid" \
    --unit-inactive-proof inactive-mainpid0 \
    "${proc_arguments[@]}" >/dev/null || return 1
}

stop_and_prove_writer_stopped() {
  stop_and_prove_writer_stopped_for_path "$STATE_ROOT"
}

service_is_disabled() {
  local status
  if service_control is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    return 1
  else
    status=$?
  fi
  [[ "$status" == 1 || "$status" == 4 ]]
}

service_is_strictly_disabled() {
  local status
  if service_control is-enabled --quiet "$SERVICE_NAME" >/dev/null 2>&1; then
    return 1
  else
    status=$?
  fi
  [[ "$status" == 1 ]]
}

health_gate() {
  local probe=$1 unit=${2:-$SERVICE_NAME} config=${3:-$ENV_FILE} candidate=${4:-}
  if [[ -n "$candidate" ]]; then
    AGENT_OS_NODE_BIN="$NODE_BIN" \
      AGENT_OS_SYSTEMCTL_BIN="$SYSTEMCTL_BIN" \
      AGENT_OS_SS_BIN="$SS_BIN" \
      "$ADMIN_ROOT/bin/health-check.sh" \
        --config "$config" \
        --unit "$unit" \
        --candidate "$candidate" \
        "--$probe" \
        --attempts "$HEALTH_ATTEMPTS" \
        --interval "$HEALTH_INTERVAL"
  else
    AGENT_OS_NODE_BIN="$NODE_BIN" \
      AGENT_OS_SYSTEMCTL_BIN="$SYSTEMCTL_BIN" \
      AGENT_OS_SS_BIN="$SS_BIN" \
      "$ADMIN_ROOT/bin/health-check.sh" \
        --config "$config" \
        --unit "$unit" \
        "--$probe" \
        --attempts "$HEALTH_ATTEMPTS" \
        --interval "$HEALTH_INTERVAL"
  fi
}

service_enable() {
  service_control enable "$SERVICE_NAME"
  service_control is-enabled --quiet "$SERVICE_NAME" ||
    die 'Hub service is not enabled after activation'
}

create_normal_maintenance_sentinel() {
  [[ ! -L "$MAINTENANCE_PATH" ]] || die 'maintenance sentinel must not be a symbolic link'
  if [[ ! -e "$MAINTENANCE_PATH" ]]; then
    umask 077
    : >"$MAINTENANCE_PATH"
    chmod 0444 "$MAINTENANCE_PATH"
    if [[ -z "$TEST_ROOT" ]]; then chown root:root "$MAINTENANCE_PATH"; fi
  fi
  [[ -f "$MAINTENANCE_PATH" && ! -L "$MAINTENANCE_PATH" ]] ||
    die 'maintenance sentinel is not a regular file'
  notice maintenance enabled
}

maintenance_on() {
  [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
    die 'a persistent recovery block requires explicit state restore'
  [[ ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" ]] ||
    die 'an existing hard-maintenance state requires explicit restore before deployment'
  create_normal_maintenance_sentinel
}

maintenance_on_for_recovery() {
  [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
    die 'state restore requires a persistent recovery block'
  create_normal_maintenance_sentinel
}

require_no_unfinished_admin_migration() {
  local latest
  local -a migrations=() temporaries=()
  [[ -d "$RECOVERY_ROOT" && ! -L "$RECOVERY_ROOT" ]] || return 0
  shopt -s nullglob
  temporaries=("$RECOVERY_ROOT"/.upgrade-admin-migration-*.tmp)
  migrations=("$RECOVERY_ROOT"/upgrade-admin-migration-*)
  shopt -u nullglob
  ((${#temporaries[@]} == 0)) ||
    die 'an interrupted admin migration intent requires explicit bootstrap recovery'
  ((${#migrations[@]} > 0)) || return 0
  scan_admin_migration_attempts "$LEGACY_ADMIN_PRODUCTION_SHA256" false
  latest=$ADMIN_MIGRATION_SCAN_MAX_ATTEMPT
  ((latest > 0)) || die 'admin migration history disappeared during validation'
  [[ -e "$ADMIN_MIGRATION_ROOT/finalized" ]] ||
    die 'an unfinished admin migration requires explicit bootstrap recovery'
}

require_clean_maintenance_state() {
  require_no_unfinished_admin_migration
  [[ ! -e "$MAINTENANCE_PATH" && ! -L "$MAINTENANCE_PATH" ]] ||
    die 'an existing maintenance state requires explicit recovery before deployment'
  [[ ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" ]] ||
    die 'an existing hard-maintenance state requires explicit state restore before deployment'
  [[ ! -e "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
    die 'a persistent recovery block requires explicit state restore before deployment'
}

fsync_path() {
  "$NODE_BIN" -e \
    'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }' \
    "$1"
}

DURABLE_BLOCK_TRANSACTION=
DURABLE_RECOVERY_ACTIVE=false

durable_recovery_on() {
  local reason=${1:-operation-incomplete} phase=${2:-blocked}
  local requested_transaction=${3:-} record temporary marker_temp expected_uid record_id block_value
  [[ "$reason" =~ ^[A-Za-z0-9._-]{1,64}$ && "$phase" =~ ^[A-Za-z0-9._-]{1,64}$ ]] ||
    die 'recovery record reason or phase is invalid'
  if [[ -z "$requested_transaction" ]]; then
    requested_transaction="recovery-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  fi
  [[ "$requested_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'recovery transaction id is invalid'
  install_durable_directory 0755 root root "$OPS_ROOT"
  install_durable_directory 0700 root root "$RECOVERY_ROOT"
  # Publish the public stop-condition before its private audit record. A crash
  # between the two remains fail closed instead of losing the reboot gate.
  if [[ ! -e "$DURABLE_BLOCK_PATH" ]]; then
    marker_temp="$OPS_ROOT/.hub-block-$$-${RANDOM}.tmp"
    [[ ! -e "$marker_temp" && ! -L "$marker_temp" ]] ||
      die 'persistent recovery block staging path already exists'
    printf 'agent-os-hub-recovery-block-v1:%s\n' "$requested_transaction" >"$marker_temp"
    chmod 0444 "$marker_temp"
    if [[ -z "$TEST_ROOT" ]]; then chown root:root "$marker_temp"; fi
    fsync_path "$marker_temp"
    mv "$marker_temp" "$DURABLE_BLOCK_PATH"
    fsync_path "$OPS_ROOT"
  fi
  [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
    die 'persistent recovery block is unsafe'
  expected_uid=$EUID
  [[ "$(stat_value '%u' '%u' "$DURABLE_BLOCK_PATH")" == "$expected_uid" && \
    "$(stat_value '%a' '%Lp' "$DURABLE_BLOCK_PATH")" == 444 && \
    "$(stat_value '%h' '%l' "$DURABLE_BLOCK_PATH")" == 1 ]] ||
    die 'persistent recovery block ownership, mode or link count is unsafe'
  block_value="$(<"$DURABLE_BLOCK_PATH")"
  [[ "$block_value" =~ ^agent-os-hub-recovery-block-v1:((backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128})$ ]] ||
    die 'persistent recovery block content is invalid'
  DURABLE_BLOCK_TRANSACTION="${BASH_REMATCH[1]}"
  [[ "$DURABLE_BLOCK_TRANSACTION" == "$requested_transaction" ]] ||
    die 'persistent recovery block does not match the requested transaction'
  DURABLE_RECOVERY_ACTIVE=true

  record_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
  record="$RECOVERY_ROOT/$record_id.record"
  temporary="$RECOVERY_ROOT/.$record_id.tmp"
  [[ ! -e "$record" && ! -L "$record" && ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'recovery record destination already exists'
  umask 077
  {
    printf '%s\n' 'version=1'
    printf 'id=%s\n' "$record_id"
    printf 'reason=%s\n' "$reason"
    printf 'phase=%s\n' "$phase"
    printf 'operation=%s\n' "$requested_transaction"
    printf 'block=%s\n' "$DURABLE_BLOCK_TRANSACTION"
  } >"$temporary"
  chmod 0400 "$temporary"
  if [[ -z "$TEST_ROOT" ]]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv "$temporary" "$record"
  fsync_path "$RECOVERY_ROOT"
  notice durable_recovery enabled
}

chain_recovery_block_to_restore() {
  local parent_transaction=$1 restore_transaction=$2 temporary expected_uid=$EUID
  [[ "$parent_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ && \
    "$restore_transaction" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'recovery block chain transaction is invalid'
  validate_restore_journal "$restore_transaction" ||
    die 'restore journal is invalid before recovery block chaining'
  [[ "$RESTORE_PARENT_TRANSACTION" == "$parent_transaction" ]] ||
    die 'restore journal parent does not match the recovery block chain'
  [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
    "$(<"$DURABLE_BLOCK_PATH")" == \
      "agent-os-hub-recovery-block-v1:$parent_transaction" && \
    "$(stat_value '%u' '%u' "$DURABLE_BLOCK_PATH")" == "$expected_uid" && \
    "$(stat_value '%a' '%Lp' "$DURABLE_BLOCK_PATH")" == 444 && \
    "$(stat_value '%h' '%l' "$DURABLE_BLOCK_PATH")" == 1 ]] ||
    die 'parent recovery block is unsafe or changed before chaining'
  [[ ! -e "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]] ||
    die 'recovery block chaining refuses an active start token'
  temporary="$OPS_ROOT/.hub-block-chain-$$-${RANDOM}.tmp"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'recovery block chain staging path already exists'
  printf 'agent-os-hub-recovery-block-v1:%s\n' "$restore_transaction" >"$temporary"
  chmod 0444 "$temporary"
  if [[ -z "$TEST_ROOT" ]]; then chown root:root "$temporary"; fi
  fsync_path "$temporary"
  mv "$temporary" "$DURABLE_BLOCK_PATH"
  fsync_path "$OPS_ROOT"
  DURABLE_BLOCK_TRANSACTION=$restore_transaction
  durable_recovery_on state-restore chained "$restore_transaction"
}

authorize_recovery_start() {
  local transaction_id=$1 temporary trace transaction_sha256 token_sha256
  [[ "$transaction_id" =~ ^((backup|restore|rollback|upgrade)-[A-Za-z0-9._-]{1,128}|recovery-pre-[A-Za-z0-9._-]{1,124})$ ]] ||
    die 'recovery start transaction id is invalid'
  [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" ]] ||
    die 'recovery start requires a persistent recovery block'
  [[ "$(<"$DURABLE_BLOCK_PATH")" == "agent-os-hub-recovery-block-v1:$transaction_id" ]] ||
    die 'recovery start transaction does not match the persistent block'
  [[ ! -e "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]] ||
    die 'recovery start token already exists'
  temporary="$RUNTIME_ROOT/.hub-recovery-start-$$-${RANDOM}.tmp"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'recovery start token staging path already exists'
  umask 077
  if ! printf '%s\n' "$transaction_id" >"$temporary"; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    die 'recovery start token staging write failed'
  fi
  if ! chmod 0400 "$temporary"; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    die 'recovery start token staging mode failed'
  fi
  if [[ -z "$TEST_ROOT" ]] && ! chown root:root "$temporary"; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    die 'recovery start token staging ownership failed'
  fi
  if ! fsync_path "$temporary"; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    die 'recovery start token staging durability failed'
  fi
  if [[ -e "$RECOVERY_START_PATH" || -L "$RECOVERY_START_PATH" ]]; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    die 'recovery start token appeared during publish'
  fi
  if ! mv "$temporary" "$RECOVERY_START_PATH"; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    die 'recovery start token publish failed'
  fi
  if ! fsync_path "$RUNTIME_ROOT"; then
    die 'recovery start token directory durability failed'
  fi
  trace=${AGENT_OS_MOCK_RESTORE_TOKEN_TRACE:-}
  if [[ -n "$trace" ]]; then
    [[ -n "$TEST_ROOT" && "$trace" == "$TEST_ROOT"/* && \
      -f "$trace" && ! -L "$trace" && \
      "$(stat_value '%u' '%u' "$trace")" == "$EUID" && \
      "$(stat_value '%a' '%Lp' "$trace")" == 600 && \
      "$(stat_value '%h' '%l' "$trace")" == 1 ]] ||
      die 'recovery token trace fixture is unsafe'
    transaction_sha256="$(
      "$NODE_BIN" -e \
        'const c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(process.argv[1]).digest("hex"))' \
        "$transaction_id"
    )" || die 'recovery token transaction trace hashing failed'
    token_sha256="$(
      "$NODE_BIN" -e \
        'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
        "$RECOVERY_START_PATH"
    )" || die 'recovery token value trace hashing failed'
    call_label=${AGENT_OS_MOCK_RESTORE_TOKEN_CALL_LABEL:-unlabeled}
    [[ "$call_label" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] ||
      die 'recovery token trace call label is unsafe'
    printf 'stage=authorize-published call_label=%s pid=%s ppid=%s transaction_sha256=%s type=%s uid=%s gid=%s mode=%s links=%s value_sha256=%s\n' \
      "$call_label" "$$" "$PPID" "$transaction_sha256" \
      "$(stat_value '%F' '%HT' "$RECOVERY_START_PATH")" \
      "$(stat_value '%u' '%u' "$RECOVERY_START_PATH")" \
      "$(stat_value '%g' '%g' "$RECOVERY_START_PATH")" \
      "$(stat_value '%a' '%Lp' "$RECOVERY_START_PATH")" \
      "$(stat_value '%h' '%l' "$RECOVERY_START_PATH")" \
      "$token_sha256" >>"$trace"
  fi
}

validate_or_create_recovery_start_token() {
  local transaction_id=$1 expected_uid=$EUID token_owner token_mode token_links
  [[ "$transaction_id" =~ ^((backup|restore|rollback|upgrade)-[A-Za-z0-9._-]{1,128}|recovery-pre-[A-Za-z0-9._-]{1,124})$ ]] ||
    return 1
  [[ -f "$DURABLE_BLOCK_PATH" && ! -L "$DURABLE_BLOCK_PATH" && \
    "$(<"$DURABLE_BLOCK_PATH")" == "agent-os-hub-recovery-block-v1:$transaction_id" ]] ||
    return 1
  if [[ -e "$RECOVERY_START_PATH" || -L "$RECOVERY_START_PATH" ]]; then
    [[ -f "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]] || return 1
    token_owner="$(stat_value '%u' '%u' "$RECOVERY_START_PATH")" || return 1
    token_mode="$(stat_value '%a' '%Lp' "$RECOVERY_START_PATH")" || return 1
    token_links="$(stat_value '%h' '%l' "$RECOVERY_START_PATH")" || return 1
    [[ "$token_owner" == "$expected_uid" && "$token_mode" == 400 && \
      "$token_links" == 1 && "$(<"$RECOVERY_START_PATH")" == "$transaction_id" ]]
    return
  fi
  authorize_recovery_start "$transaction_id"
}

start_authorized_recovery_service() {
  local transaction_id=$1
  stop_and_prove_writer_stopped || return 1
  require_installed_runtime_contract
  reset_failed_or_prove_inactive "$SERVICE_NAME" || return 1
  validate_or_create_recovery_start_token "$transaction_id" || return 1
  service_control start "$SERVICE_NAME" || return 1
  require_recovery_token_consumed
}

require_recovery_token_consumed() {
  [[ ! -e "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]] ||
    die 'Hub start did not consume its one-time recovery token'
}

write_restore_journal_temporary() {
  local path=$1 body=$2
  local expected_uid=$EUID expected_gid
  expected_gid="$($ID_BIN -g)" || die 'restore journal group identity is unavailable'
  [[ "$path" == "$RECOVERY_ROOT"/restore-*'/.'*.tmp ]] ||
    die 'restore journal temporary path is invalid'
  if [[ -z "$TEST_ROOT" ]]; then
    ((EUID == 0)) && [[ "$expected_gid" == 0 ]] ||
      die 'restore journal publication requires root:root'
  fi
  [[ ! -e "$path" && ! -L "$path" ]] ||
    die 'restore journal temporary already exists'
  # Open and write in a subshell so its descriptor cannot replace fd 9, which
  # the parent process holds for the lifetime of the deployment flock. A 0377
  # umask makes the inode 0400 from its first visible instant while the already
  # open descriptor remains writable on Bash 3.2 and newer.
  if ! (
    umask 0377
    set -C
    exec 9>"$path"
    printf '%s' "$body" >&9
    exec 9>&-
  ) 2>/dev/null; then
    die 'restore journal temporary creation or write failed'
  fi
  [[ -f "$path" && ! -L "$path" && \
    "$(stat_value '%u' '%u' "$path")" == "$expected_uid" && \
    "$(stat_value '%g' '%g' "$path")" == "$expected_gid" && \
    "$(stat_value '%a' '%Lp' "$path")" == 400 && \
    "$(stat_value '%h' '%l' "$path")" == 1 ]] ||
    die 'restore journal temporary ownership, mode or link count is unsafe'
  fsync_path "$path"
}

cleanup_restore_journal_temporaries() {
  local transaction_id=$1 transaction_root entry name expected_uid=$EUID expected_gid
  local removed=false
  local -a entries=()
  expected_gid="$($ID_BIN -g)" || die 'restore journal group identity is unavailable'
  [[ "$transaction_id" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'restore transaction id is invalid during temporary cleanup'
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  [[ -d "$transaction_root" && ! -L "$transaction_root" ]] || return 0
  shopt -s nullglob dotglob
  entries=("$transaction_root"/.*.tmp)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    name=${entry##*/}
    [[ "$name" =~ ^\.(intent|metadata|aborted|prepared|staged|old_moved|new_activated|verified|committed|rolled_back)-[0-9]+-[0-9]+\.tmp$ ]] ||
      die 'restore journal contains an unrecognized temporary'
    [[ -f "$entry" && ! -L "$entry" && \
      "$(stat_value '%u' '%u' "$entry")" == "$expected_uid" && \
      "$(stat_value '%g' '%g' "$entry")" == "$expected_gid" && \
      "$(stat_value '%a' '%Lp' "$entry")" == 400 && \
      "$(stat_value '%h' '%l' "$entry")" == 1 ]] ||
      die 'restore journal temporary ownership, mode or link count is unsafe'
    rm -f -- "$entry"
    removed=true
  done
  if [[ "$removed" == true ]]; then fsync_path "$transaction_root"; fi
}

record_restore_intent() {
  local transaction_id=$1 target_snapshot=$2 target_digest=$3 target_tree=$4
  local parent_transaction=$5 transaction_root intent temporary body
  [[ "$transaction_id" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'restore transaction id is invalid'
  validate_revision "$target_snapshot"
  validate_checksum "$target_digest"
  validate_checksum "$target_tree"
  [[ "$parent_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'restore intent parent transaction is invalid'
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  intent="$transaction_root/intent"
  temporary="$transaction_root/.intent-$$-${RANDOM}.tmp"
  [[ ! -e "$transaction_root" && ! -L "$transaction_root" ]] ||
    die 'restore transaction journal root already exists'
  install_directory 0700 root root "$transaction_root"
  fsync_path "$RECOVERY_ROOT"
  printf -v body \
    'version=1\ntransaction=%s\ntarget_snapshot=%s\ntarget_manifest_sha256=%s\ntarget_tree_sha256=%s\nparent_transaction=%s\n' \
    "$transaction_id" \
    "$target_snapshot" \
    "${target_digest,,}" \
    "${target_tree,,}" \
    "$parent_transaction"
  write_restore_journal_temporary "$temporary" "$body"
  mv "$temporary" "$intent"
  fsync_path "$transaction_root"
  notice restore_intent recorded
}

load_restore_intent() {
  local transaction_id=$1 transaction_root intent expected_uid=$EUID key value
  [[ "$transaction_id" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] || return 1
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  intent="$transaction_root/intent"
  [[ -d "$transaction_root" && ! -L "$transaction_root" && \
    -f "$intent" && ! -L "$intent" && \
    "$(stat_value '%u' '%u' "$transaction_root")" == "$expected_uid" && \
    "$(stat_value '%a' '%Lp' "$transaction_root")" == 700 && \
    "$(stat_value '%u' '%u' "$intent")" == "$expected_uid" && \
    "$(stat_value '%a' '%Lp' "$intent")" == 400 && \
    "$(stat_value '%h' '%l' "$intent")" == 1 ]] || return 1
  RESTORE_INTENT_VERSION=
  RESTORE_INTENT_TRANSACTION=
  RESTORE_INTENT_TARGET=
  RESTORE_INTENT_TARGET_DIGEST=
  RESTORE_INTENT_TARGET_TREE=
  RESTORE_INTENT_PARENT=
  while IFS='=' read -r key value; do
    [[ -n "$key" && -n "$value" ]] || return 1
    case "$key" in
      version) [[ -z "$RESTORE_INTENT_VERSION" ]] || return 1; RESTORE_INTENT_VERSION=$value ;;
      transaction) [[ -z "$RESTORE_INTENT_TRANSACTION" ]] || return 1; RESTORE_INTENT_TRANSACTION=$value ;;
      target_snapshot) [[ -z "$RESTORE_INTENT_TARGET" ]] || return 1; RESTORE_INTENT_TARGET=$value ;;
      target_manifest_sha256) [[ -z "$RESTORE_INTENT_TARGET_DIGEST" ]] || return 1; RESTORE_INTENT_TARGET_DIGEST=$value ;;
      target_tree_sha256) [[ -z "$RESTORE_INTENT_TARGET_TREE" ]] || return 1; RESTORE_INTENT_TARGET_TREE=$value ;;
      parent_transaction) [[ -z "$RESTORE_INTENT_PARENT" ]] || return 1; RESTORE_INTENT_PARENT=$value ;;
      *) return 1 ;;
    esac
  done <"$intent"
  [[ "$RESTORE_INTENT_VERSION" == 1 && \
    "$RESTORE_INTENT_TRANSACTION" == "$transaction_id" && \
    "$RESTORE_INTENT_TARGET" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && \
    "$RESTORE_INTENT_TARGET_DIGEST" =~ ^[A-Fa-f0-9]{64}$ && \
    "$RESTORE_INTENT_TARGET_TREE" =~ ^[A-Fa-f0-9]{64}$ && \
    "$RESTORE_INTENT_PARENT" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]]
}

validate_restore_orphan_intent() {
  local transaction_id=$1 transaction_root entry name expected_uid=$EUID
  local -a entries=()
  load_restore_intent "$transaction_id" || return 1
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  [[ ! -e "$transaction_root/metadata" && ! -L "$transaction_root/metadata" ]] ||
    return 1
  shopt -s nullglob dotglob
  entries=("$transaction_root"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    name=${entry##*/}
    case "$name" in intent | aborted) ;; *) return 1 ;; esac
    [[ -f "$entry" && ! -L "$entry" && \
      "$(stat_value '%u' '%u' "$entry")" == "$expected_uid" && \
      "$(stat_value '%a' '%Lp' "$entry")" == 400 && \
      "$(stat_value '%h' '%l' "$entry")" == 1 ]] || return 1
  done
  if [[ -e "$transaction_root/aborted" ]]; then
    [[ "$(<"$transaction_root/aborted")" == \
      $'version=1\n'"transaction=$transaction_id"$'\nphase=aborted' ]] || return 1
  fi
}

record_restore_intent_aborted() {
  local transaction_id=$1 transaction_root aborted temporary body
  validate_restore_orphan_intent "$transaction_id" ||
    die 'restore orphan intent is invalid'
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  aborted="$transaction_root/aborted"
  temporary="$transaction_root/.aborted-$$-${RANDOM}.tmp"
  [[ ! -e "$aborted" && ! -L "$aborted" && \
    ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'restore orphan abort record already exists'
  printf -v body 'version=1\ntransaction=%s\nphase=aborted\n' "$transaction_id"
  write_restore_journal_temporary "$temporary" "$body"
  mv "$temporary" "$aborted"
  fsync_path "$transaction_root"
}

record_restore_metadata() {
  local transaction_id=$1 target_snapshot=$2 target_digest=$3 target_tree=$4
  local preserved_snapshot=$5 preserved_digest=$6 preserved_tree=$7 preserved_state=$8
  local parent_transaction=${9:-none}
  local preservation_mode=${10:-strict}
  local transaction_root metadata temporary body
  [[ "$transaction_id" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'restore transaction id is invalid'
  validate_revision "$target_snapshot"
  validate_revision "$preserved_snapshot"
  validate_checksum "$target_digest"
  validate_checksum "$target_tree"
  validate_checksum "$preserved_digest"
  validate_checksum "$preserved_tree"
  validate_checksum "$preserved_state"
  [[ "$parent_transaction" == none || \
    "$parent_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'restore parent transaction is invalid'
  [[ "$preservation_mode" == strict || "$preservation_mode" == forensic ]] ||
    die 'restore preservation mode is invalid'
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  metadata="$transaction_root/metadata"
  temporary="$transaction_root/.metadata-$$-${RANDOM}.tmp"
  load_restore_intent "$transaction_id" || die 'restore intent is invalid or missing'
  [[ "$RESTORE_INTENT_TARGET" == "$target_snapshot" && \
    "${RESTORE_INTENT_TARGET_DIGEST,,}" == "${target_digest,,}" && \
    "${RESTORE_INTENT_TARGET_TREE,,}" == "${target_tree,,}" && \
    "$RESTORE_INTENT_PARENT" == "$parent_transaction" ]] ||
    die 'restore metadata does not match the durable intent'
  [[ -d "$transaction_root" && ! -L "$transaction_root" && \
    ! -e "$metadata" && ! -L "$metadata" && \
    ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'restore transaction metadata path already exists'
  printf -v body \
    'version=1\ntransaction=%s\ntarget_snapshot=%s\ntarget_manifest_sha256=%s\ntarget_tree_sha256=%s\npreserved_snapshot=%s\npreserved_manifest_sha256=%s\npreserved_tree_sha256=%s\npreserved_state_sha256=%s\nparent_transaction=%s\npreservation_mode=%s\n' \
    "$transaction_id" \
    "$target_snapshot" \
    "${target_digest,,}" \
    "${target_tree,,}" \
    "$preserved_snapshot" \
    "${preserved_digest,,}" \
    "${preserved_tree,,}" \
    "${preserved_state,,}" \
    "$parent_transaction" \
    "$preservation_mode"
  write_restore_journal_temporary "$temporary" "$body"
  mv "$temporary" "$metadata"
  fsync_path "$transaction_root"
  notice restore_metadata recorded
}

load_restore_metadata() {
  local transaction_id=$1 transaction_root metadata expected_uid=$EUID
  local key value
  [[ "$transaction_id" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] || return 1
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  metadata="$transaction_root/metadata"
  [[ -d "$transaction_root" && ! -L "$transaction_root" && \
    -f "$metadata" && ! -L "$metadata" ]] || return 1
  [[ "$(stat_value '%u' '%u' "$metadata")" == "$expected_uid" && \
    "$(stat_value '%a' '%Lp' "$metadata")" == 400 && \
    "$(stat_value '%h' '%l' "$metadata")" == 1 ]] || return 1
  RESTORE_METADATA_VERSION=
  RESTORE_METADATA_TRANSACTION=
  RESTORE_TARGET_SNAPSHOT=
  RESTORE_TARGET_DIGEST=
  RESTORE_TARGET_TREE=
  RESTORE_PRESERVED_SNAPSHOT=
  RESTORE_PRESERVED_DIGEST=
  RESTORE_PRESERVED_TREE=
  RESTORE_PRESERVED_STATE=
  RESTORE_PARENT_TRANSACTION=
  RESTORE_PRESERVATION_MODE=
  while IFS='=' read -r key value; do
    [[ -n "$key" && -n "$value" ]] || return 1
    case "$key" in
      version) [[ -z "$RESTORE_METADATA_VERSION" ]] || return 1; RESTORE_METADATA_VERSION=$value ;;
      transaction) [[ -z "$RESTORE_METADATA_TRANSACTION" ]] || return 1; RESTORE_METADATA_TRANSACTION=$value ;;
      target_snapshot) [[ -z "$RESTORE_TARGET_SNAPSHOT" ]] || return 1; RESTORE_TARGET_SNAPSHOT=$value ;;
      target_manifest_sha256) [[ -z "$RESTORE_TARGET_DIGEST" ]] || return 1; RESTORE_TARGET_DIGEST=$value ;;
      target_tree_sha256) [[ -z "$RESTORE_TARGET_TREE" ]] || return 1; RESTORE_TARGET_TREE=$value ;;
      preserved_snapshot) [[ -z "$RESTORE_PRESERVED_SNAPSHOT" ]] || return 1; RESTORE_PRESERVED_SNAPSHOT=$value ;;
      preserved_manifest_sha256) [[ -z "$RESTORE_PRESERVED_DIGEST" ]] || return 1; RESTORE_PRESERVED_DIGEST=$value ;;
      preserved_tree_sha256) [[ -z "$RESTORE_PRESERVED_TREE" ]] || return 1; RESTORE_PRESERVED_TREE=$value ;;
      preserved_state_sha256) [[ -z "$RESTORE_PRESERVED_STATE" ]] || return 1; RESTORE_PRESERVED_STATE=$value ;;
      parent_transaction) [[ -z "$RESTORE_PARENT_TRANSACTION" ]] || return 1; RESTORE_PARENT_TRANSACTION=$value ;;
      preservation_mode) [[ -z "$RESTORE_PRESERVATION_MODE" ]] || return 1; RESTORE_PRESERVATION_MODE=$value ;;
      *) return 1 ;;
    esac
  done <"$metadata"
  [[ "$RESTORE_METADATA_VERSION" == 1 && \
    "$RESTORE_METADATA_TRANSACTION" == "$transaction_id" ]] || return 1
  [[ "$RESTORE_TARGET_SNAPSHOT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && \
    "$RESTORE_PRESERVED_SNAPSHOT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && \
    "$RESTORE_TARGET_DIGEST" =~ ^[A-Fa-f0-9]{64}$ && \
    "$RESTORE_TARGET_TREE" =~ ^[A-Fa-f0-9]{64}$ && \
    "$RESTORE_PRESERVED_DIGEST" =~ ^[A-Fa-f0-9]{64}$ && \
    "$RESTORE_PRESERVED_TREE" =~ ^[A-Fa-f0-9]{64}$ && \
    "$RESTORE_PRESERVED_STATE" =~ ^[A-Fa-f0-9]{64}$ && \
    ("$RESTORE_PARENT_TRANSACTION" == none || \
      "$RESTORE_PARENT_TRANSACTION" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$) && \
    ("$RESTORE_PRESERVATION_MODE" == strict || \
      "$RESTORE_PRESERVATION_MODE" == forensic) ]]
}

validate_restore_journal() {
  local transaction_id=$1 transaction_root expected_uid=$EUID entry name
  local phase gap=false
  local -a entries=() phases=(prepared staged old_moved new_activated verified committed)
  load_restore_intent "$transaction_id" || return 1
  load_restore_metadata "$transaction_id" || return 1
  [[ "$RESTORE_TARGET_SNAPSHOT" == "$RESTORE_INTENT_TARGET" && \
    "${RESTORE_TARGET_DIGEST,,}" == "${RESTORE_INTENT_TARGET_DIGEST,,}" && \
    "${RESTORE_TARGET_TREE,,}" == "${RESTORE_INTENT_TARGET_TREE,,}" && \
    "$RESTORE_PARENT_TRANSACTION" == "$RESTORE_INTENT_PARENT" ]] || return 1
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  [[ "$(stat_value '%u' '%u' "$transaction_root")" == "$expected_uid" && \
    "$(stat_value '%a' '%Lp' "$transaction_root")" == 700 ]] || return 1
  shopt -s nullglob dotglob
  entries=("$transaction_root"/*)
  shopt -u nullglob dotglob
  for entry in "${entries[@]}"; do
    name=${entry##*/}
    case "$name" in
      intent | metadata | prepared | staged | old_moved | new_activated | verified | committed | rolled_back | aborted) ;;
      *) return 1 ;;
    esac
    [[ -f "$entry" && ! -L "$entry" && \
      "$(stat_value '%u' '%u' "$entry")" == "$expected_uid" && \
      "$(stat_value '%a' '%Lp' "$entry")" == 400 && \
      "$(stat_value '%h' '%l' "$entry")" == 1 ]] || return 1
    if [[ "$name" != metadata && "$name" != intent ]]; then
      [[ "$(<"$entry")" == \
        $'version=1\n'"transaction=$transaction_id"$'\n'"phase=$name" ]] || return 1
    fi
  done
  for phase in "${phases[@]}"; do
    if [[ -e "$transaction_root/$phase" || -L "$transaction_root/$phase" ]]; then
      [[ "$gap" == false ]] || return 1
    else
      gap=true
    fi
  done
  [[ ! -e "$transaction_root/rolled_back" || ! -e "$transaction_root/committed" ]] ||
    return 1
  [[ ! -e "$transaction_root/rolled_back" || -e "$transaction_root/prepared" ]] ||
    return 1
}

RESTORE_PHASE_DURABLE_TRANSACTION=
RESTORE_PHASE_DURABLE=

record_recovery_phase() {
  local transaction_id=$1 phase=$2 transaction_root phase_path temporary body
  [[ "$transaction_id" =~ ^restore-[A-Za-z0-9._-]{1,128}$ ]] ||
    die 'restore transaction id is invalid'
  case "$phase" in
    prepared | staged | old_moved | new_activated | verified | committed | rolled_back) ;;
    *) die 'restore transaction phase is invalid' ;;
  esac
  transaction_root="$RECOVERY_ROOT/$transaction_id"
  if [[ -e "$transaction_root" || -L "$transaction_root" ]]; then
    [[ -d "$transaction_root" && ! -L "$transaction_root" ]] ||
      die 'restore transaction journal root is unsafe'
  else
    die 'restore transaction metadata must be recorded before a phase'
  fi
  [[ -f "$transaction_root/metadata" && ! -L "$transaction_root/metadata" ]] ||
    die 'restore transaction metadata is missing'
  if [[ "$phase" == rolled_back ]]; then
    [[ -f "$transaction_root/prepared" && ! -L "$transaction_root/prepared" ]] ||
      die 'restore rollback requires a durable prepared phase'
  fi
  phase_path="$transaction_root/$phase"
  temporary="$transaction_root/.$phase-$$-${RANDOM}.tmp"
  [[ ! -e "$phase_path" && ! -L "$phase_path" && \
    ! -e "$temporary" && ! -L "$temporary" ]] ||
    die 'restore transaction phase already exists'
  printf -v body 'version=1\ntransaction=%s\nphase=%s\n' "$transaction_id" "$phase"
  write_restore_journal_temporary "$temporary" "$body"
  mv "$temporary" "$phase_path"
  fsync_path "$transaction_root"
  RESTORE_PHASE_DURABLE_TRANSACTION=$transaction_id
  RESTORE_PHASE_DURABLE=$phase
  notice "restore_$phase" recorded
}

maintenance_fail_closed() {
  durable_recovery_on \
    "${1:-operation-incomplete}" \
    "${2:-blocked}" \
    "${3:-${DURABLE_BLOCK_TRANSACTION:-}}"
  [[ ! -L "$FAIL_CLOSED_PATH" ]] || die 'fail-closed sentinel must not be a symbolic link'
  if [[ ! -e "$FAIL_CLOSED_PATH" ]]; then
    umask 077
    : >"$FAIL_CLOSED_PATH"
    chmod 0444 "$FAIL_CLOSED_PATH"
    if [[ -z "$TEST_ROOT" ]]; then chown root:root "$FAIL_CLOSED_PATH"; fi
  fi
  [[ -f "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" ]] ||
    die 'fail-closed sentinel is not a regular file'
  notice maintenance fail_closed
}

MAINTENANCE_OFF_DURABLE=false

maintenance_off() {
  local expected_uid=$EUID expected_transaction=${1:-${DURABLE_BLOCK_TRANSACTION:-}}
  local block_value=
  MAINTENANCE_OFF_DURABLE=false
  [[ ! -e "$MAINTENANCE_PATH" || -f "$MAINTENANCE_PATH" ]] ||
    die 'maintenance sentinel is not a regular file'
  [[ ! -L "$MAINTENANCE_PATH" ]] || die 'maintenance sentinel must not be a symbolic link'
  [[ ! -e "$FAIL_CLOSED_PATH" || -f "$FAIL_CLOSED_PATH" ]] ||
    die 'fail-closed sentinel is not a regular file'
  [[ ! -L "$FAIL_CLOSED_PATH" ]] || die 'fail-closed sentinel must not be a symbolic link'
  [[ ! -e "$DURABLE_BLOCK_PATH" || -f "$DURABLE_BLOCK_PATH" ]] ||
    die 'persistent recovery block is not a regular file'
  [[ ! -L "$DURABLE_BLOCK_PATH" ]] || die 'persistent recovery block must not be a symbolic link'
  if [[ -e "$DURABLE_BLOCK_PATH" ]]; then
    [[ "$expected_transaction" =~ ^(backup|restore|rollback|upgrade|recovery)-[A-Za-z0-9._-]{1,128}$ ]] ||
      die 'persistent recovery cleanup transaction is missing or invalid'
    [[ "$(stat_value '%u' '%u' "$DURABLE_BLOCK_PATH")" == "$expected_uid" && \
      "$(stat_value '%a' '%Lp' "$DURABLE_BLOCK_PATH")" == 444 && \
      "$(stat_value '%h' '%l' "$DURABLE_BLOCK_PATH")" == 1 ]] ||
      die 'persistent recovery block ownership, mode or link count is unsafe'
    block_value="$(<"$DURABLE_BLOCK_PATH")"
    [[ "$block_value" == \
      "agent-os-hub-recovery-block-v1:$expected_transaction" ]] ||
      die 'persistent recovery block does not match the cleanup transaction'
  fi
  [[ ! -e "$RECOVERY_START_PATH" && ! -L "$RECOVERY_START_PATH" ]] ||
    die 'one-time recovery start token was not consumed'
  # The persistent block is both the Nginx and ExecStartPre stop condition.
  # Remove volatile sentinels first and durably publish that cleanup while the
  # block still keeps every ingress/start path closed. Thus every crash point
  # either retains a resumable block or leaves the fully clean terminal state.
  rm -f -- "$FAIL_CLOSED_PATH"
  rm -f -- "$MAINTENANCE_PATH"
  if [[ -d "$RUNTIME_ROOT" && ! -L "$RUNTIME_ROOT" ]]; then
    if ! fsync_path "$RUNTIME_ROOT"; then
      die 'maintenance runtime cleanup durability failed'
    fi
  fi
  rm -f -- "$DURABLE_BLOCK_PATH"
  if [[ -d "$OPS_ROOT" && ! -L "$OPS_ROOT" ]] && \
    ! fsync_path "$OPS_ROOT"; then
    die 'maintenance persistent-block cleanup durability failed'
  fi
  MAINTENANCE_OFF_DURABLE=true
  notice maintenance disabled || true
  DURABLE_RECOVERY_ACTIVE=false
  DURABLE_BLOCK_TRANSACTION=
}

state_fingerprint() {
  "$NODE_BIN" "$ADMIN_ROOT/bin/state-hash.mjs" "$STATE_ROOT"
}

create_candidate_environment() {
  local revision=$1 output line generated_tokens extra_token
  local runner_token human_token claude_token grok_token kimi_token codex_token
  output="$CANDIDATE_ENV_ROOT/$revision.env"
  validate_revision "$revision"
  [[ ! -e "$output" && ! -L "$output" ]] || die 'candidate environment path already exists'
  install_directory \
    0700 \
    "$CANDIDATE_SERVICE_USER" \
    "$CANDIDATE_SERVICE_GROUP" \
    "$CANDIDATE_STATE_ROOT/$revision"
  generated_tokens="$(
    "$NODE_BIN" -e \
      'const { randomBytes } = require("node:crypto"); console.log(Array.from({ length: 6 }, () => randomBytes(32).toString("base64url")).join(" "));'
  )" || die 'candidate credential generation failed'
  read -r \
    runner_token \
    human_token \
    claude_token \
    grok_token \
    kimi_token \
    codex_token \
    extra_token <<<"$generated_tokens"
  [[ -n "$runner_token" && -n "$human_token" && -n "$claude_token" && \
    -n "$grok_token" && -n "$kimi_token" && -n "$codex_token" && -z "$extra_token" ]] ||
    die 'candidate credential generation failed'
  umask 077
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      PORT=*) printf '%s\n' 'PORT=14173' ;;
      LOG_PATH=*) printf 'LOG_PATH=/var/lib/agent-os/hub-candidates/%s/events.jsonl\n' "$revision" ;;
      AGENT_OS_REMOTE_STATE_PATH=*)
        printf 'AGENT_OS_REMOTE_STATE_PATH=/var/lib/agent-os/hub-candidates/%s/remote-placement.json\n' "$revision"
        ;;
      AGENT_OS_RUNNER_TOKEN=*) printf 'AGENT_OS_RUNNER_TOKEN=%s\n' "$runner_token" ;;
      AGENT_OS_HUMAN_TOKEN=*) printf 'AGENT_OS_HUMAN_TOKEN=%s\n' "$human_token" ;;
      AGENT_OS_AGENT_TOKENS=*)
        printf \
          "AGENT_OS_AGENT_TOKENS='{\"claude\":\"%s\",\"grok\":\"%s\",\"kimi\":\"%s\",\"codex\":\"%s\"}'\n" \
          "$claude_token" \
          "$grok_token" \
          "$kimi_token" \
          "$codex_token"
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$ENV_FILE" >"$output"
  chmod 0600 "$output"
  if [[ -z "$TEST_ROOT" ]]; then chown root:root "$output"; fi
  AGENT_OS_NODE_BIN="$NODE_BIN" \
    "$ADMIN_ROOT/bin/validate-config.sh" --candidate "$revision" "$output"
  printf '%s\n' "$output"
}

cleanup_candidate() {
  local revision=$1 environment unit
  environment="$CANDIDATE_ENV_ROOT/$revision.env"
  unit="${CANDIDATE_SERVICE_PREFIX}${revision}.service"
  validate_revision "$revision"
  service_control stop "$unit" >/dev/null 2>&1 || return 1
  service_unit_is_inactive "$unit" || {
    printf '%s\n' 'candidate cleanup refused: candidate unit is still active' >&2
    return 1
  }
  [[ ! -L "$environment" ]] || die 'candidate environment became a symbolic link'
  rm -f -- "$environment"
  if [[ -e "$CANDIDATE_STATE_ROOT/$revision" ]]; then
    [[ -d "$CANDIDATE_STATE_ROOT/$revision" && ! -L "$CANDIDATE_STATE_ROOT/$revision" ]] ||
      die 'candidate state path is unsafe'
    rm -rf -- "$CANDIDATE_STATE_ROOT/$revision"
  fi
}

candidate_preflight() {
  local revision=$1 environment unit ok=true
  require_candidate_runtime_contract "$revision"
  if ! environment="$(create_candidate_environment "$revision")"; then
    cleanup_candidate "$revision" >/dev/null 2>&1 || true
    return 1
  fi
  unit="${CANDIDATE_SERVICE_PREFIX}${revision}.service"
  if [[ "$ok" == true ]]; then service_control start "$unit" || ok=false; fi
  if [[ "$ok" == true ]] && ! health_gate live "$unit" "$environment" "$revision"; then
    ok=false
  fi
  service_control stop "$unit" >/dev/null 2>&1 || ok=false
  cleanup_candidate "$revision" || ok=false
  [[ "$ok" == true ]]
}

validate_probe() {
  [[ "$1" == live || "$1" == ready ]] || die 'activation probe must be live or ready'
}

validate_snapshot_hook() {
  local hook=$1 expected_uid boundary parent canonical_parent directory
  local mode owner links size
  [[ "$hook" == /* && -f "$hook" && -x "$hook" && ! -L "$hook" ]] ||
    die 'snapshot hook must be an absolute executable regular file'
  parent="$(dirname -- "$hook")"
  canonical_parent="$(CDPATH= cd -- "$parent" && pwd -P)" ||
    die 'snapshot hook parent cannot be canonicalized'
  [[ "$canonical_parent/$(basename -- "$hook")" == "$hook" ]] ||
    die 'snapshot hook path contains a symbolic or non-canonical ancestor'
  expected_uid=$EUID
  mode="$(stat_value '%a' '%Lp' "$hook")"
  owner="$(stat_value '%u' '%u' "$hook")"
  links="$(stat_value '%h' '%l' "$hook")"
  size="$(stat_value '%s' '%z' "$hook")"
  [[ "$owner" == "$expected_uid" && "$links" == 1 ]] ||
    die 'snapshot hook must be a single-link file owned by the deployment account'
  mode_is_safe "$mode" || die 'snapshot hook must not be group/world writable'
  [[ "$size" =~ ^[0-9]+$ ]] && ((size >= 1 && size <= 1024 * 1024)) ||
    die 'snapshot hook size is outside the 1 byte..1 MiB boundary'

  boundary=/
  if [[ -n "$TEST_ROOT" ]]; then
    case "$hook" in
      "$TEST_ROOT"/*) boundary=$TEST_ROOT ;;
      *) die 'test snapshot hook override must stay inside the owned test root' ;;
    esac
  fi
  directory=$canonical_parent
  while :; do
    [[ -d "$directory" && ! -L "$directory" ]] ||
      die 'snapshot hook ancestor is not a real directory'
    canonical_parent="$(CDPATH= cd -- "$directory" && pwd -P)" ||
      die 'snapshot hook ancestor cannot be canonicalized'
    [[ "$canonical_parent" == "$directory" ]] ||
      die 'snapshot hook ancestor contains a symbolic link'
    mode="$(stat_value '%a' '%Lp' "$directory")"
    owner="$(stat_value '%u' '%u' "$directory")"
    [[ "$owner" == "$expected_uid" ]] ||
      die 'snapshot hook ancestors must be owned by the deployment account'
    mode_is_safe "$mode" ||
      die 'snapshot hook ancestors must not be group/world writable'
    [[ "$directory" == "$boundary" ]] && break
    directory="$(dirname -- "$directory")"
    if [[ -n "$TEST_ROOT" ]]; then
      case "$directory" in
        "$TEST_ROOT" | "$TEST_ROOT"/*) ;;
        *) die 'snapshot hook ancestor escaped the owned test root' ;;
      esac
    fi
  done
}

validate_snapshot_hook_copy() {
  local hook=$1 expected_uid expected_gid canonical_parent mode owner group links size
  [[ "$hook" == "$RUNTIME_ROOT"/.snapshot-hook-[0-9]* && -f "$hook" && -r "$hook" && \
    ! -x "$hook" && ! -L "$hook" ]] ||
    die 'private snapshot hook copy is not a readable regular runtime file'
  canonical_parent="$(CDPATH= cd -- "$(dirname -- "$hook")" && pwd -P)" ||
    die 'private snapshot hook copy parent cannot be canonicalized'
  [[ "$canonical_parent" == "$RUNTIME_ROOT" ]] ||
    die 'private snapshot hook copy escaped the runtime root'
  expected_uid="$(admin_contract_uid)" || die 'private snapshot hook owner is unavailable'
  expected_gid="$(admin_contract_gid)" || die 'private snapshot hook group is unavailable'
  mode="$(stat_value '%a' '%Lp' "$hook")"
  owner="$(stat_value '%u' '%u' "$hook")"
  group="$(stat_value '%g' '%g' "$hook")"
  links="$(stat_value '%h' '%l' "$hook")"
  size="$(stat_value '%s' '%z' "$hook")"
  [[ "$mode" == 400 && "$owner" == "$expected_uid" && "$group" == "$expected_gid" && \
    "$links" == 1 ]] ||
    die 'private snapshot hook copy metadata is invalid'
  [[ "$size" =~ ^[0-9]+$ ]] && ((size >= 1 && size <= 1024 * 1024)) ||
    die 'private snapshot hook copy size is outside the 1 byte..1 MiB boundary'
}

prepare_snapshot_hook() {
  local source=$1 copy
  validate_snapshot_hook "$source"
  copy="$RUNTIME_ROOT/.snapshot-hook-$$"
  [[ ! -e "$copy" && ! -L "$copy" ]] || die 'snapshot hook staging path already exists'
  "$NODE_BIN" "$ADMIN_ROOT/bin/copy-artifact.mjs" "$source" "$copy"
  chmod 0400 "$copy"
  if [[ -z "$TEST_ROOT" ]]; then chown root:root "$copy"; fi
  validate_snapshot_hook_copy "$copy"
  SNAPSHOT_HOOK_COPY=$copy
}

cleanup_snapshot_hook_copy() {
  [[ -n "${SNAPSHOT_HOOK_COPY:-}" ]] || return 0
  [[ "$(dirname -- "$SNAPSHOT_HOOK_COPY")" == "$RUNTIME_ROOT" ]] || {
    printf '%s\n' 'refusing snapshot-hook cleanup outside the runtime root' >&2
    return 1
  }
  case "$(basename -- "$SNAPSHOT_HOOK_COPY")" in
    .snapshot-hook-[0-9]*) ;;
    *)
      printf '%s\n' 'refusing snapshot-hook cleanup for an unowned filename' >&2
      return 1
      ;;
  esac
  [[ ! -L "$SNAPSHOT_HOOK_COPY" ]] || return 1
  rm -f -- "$SNAPSHOT_HOOK_COPY" || return 1
  [[ ! -e "$SNAPSHOT_HOOK_COPY" && ! -L "$SNAPSHOT_HOOK_COPY" ]] || return 1
  SNAPSHOT_HOOK_COPY=
}
