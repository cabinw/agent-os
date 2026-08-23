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
  if [[ -n "${!node_influence:-}" ]]; then
    printf 'Hub deployment failed: deployment runtime rejects inherited variable %s\n' \
      "$node_influence" >&2
    exit 1
  fi
done

readonly DEPLOY_LIB_DIR="$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEPLOY_SOURCE_ROOT="$(CDPATH= cd -- "$DEPLOY_LIB_DIR/.." && pwd -P)"
readonly SERVICE_NAME=agent-os-hub.service
readonly CANDIDATE_SERVICE_PREFIX=agent-os-hub-candidate@
readonly SERVICE_USER=agent-os
readonly SERVICE_GROUP=agent-os
readonly CANDIDATE_SERVICE_USER=agent-os-candidate
readonly CANDIDATE_SERVICE_GROUP=agent-os-candidate
readonly EXPECTED_NODE_VERSION=24.19.0
readonly EXPECTED_COREPACK_VERSION=0.35.0
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
readonly UNIT_PATH="$(rooted /etc/systemd/system/agent-os-hub.service)"
readonly CANDIDATE_UNIT_PATH="$(rooted /etc/systemd/system/agent-os-hub-candidate@.service)"
readonly NGINX_EXAMPLE_PATH="$(rooted /etc/nginx/sites-available/agent-os-hub.conf.example)"
readonly NGINX_LIMITS_EXAMPLE_PATH="$(rooted /etc/nginx/conf.d/agent-os-hub-limits.conf.example)"
readonly RUNTIME_ROOT="$(rooted /run/agent-os)"
readonly LOCK_PATH="$RUNTIME_ROOT/hub-deploy.lock"
readonly MAINTENANCE_PATH="$RUNTIME_ROOT/hub-maintenance"
readonly FAIL_CLOSED_PATH="$RUNTIME_ROOT/hub-maintenance-hard"
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
  install_directory 0755 root root "$STATE_PARENT"
  install_directory 0700 "$SERVICE_USER" "$SERVICE_GROUP" "$STATE_ROOT"
  install_directory 0700 root root "$BACKUP_PARENT"
  install_directory 0700 root root "$BACKUP_ROOT"
  ensure_system_directory "$(dirname -- "$UNIT_PATH")"
  ensure_system_directory "$(dirname -- "$NGINX_EXAMPLE_PATH")"
  ensure_system_directory "$(dirname -- "$NGINX_LIMITS_EXAMPLE_PATH")"
  install_directory 0755 root root "$RUNTIME_ROOT"
  install_directory 0700 root root "$CANDIDATE_ENV_ROOT"
  install_directory 0755 root root "$CANDIDATE_STATE_ROOT"
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

verify_admin_kit() {
  local root=$1 name path stat_mode stat_uid directory
  [[ -d "$root" && ! -L "$root" ]] || return 1
  if [[ -z "$TEST_ROOT" ]]; then
    stat_uid="$(stat_value '%u' '%u' "$root")"
    stat_mode="$(stat_value '%a' '%Lp' "$root")"
    [[ "$stat_uid" == 0 ]] || return 1
    mode_is_safe "$stat_mode" || return 1
  fi
  while IFS= read -r name; do
    path="$root/$name"
    [[ -f "$path" && ! -L "$path" ]] || return 1
    if [[ -z "$TEST_ROOT" ]]; then
      directory="$(dirname -- "$path")"
      while [[ "$directory" != "$root" ]]; do
        [[ -d "$directory" && ! -L "$directory" ]] || return 1
        stat_uid="$(stat_value '%u' '%u' "$directory")"
        stat_mode="$(stat_value '%a' '%Lp' "$directory")"
        [[ "$stat_uid" == 0 ]] || return 1
        mode_is_safe "$stat_mode" || return 1
        directory="$(dirname -- "$directory")"
      done
      stat_uid="$(stat_value '%u' '%u' "$path")"
      stat_mode="$(stat_value '%a' '%Lp' "$path")"
      [[ "$stat_uid" == 0 ]] || return 1
      mode_is_safe "$stat_mode" || return 1
    fi
  done < <(admin_files)
}

verify_admin_source() {
  local root=$1 relative path stat_mode stat_uid directory
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
    [[ "$relative" == *.sh ]] && mode=0555
    destination="$staging/$relative"
    install_directory 0700 root root "$(dirname -- "$destination")"
    install_regular_file "$mode" root root "$DEPLOY_SOURCE_ROOT/$relative" "$destination"
  done < <(admin_files)
  if [[ -z "$TEST_ROOT" ]]; then chown -hR root:root "$staging"; fi
  find "$staging" -type d -exec chmod 0555 {} +
  mv "$staging" "$ADMIN_ROOT"
  verify_admin_kit "$ADMIN_ROOT" || die 'installed Hub admin kit failed verification'
}

require_fixed_admin_execution() {
  [[ "$DEPLOY_LIB_DIR" == "$ADMIN_ROOT/bin" ]] ||
    die 'run this operation from the fixed root-owned Hub admin kit'
  verify_admin_kit "$ADMIN_ROOT" || die 'fixed Hub admin kit failed its trust check'
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
}

remove_revision_link() {
  local link=$1
  [[ ! -e "$link" || -L "$link" ]] || die 'release pointer is not a symbolic link'
  [[ -L "$link" ]] && rm -f -- "$link"
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
  chmod u-w "$destination"
  notice quarantine_release ok
}

service_control() {
  "$SYSTEMCTL_BIN" "$@"
}

service_unit_is_inactive() {
  local unit=$1 pid
  if service_control is-active --quiet "$unit" >/dev/null 2>&1; then return 1; fi
  pid="$(service_control show --property=MainPID --value "$unit" 2>/dev/null || true)"
  [[ -z "$pid" || "$pid" == 0 ]]
}

service_is_inactive() {
  service_unit_is_inactive "$SERVICE_NAME"
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

maintenance_on() {
  [[ ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" ]] ||
    die 'an existing hard-maintenance state requires explicit restore before deployment'
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

require_clean_maintenance_state() {
  [[ ! -e "$MAINTENANCE_PATH" && ! -L "$MAINTENANCE_PATH" ]] ||
    die 'an existing maintenance state requires explicit recovery before deployment'
  [[ ! -e "$FAIL_CLOSED_PATH" && ! -L "$FAIL_CLOSED_PATH" ]] ||
    die 'an existing hard-maintenance state requires explicit state restore before deployment'
}

maintenance_fail_closed() {
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

maintenance_off() {
  [[ ! -e "$MAINTENANCE_PATH" || -f "$MAINTENANCE_PATH" ]] ||
    die 'maintenance sentinel is not a regular file'
  [[ ! -L "$MAINTENANCE_PATH" ]] || die 'maintenance sentinel must not be a symbolic link'
  [[ ! -e "$FAIL_CLOSED_PATH" || -f "$FAIL_CLOSED_PATH" ]] ||
    die 'fail-closed sentinel is not a regular file'
  [[ ! -L "$FAIL_CLOSED_PATH" ]] || die 'fail-closed sentinel must not be a symbolic link'
  rm -f -- "$MAINTENANCE_PATH"
  rm -f -- "$FAIL_CLOSED_PATH"
  notice maintenance disabled
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
  if ! environment="$(create_candidate_environment "$revision")"; then
    cleanup_candidate "$revision" >/dev/null 2>&1 || true
    return 1
  fi
  unit="${CANDIDATE_SERVICE_PREFIX}${revision}.service"
  service_control daemon-reload || ok=false
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

prepare_snapshot_hook() {
  local source=$1 copy
  validate_snapshot_hook "$source"
  copy="$RUNTIME_ROOT/.snapshot-hook-$$"
  [[ ! -e "$copy" && ! -L "$copy" ]] || die 'snapshot hook staging path already exists'
  "$NODE_BIN" "$ADMIN_ROOT/bin/copy-artifact.mjs" "$source" "$copy"
  chmod 0500 "$copy"
  if [[ -z "$TEST_ROOT" ]]; then chown root:root "$copy"; fi
  validate_snapshot_hook "$copy"
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
