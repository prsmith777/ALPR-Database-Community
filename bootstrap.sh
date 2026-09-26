#!/usr/bin/env bash
set -Eeuo pipefail

readonly BOOTSTRAP_VERSION="5"
readonly CANONICAL_REPOSITORY="https://github.com/prsmith777/ALPR-Database-Community.git"
readonly CANONICAL_REPOSITORY_ID="github.com/prsmith777/ALPR-Database-Community"
readonly PINNED_NODE_VERSION="24.21.0"
readonly MINIMUM_CPU_COUNT=2
readonly MINIMUM_MEMORY_KIB=$((3500 * 1024))
readonly RECOMMENDED_CPU_COUNT=4
readonly RECOMMENDED_MEMORY_KIB=$((7500 * 1024))
readonly MINIMUM_FREE_KIB=$((20 * 1024 * 1024))
readonly MINIMUM_DOCKER_FREE_KIB=$((10 * 1024 * 1024))

SELF_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")"
readonly SELF_PATH
readonly INSTALL_USER="${SUDO_USER:-${USER:-$(id -un)}}"
INSTALL_HOME="$(getent passwd "${INSTALL_USER}" | cut -d: -f6)"
readonly INSTALL_HOME
readonly RUNTIME_ROOT="${ALPR_BOOTSTRAP_RUNTIME_ROOT:-${XDG_DATA_HOME:-${INSTALL_HOME}/.local/share}/alpr-community/runtime}"
readonly PRIVATE_NODE_LINK="${RUNTIME_ROOT}/node-current"

MODE=""
CHECK_PROFILE="new"
INSTALL_DIRECTORY=""
REQUESTED_RELEASE="${ALPR_BOOTSTRAP_RELEASE:-}"
ASSUME_YES=false
DRY_RUN=false
TEMPORARY_DIRECTORY=""
NODE_BINARY=""
OS_ID=""
OS_VERSION_ID=""
OS_CODENAME=""
OS_MAJOR_VERSION=""
PACKAGE_FAMILY=""
DOCKER_REPOSITORY_DISTRIBUTION=""
PGDG_REPOSITORY_FAMILY=""
SUPPORTED_PLATFORM_LABEL=""

info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warning() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
fatal() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
ALPR Community bootstrap

Usage:
  bash bootstrap.sh                 Interactive menu
  bash bootstrap.sh --new          Prepare and start a fresh installation
  bash bootstrap.sh --migrate      Prepare a separate Community migration target
  bash bootstrap.sh --check [new|migration]

Options:
  --install-dir PATH   Destination checkout (defaults below the current user's home)
  --release TAG        Exact stable vMAJOR.MINOR.PATCH tag (default: latest published stable release)
  --yes                Accept the bootstrap package-installation confirmation
  --dry-run            Show intended package/repository changes without applying them
  --help                Show this help

Automatic package installation supports selected maintained Ubuntu, Debian,
RHEL, Rocky Linux, AlmaLinux, CentOS Stream, and Fedora x86-64 releases.
Run --check first on an existing host and see docs/COMPATIBILITY.md for the
exact version matrix.
Compatibility checks are read-only. The bootstrap never overwrites an existing
ALPR installation or removes Docker packages, containers, volumes, or images.
EOF
}

cleanup() {
  if [[ -n "${TEMPORARY_DIRECTORY}" && -d "${TEMPORARY_DIRECTORY}" ]]; then
    rm -rf -- "${TEMPORARY_DIRECTORY}"
  fi
}
trap cleanup EXIT

run() {
  if [[ "${DRY_RUN}" == true ]]; then
    printf '[DRY RUN]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

download_file() {
  local url="$1" output="$2"
  curl --fail --silent --show-error --location \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 \
    "${url}" --output "${output}"
}

parse_arguments() {
  while (($#)); do
    case "$1" in
      --new) MODE="new" ;;
      --migrate) MODE="migration" ;;
      --check)
        MODE="check"
        if [[ "${2:-}" == "new" || "${2:-}" == "migration" ]]; then
          CHECK_PROFILE="$2"
          shift
        fi
        ;;
      --install-dir)
        [[ -n "${2:-}" ]] || fatal "--install-dir requires a path"
        INSTALL_DIRECTORY="$2"
        shift
        ;;
      --release)
        [[ "${2:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fatal "--release requires an exact stable vMAJOR.MINOR.PATCH tag"
        REQUESTED_RELEASE="$2"
        shift
        ;;
      --yes) ASSUME_YES=true ;;
      --dry-run) DRY_RUN=true ;;
      --help|-h) usage; exit 0 ;;
      *) fatal "Unknown option: $1" ;;
    esac
    shift
  done
}

interactive_menu() {
  cat <<'EOF'

ALPR Database Community Setup

  1. Install a new ALPR Community system
  2. Prepare migration from an existing ALPR installation
  3. Check system requirements
  4. Exit
EOF
  read -r -p "Select an option [1-4]: " selection
  case "${selection}" in
    1) MODE="new" ;;
    2) MODE="migration" ;;
    3)
      MODE="check"
      read -r -p "Check for a new installation or migration? [new/migration]: " CHECK_PROFILE
      [[ "${CHECK_PROFILE}" == "new" || "${CHECK_PROFILE}" == "migration" ]] || fatal "Enter new or migration"
      ;;
    4) exit 0 ;;
    *) fatal "Select a number from 1 through 4" ;;
  esac
}

load_os_release() {
  [[ "$(uname -s)" == "Linux" ]] || fatal "ALPR Community currently supports Linux x86-64 hosts only"
  [[ "$(uname -m)" == "x86_64" ]] || fatal "ALPR Community currently supports x86-64/amd64 only; ARM is not supported"
  [[ -r /etc/os-release ]] || fatal "Unable to identify Linux distribution: /etc/os-release is missing"
  # /etc/os-release is supplied by the operating system and contains shell-safe assignments.
  # shellcheck disable=SC1091
  source /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION_ID="${VERSION_ID:-unknown}"
  OS_CODENAME="${VERSION_CODENAME:-}"
  OS_MAJOR_VERSION="${OS_VERSION_ID%%.*}"
}

automatic_packages_supported() {
  PACKAGE_FAMILY=""
  DOCKER_REPOSITORY_DISTRIBUTION=""
  PGDG_REPOSITORY_FAMILY=""
  SUPPORTED_PLATFORM_LABEL=""

  case "${OS_ID}" in
    ubuntu)
      case "${OS_VERSION_ID}:${OS_CODENAME}" in
        22.04:jammy|24.04:noble|26.04:resolute)
          PACKAGE_FAMILY="apt"
          DOCKER_REPOSITORY_DISTRIBUTION="ubuntu"
          PGDG_REPOSITORY_FAMILY="apt"
          SUPPORTED_PLATFORM_LABEL="Ubuntu ${OS_VERSION_ID} (${OS_CODENAME})"
          ;;
        *) return 1 ;;
      esac
      ;;
    debian)
      case "${OS_VERSION_ID}:${OS_CODENAME}" in
        12:bookworm|13:trixie)
          PACKAGE_FAMILY="apt"
          DOCKER_REPOSITORY_DISTRIBUTION="debian"
          PGDG_REPOSITORY_FAMILY="apt"
          SUPPORTED_PLATFORM_LABEL="Debian ${OS_VERSION_ID} (${OS_CODENAME})"
          ;;
        *) return 1 ;;
      esac
      ;;
    rhel|rocky|almalinux)
      case "${OS_MAJOR_VERSION}" in
        8|9|10)
          PACKAGE_FAMILY="rpm"
          DOCKER_REPOSITORY_DISTRIBUTION="rhel"
          PGDG_REPOSITORY_FAMILY="el"
          SUPPORTED_PLATFORM_LABEL="${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}}"
          ;;
        *) return 1 ;;
      esac
      ;;
    centos)
      case "${OS_MAJOR_VERSION}" in
        9|10)
          [[ "${PRETTY_NAME:-}" == *Stream* ]] || return 1
          PACKAGE_FAMILY="rpm"
          DOCKER_REPOSITORY_DISTRIBUTION="centos"
          PGDG_REPOSITORY_FAMILY="el"
          SUPPORTED_PLATFORM_LABEL="${PRETTY_NAME}"
          ;;
        *) return 1 ;;
      esac
      ;;
    fedora)
      case "${OS_MAJOR_VERSION}" in
        43|44)
          PACKAGE_FAMILY="rpm"
          DOCKER_REPOSITORY_DISTRIBUTION="fedora"
          PGDG_REPOSITORY_FAMILY="fedora"
          SUPPORTED_PLATFORM_LABEL="Fedora Linux ${OS_MAJOR_VERSION}"
          ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

supported_platform_summary() {
  cat <<'EOF'
Ubuntu 22.04, 24.04, or 26.04; Debian 12 or 13; RHEL, Rocky Linux, or
AlmaLinux 8, 9, or 10; CentOS Stream 9 or 10; or Fedora 43 or 44 (x86-64).
EOF
}

platform_advisories() {
  if [[ "${OS_ID}" == "fedora" ]]; then
    warning "Fedora has a short support cycle and is not recommended by PostgreSQL for server deployments; keep the host on a currently supported Fedora release"
  fi
}

available_parent() {
  local candidate="$1"
  while [[ ! -e "${candidate}" ]]; do
    local parent
    parent="$(dirname -- "${candidate}")"
    [[ "${parent}" != "${candidate}" ]] || break
    candidate="${parent}"
  done
  printf '%s\n' "${candidate}"
}

check_resources() {
  local cpu_count memory_kib memory_gib free_kib target_parent filesystem
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf '0')"
  memory_kib="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  target_parent="$(available_parent "${INSTALL_DIRECTORY}")"
  free_kib="$(df -Pk "${target_parent}" | awk 'NR == 2 { print $4 }')"
  filesystem="$(stat -f -c '%T' "${target_parent}" 2>/dev/null || printf 'unknown')"
  memory_gib="$(awk -v memory_kib="${memory_kib}" 'BEGIN { printf "%.1f", memory_kib / 1024 / 1024 }')"

  info "Platform: ${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}} x86-64"
  info "Resources: ${cpu_count} logical CPUs, ${memory_gib} GiB usable RAM, $((free_kib / 1024 / 1024)) GiB free"
  info "Destination filesystem: ${filesystem} (${target_parent})"

  ((cpu_count >= MINIMUM_CPU_COUNT)) || fatal "At least ${MINIMUM_CPU_COUNT} logical CPUs are required"
  ((memory_kib >= MINIMUM_MEMORY_KIB)) || fatal "A host allocated at least 4 GiB RAM is required (Linux must report at least 3500 MiB usable)"
  ((free_kib >= MINIMUM_FREE_KIB)) || fatal "At least 20 GiB free space is required before application data"
  if ((cpu_count < RECOMMENDED_CPU_COUNT || memory_kib < RECOMMENDED_MEMORY_KIB)); then
    warning "4 vCPU and 8 GiB RAM are recommended for routine use and ReID processing"
  fi
  case "${filesystem}" in
    cifs|smb2|nfs|nfs4|vfat|exfat|fuseblk)
      fatal "${filesystem} is not supported for the Community checkout and writable bind mounts; use a local Linux filesystem"
      ;;
  esac
}

node_major_24() {
  local candidate="$1"
  [[ -x "${candidate}" ]] || return 1
  [[ "$("${candidate}" --version 2>/dev/null || true)" =~ ^v24\. ]]
}

resolve_node() {
  if command -v node >/dev/null 2>&1 && node_major_24 "$(command -v node)"; then
    NODE_BINARY="$(command -v node)"
  elif node_major_24 "${PRIVATE_NODE_LINK}/bin/node"; then
    NODE_BINARY="${PRIVATE_NODE_LINK}/bin/node"
  else
    NODE_BINARY=""
  fi
}

postgres_client_path() {
  local program="$1" candidate
  for candidate in \
    "/usr/lib/postgresql/17/bin/${program}" \
    "/usr/pgsql-17/bin/${program}"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  candidate="$(command -v "${program}" 2>/dev/null || true)"
  if [[ -n "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi
  return 1
}

postgres_clients_ready() {
  local program candidate
  for program in psql pg_dump pg_restore; do
    candidate="$(postgres_client_path "${program}")" || return 1
    "${candidate}" --version 2>/dev/null | grep -Eq ' 17\.' || return 1
  done
}

docker_environment_ready() {
  local server_summary os_type architecture docker_root endpoint context root_parent free_kib
  server_summary="$(docker info --format '{{.OSType}}|{{.Architecture}}|{{.DockerRootDir}}' 2>/dev/null)" \
    || { warning "Docker server details could not be read"; return 1; }
  IFS='|' read -r os_type architecture docker_root <<<"${server_summary}"
  [[ "${os_type}" == linux ]] \
    || { warning "Docker must use a Linux daemon; reported ${os_type:-unknown}"; return 1; }
  case "${architecture}" in
    x86_64|amd64) ;;
    *) warning "Docker must use an x86-64 daemon; reported ${architecture:-unknown}"; return 1 ;;
  esac
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    endpoint="${DOCKER_HOST}"
  else
    context="$(docker context show 2>/dev/null)" \
      || { warning "The active Docker context could not be identified"; return 1; }
    endpoint="$(docker context inspect "${context}" \
      --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" \
      || { warning "The active Docker endpoint could not be inspected"; return 1; }
  fi
  case "${endpoint}" in
    unix:///*) ;;
    *) warning "Docker uses a nonlocal endpoint (${endpoint:-unknown}); local bind mounts require a local Unix-socket daemon"; return 1 ;;
  esac
  [[ -n "${docker_root}" ]] \
    || { warning "Docker did not report its data-root directory"; return 1; }
  root_parent="$(available_parent "${docker_root}")"
  free_kib="$(df -Pk "${root_parent}" | awk 'NR == 2 { print $4 }')"
  [[ "${free_kib}" =~ ^[0-9]+$ ]] \
    || { warning "Docker data-root free space could not be measured at ${root_parent}"; return 1; }
  info "Docker environment: local Linux ${architecture} daemon, $((free_kib / 1024 / 1024)) GiB free at ${root_parent}"
  ((free_kib >= MINIMUM_DOCKER_FREE_KIB)) \
    || { warning "Docker's data-root needs at least 10 GiB free for the application image and build cache"; return 1; }
  return 0
}

dependency_report() {
  local profile="$1" failures=0
  if command -v git >/dev/null 2>&1; then success "Git: $(git --version)"; else warning "Git is missing"; failures=$((failures + 1)); fi
  resolve_node
  if [[ -n "${NODE_BINARY}" ]]; then success "Node.js: $("${NODE_BINARY}" --version)"; else warning "Node.js 24 is missing"; failures=$((failures + 1)); fi
  if command -v docker >/dev/null 2>&1; then success "Docker CLI: $(docker --version)"; else warning "Docker Engine is missing"; failures=$((failures + 1)); fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then success "Docker Compose: $(docker compose version)"; else warning "Docker Compose v2 is missing"; failures=$((failures + 1)); fi
  if command -v docker >/dev/null 2>&1 && docker buildx version >/dev/null 2>&1; then success "Docker Buildx: $(docker buildx version)"; else warning "Docker Buildx is missing"; failures=$((failures + 1)); fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    success "Docker daemon is available to ${INSTALL_USER}"
    docker_environment_ready || failures=$((failures + 1))
  else
    warning "The current account cannot use the Docker daemon"
    failures=$((failures + 1))
  fi
  if command -v sudo >/dev/null 2>&1; then success "sudo is available"; else warning "sudo is missing"; failures=$((failures + 1)); fi
  if command -v curl >/dev/null 2>&1; then success "curl is available"; else warning "curl is missing"; failures=$((failures + 1)); fi
  if [[ "${profile}" == "migration" ]]; then
    if postgres_clients_ready; then success "PostgreSQL 17 client utilities are ready at $(dirname -- "$(postgres_client_path psql)")"; else warning "PostgreSQL 17 psql, pg_dump, or pg_restore is missing"; failures=$((failures + 1)); fi
    if command -v rsync >/dev/null 2>&1; then success "rsync is ready for image storage"; else warning "rsync is missing"; failures=$((failures + 1)); fi
    if command -v ssh >/dev/null 2>&1; then success "OpenSSH client is ready for remote migration sources"; else warning "OpenSSH client is missing"; failures=$((failures + 1)); fi
  fi
  return "${failures}"
}

check_network() {
  command -v curl >/dev/null 2>&1 || { warning "curl is missing; network endpoints were not probed"; return 0; }
  local url
  for url in \
    https://github.com/ \
    https://download.docker.com/ \
    https://nodejs.org/ \
    https://download.postgresql.org/ \
    https://registry.yarnpkg.com/ \
    https://storage.openvinotoolkit.org/; do
    curl --fail --silent --show-error --location --max-time 20 --output /dev/null "${url}" \
      || fatal "Required download endpoint is unavailable: ${url}"
  done
  success "Required HTTPS download endpoints are reachable"
}

confirm_changes() {
  [[ "${ASSUME_YES}" == true ]] && return 0
  printf '\nThe bootstrap may install operating-system packages and configure Docker.\n'
  printf 'It will not remove existing Docker packages or overwrite an ALPR installation.\n\n'
  read -r -p "Continue? Type yes: " answer
  [[ "${answer}" == "yes" ]] || fatal "Bootstrap cancelled"
}

ensure_temporary_directory() {
  if [[ -z "${TEMPORARY_DIRECTORY}" ]]; then
    TEMPORARY_DIRECTORY="$(mktemp -d -t alpr-community-bootstrap.XXXXXXXX)"
    chmod 700 "${TEMPORARY_DIRECTORY}"
  fi
}

install_base_packages() {
  case "${PACKAGE_FAMILY}" in
    apt)
      if ! run sudo apt-get update; then
        local existing_sources
        existing_sources="$({
          apt_source_files_containing download.docker.com
          apt_source_files_containing apt.postgresql.org
        })"
        if [[ -n "${existing_sources}" ]]; then
          fatal "APT cannot refresh while existing Docker or PostgreSQL source definitions are present. Reconcile these files before retrying: ${existing_sources//$'\n'/, }"
        fi
        fatal "APT package indexes could not be refreshed"
      fi
      run sudo apt-get install -y ca-certificates curl git gnupg xz-utils
      ;;
    rpm)
      local -a packages=(ca-certificates git gnupg2 tar xz dnf-plugins-core)
      command -v curl >/dev/null 2>&1 || packages+=(curl)
      run sudo dnf -y install "${packages[@]}"
      ;;
    *) fatal "No package adapter is selected for this host" ;;
  esac
}

install_private_node() {
  resolve_node
  [[ -n "${NODE_BINARY}" ]] && return 0
  ensure_temporary_directory
  local archive="node-v${PINNED_NODE_VERSION}-linux-x64.tar.xz"
  local base="https://nodejs.org/dist/v${PINNED_NODE_VERSION}"
  info "Installing private Node.js ${PINNED_NODE_VERSION} runtime"
  if [[ "${DRY_RUN}" == true ]]; then
    info "Would download and verify ${base}/${archive} into ${RUNTIME_ROOT}"
    NODE_BINARY="${PRIVATE_NODE_LINK}/bin/node"
    return 0
  fi
  download_file "${base}/${archive}" "${TEMPORARY_DIRECTORY}/${archive}"
  download_file "${base}/SHASUMS256.txt" "${TEMPORARY_DIRECTORY}/SHASUMS256.txt"
  (cd "${TEMPORARY_DIRECTORY}" && grep -E "  ${archive}$" SHASUMS256.txt | sha256sum --check --strict -)
  mkdir -p "${RUNTIME_ROOT}"
  rm -rf -- "${RUNTIME_ROOT}/node-v${PINNED_NODE_VERSION}-linux-x64"
  tar --extract --xz --file "${TEMPORARY_DIRECTORY}/${archive}" --directory "${RUNTIME_ROOT}"
  ln -sfn "${RUNTIME_ROOT}/node-v${PINNED_NODE_VERSION}-linux-x64" "${PRIVATE_NODE_LINK}"
  NODE_BINARY="${PRIVATE_NODE_LINK}/bin/node"
  node_major_24 "${NODE_BINARY}" || fatal "Private Node.js installation did not validate"
  success "Installed Node.js $("${NODE_BINARY}" --version) under ${RUNTIME_ROOT}"
}

docker_package_conflict() {
  local package
  if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
    for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
      if dpkg-query -W -f='${Status}' "${package}" 2>/dev/null | grep -q 'install ok installed'; then
        printf '%s\n' "${package}"
      fi
    done
  else
    for package in docker docker-client docker-client-latest docker-common docker-latest \
      docker-latest-logrotate docker-logrotate docker-engine podman podman-docker containerd runc; do
      if rpm -q "${package}" >/dev/null 2>&1; then
        printf '%s\n' "${package}"
      fi
    done
  fi
}

docker_ce_installed() {
  if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
    dpkg-query -W -f='${Status}' docker-ce 2>/dev/null | grep -q 'install ok installed'
  else
    rpm -q docker-ce >/dev/null 2>&1
  fi
}

install_docker_plugins() {
  if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
    run sudo apt-get install -y docker-buildx-plugin docker-compose-plugin
  else
    run sudo dnf -y install docker-buildx-plugin docker-compose-plugin
  fi
}

apt_source_files_containing() {
  local needle="$1" file
  if [[ -r /etc/apt/sources.list ]] && grep -qF -- "${needle}" /etc/apt/sources.list; then
    printf '%s\n' /etc/apt/sources.list
  fi
  if [[ -d /etc/apt/sources.list.d ]]; then
    while IFS= read -r -d '' file; do
      if grep -qF -- "${needle}" "${file}"; then printf '%s\n' "${file}"; fi
    done < <(find /etc/apt/sources.list.d -maxdepth 1 -type f \
      \( -name '*.list' -o -name '*.sources' \) -print0)
  fi
  return 0
}

reuse_existing_apt_repository() {
  local label="$1" needle="$2" package="$3" existing candidate
  existing="$(apt_source_files_containing "${needle}")"
  [[ -n "${existing}" ]] || return 1
  info "Reusing existing ${label} APT repository definition(s):"
  printf '%s\n' "${existing}"
  if ! sudo apt-get update; then
    fatal "Existing ${label} APT repository configuration is not usable; reconcile the listed source files before retrying"
  fi
  candidate="$(apt-cache policy "${package}" | awk '/Candidate:/ { print $2; exit }')"
  [[ -n "${candidate}" && "${candidate}" != "(none)" ]] \
    || fatal "Existing ${label} APT repository does not provide ${package} for this host"
  success "Existing ${label} APT repository is usable"
}

configure_apt_docker_repository() {
  if reuse_existing_apt_repository "Docker" \
    "download.docker.com/linux/${DOCKER_REPOSITORY_DISTRIBUTION}" docker-ce; then
    return 0
  fi
  ensure_temporary_directory
  download_file \
    "https://download.docker.com/linux/${DOCKER_REPOSITORY_DISTRIBUTION}/gpg" \
    "${TEMPORARY_DIRECTORY}/docker.asc"
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo install -m 0644 "${TEMPORARY_DIRECTORY}/docker.asc" /etc/apt/keyrings/docker.asc
  cat >"${TEMPORARY_DIRECTORY}/docker.sources" <<EOF
Types: deb
URIs: https://download.docker.com/linux/${DOCKER_REPOSITORY_DISTRIBUTION}
Suites: ${OS_CODENAME}
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  sudo install -m 0644 "${TEMPORARY_DIRECTORY}/docker.sources" /etc/apt/sources.list.d/docker.sources
  sudo apt-get update
}

configure_rpm_docker_repository() {
  local repository="https://download.docker.com/linux/${DOCKER_REPOSITORY_DISTRIBUTION}/docker-ce.repo"
  if [[ "${DOCKER_REPOSITORY_DISTRIBUTION}" == "fedora" ]]; then
    sudo dnf config-manager addrepo --from-repofile "${repository}"
  else
    sudo dnf config-manager --add-repo "${repository}"
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 \
    && docker compose version >/dev/null 2>&1 \
    && docker buildx version >/dev/null 2>&1; then
    info "Reusing existing Docker Engine and Compose installation"
    if ! docker info >/dev/null 2>&1; then run sudo systemctl enable --now docker; fi
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    if docker_ce_installed; then
      info "Completing the existing Docker CE installation with Compose and Buildx"
      install_docker_plugins
      run sudo systemctl enable --now docker
      return 0
    fi
    fatal "Docker is present but Compose v2 or Buildx is unavailable; repair the existing installation before rerunning the bootstrap"
  fi
  local conflicts
  conflicts="$(docker_package_conflict)"
  [[ -z "${conflicts}" ]] || fatal "Conflicting container packages are installed (${conflicts//$'\n'/, }). Review and remove them manually before installing Docker CE"

  info "Installing Docker Engine and Compose from Docker's ${DOCKER_REPOSITORY_DISTRIBUTION} repository"
  if [[ "${DRY_RUN}" == true ]]; then
    info "Would configure Docker's signed ${DOCKER_REPOSITORY_DISTRIBUTION} repository and install Docker CE, Buildx, and Compose"
    return 0
  fi
  if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
    configure_apt_docker_repository
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    configure_rpm_docker_repository
    sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  sudo systemctl enable --now docker
}

refresh_docker_membership() {
  if [[ "${DRY_RUN}" == true ]]; then
    warning "A new login session may be required before Docker group access becomes active"
    return 0
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  getent group docker >/dev/null 2>&1 || fatal "Docker is installed but unavailable to ${INSTALL_USER}, and no docker group exists"
  if ! id -nG "${INSTALL_USER}" | tr ' ' '\n' | grep -Fxq docker; then
    run sudo usermod -aG docker "${INSTALL_USER}"
  fi
  if [[ "${ALPR_BOOTSTRAP_GROUP_REFRESHED:-}" != "1" ]]; then
    local -a resume_arguments
    case "${MODE}" in
      new) resume_arguments=(--new) ;;
      migration) resume_arguments=(--migrate) ;;
      *) fatal "Cannot refresh Docker access for unresolved bootstrap mode: ${MODE}" ;;
    esac
    resume_arguments+=(--install-dir "${INSTALL_DIRECTORY}" --yes)
    [[ -z "${REQUESTED_RELEASE}" ]] || resume_arguments+=(--release "${REQUESTED_RELEASE}")
    info "Refreshing group membership for ${INSTALL_USER}"
    exec sudo -u "${INSTALL_USER}" -H env \
      ALPR_BOOTSTRAP_GROUP_REFRESHED=1 \
      ALPR_BOOTSTRAP_RUNTIME_ROOT="${RUNTIME_ROOT}" \
      bash "${SELF_PATH}" "${resume_arguments[@]}"
  fi
  fatal "Docker is installed but ${INSTALL_USER} cannot access the daemon. Sign out and back in, then rerun the bootstrap"
}

install_migration_tools() {
  if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
    run sudo apt-get install -y rsync openssh-client
  else
    run sudo dnf -y install rsync openssh-clients
  fi
  postgres_clients_ready && return 0
  ensure_temporary_directory
  info "Installing PostgreSQL 17 client utilities from the PostgreSQL project repository"
  if [[ "${DRY_RUN}" == true ]]; then
    if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
      info "Would configure the signed ${OS_CODENAME}-pgdg repository and install postgresql-client-17"
    else
      info "Would configure the signed PostgreSQL ${PGDG_REPOSITORY_FAMILY} repository and install postgresql17"
    fi
    return 0
  fi
  if [[ "${PACKAGE_FAMILY}" == "apt" ]]; then
    if ! reuse_existing_apt_repository "PostgreSQL" \
      "apt.postgresql.org/pub/repos/apt" postgresql-client-17; then
      download_file https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        "${TEMPORARY_DIRECTORY}/postgresql.asc"
      sudo install -m 0755 -d /usr/share/postgresql-common/pgdg
      sudo install -m 0644 "${TEMPORARY_DIRECTORY}/postgresql.asc" \
        /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
      printf '%s\n' \
        "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${OS_CODENAME}-pgdg main" \
        >"${TEMPORARY_DIRECTORY}/pgdg.list"
      sudo install -m 0644 "${TEMPORARY_DIRECTORY}/pgdg.list" /etc/apt/sources.list.d/pgdg.list
      sudo apt-get update
    fi
    sudo apt-get install -y postgresql-client-17
  else
    local repository_package
    if [[ "${PGDG_REPOSITORY_FAMILY}" == "fedora" ]]; then
      repository_package="https://download.postgresql.org/pub/repos/yum/reporpms/F-${OS_MAJOR_VERSION}-x86_64/pgdg-fedora-repo-latest.noarch.rpm"
    else
      repository_package="https://download.postgresql.org/pub/repos/yum/reporpms/EL-${OS_MAJOR_VERSION}-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
    fi
    sudo dnf -y install "${repository_package}"
    if [[ "${PGDG_REPOSITORY_FAMILY}" == "el" && ( "${OS_MAJOR_VERSION}" == "8" || "${OS_MAJOR_VERSION}" == "9" ) ]]; then
      sudo dnf -qy module disable postgresql
    fi
    sudo dnf -y install postgresql17
  fi
  postgres_clients_ready || fatal "PostgreSQL 17 client utilities did not validate"
}

normalize_repository() {
  local value="$1"
  value="${value%.git}"
  value="${value%/}"
  value="${value#https://}"
  value="${value#http://}"
  if [[ "${value}" =~ ^git@([^:]+):(.+)$ ]]; then
    value="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  fi
  printf '%s\n' "${value}"
}

latest_release() {
  local effective_url tag
  effective_url="$(curl --fail --silent --show-error --location \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 \
    --output /dev/null --write-out '%{url_effective}' \
    "${CANONICAL_REPOSITORY%.git}/releases/latest")"
  tag="${effective_url##*/}"
  [[ "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s\n' "${tag}"
}

pin_published_release() {
  local discovered
  [[ -z "${REQUESTED_RELEASE}" ]] || return 0
  if ! discovered="$(latest_release)"; then
    fatal "Unable to discover the latest published stable Community release"
  fi
  [[ "${discovered}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fatal "Published Community release does not use an exact stable version tag"
  REQUESTED_RELEASE="${discovered}"
  success "Pinned published Community release ${REQUESTED_RELEASE}"
}

is_unmaterialized_bootstrap_checkout() {
  local directory="$1"
  [[ -d "${directory}/.git" ]] || return 1
  [[ ! -e "${directory}/.env" ]] || return 1
  [[ -z "$(find "${directory}" -mindepth 1 -maxdepth 1 ! -name .git -print -quit)" ]] || return 1
  git -C "${directory}" rev-parse --verify HEAD >/dev/null 2>&1 || return 1
  [[ -z "$(git -C "${directory}" ls-files --stage)" ]] || return 1
}

validate_install_destination() {
  local origin checkout_status
  if [[ -e "${INSTALL_DIRECTORY}" && ! -d "${INSTALL_DIRECTORY}" ]]; then
    fatal "Installation destination exists and is not a directory: ${INSTALL_DIRECTORY}"
  fi
  if [[ -d "${INSTALL_DIRECTORY}" && ! -d "${INSTALL_DIRECTORY}/.git" ]]; then
    [[ -z "$(find "${INSTALL_DIRECTORY}" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
      || fatal "Installation destination is not empty: ${INSTALL_DIRECTORY}"
    return 0
  fi
  [[ -d "${INSTALL_DIRECTORY}/.git" ]] || return 0
  [[ ! -e "${INSTALL_DIRECTORY}/.env" ]] \
    || fatal "An installed Community target already exists at ${INSTALL_DIRECTORY}"
  command -v git >/dev/null 2>&1 || {
    warning "Existing Git metadata will be validated after Git is installed"
    return 0
  }
  origin="$(normalize_repository "$(git -C "${INSTALL_DIRECTORY}" remote get-url origin)")"
  [[ "${origin}" == "${CANONICAL_REPOSITORY_ID}" ]] \
    || fatal "Existing checkout does not use the canonical Community repository"
  checkout_status="$(git -C "${INSTALL_DIRECTORY}" status --porcelain --untracked-files=normal)"
  if [[ -n "${checkout_status}" ]]; then
    if is_unmaterialized_bootstrap_checkout "${INSTALL_DIRECTORY}"; then
      fatal "The destination has an ambiguous empty-index checkout left by bootstrap v3 or by staged deletions. Review it, move the entire directory aside, and rerun; bootstrap will not overwrite it automatically"
    fi
    fatal "Existing Community checkout is not clean"
  fi
}

prepare_checkout() {
  local target_tag origin package_version checkout_status
  if [[ -n "${REQUESTED_RELEASE}" ]]; then
    target_tag="${REQUESTED_RELEASE}"
  elif [[ "${DRY_RUN}" == true ]] && ! command -v git >/dev/null 2>&1; then
    target_tag="the newest stable vMAJOR.MINOR.PATCH tag"
  else
    if ! target_tag="$(latest_release)"; then
      fatal "Unable to discover the latest published stable Community release"
    fi
    [[ "${target_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fatal "Unable to discover an exact stable Community release"
  fi

  validate_install_destination
  if [[ ! -d "${INSTALL_DIRECTORY}/.git" ]]; then
    run git clone --filter=blob:none "${CANONICAL_REPOSITORY}" "${INSTALL_DIRECTORY}"
  fi
  [[ "${DRY_RUN}" == false ]] || { info "Would verify and check out ${target_tag} in ${INSTALL_DIRECTORY}"; return 0; }

  origin="$(normalize_repository "$(git -C "${INSTALL_DIRECTORY}" remote get-url origin)")"
  [[ "${origin}" == "${CANONICAL_REPOSITORY_ID}" ]] || fatal "Existing checkout does not use the canonical Community repository"
  checkout_status="$(git -C "${INSTALL_DIRECTORY}" status --porcelain --untracked-files=normal)"
  [[ -z "${checkout_status}" ]] || fatal "Existing Community checkout is not clean"
  [[ ! -e "${INSTALL_DIRECTORY}/.env" ]] || fatal "An installed Community target already exists at ${INSTALL_DIRECTORY}"

  git -C "${INSTALL_DIRECTORY}" fetch --force origin \
    main:refs/remotes/origin/main \
    "refs/tags/${target_tag}:refs/tags/${target_tag}"
  git -C "${INSTALL_DIRECTORY}" merge-base --is-ancestor "${target_tag}^{commit}" origin/main \
    || fatal "Release ${target_tag} is not on canonical origin/main"
  package_version="$(git -C "${INSTALL_DIRECTORY}" show "${target_tag}:package.json" \
    | "${NODE_BINARY}" -e 'let source=""; process.stdin.on("data", chunk => source += chunk).on("end", () => process.stdout.write(JSON.parse(source).version));')"
  [[ "${package_version}" == "${target_tag#v}" ]] || fatal "Release tag and package version do not match"
  git -C "${INSTALL_DIRECTORY}" checkout --detach "${target_tag}"
  success "Prepared exact Community release ${target_tag} at ${INSTALL_DIRECTORY}"
}

run_compatibility_check() {
  local profile="$1"
  load_os_release
  if automatic_packages_supported; then
    success "Automatic package installation is supported on ${SUPPORTED_PLATFORM_LABEL}"
    platform_advisories
  else
    warning "Automatic package installation is not available for ${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}}"
  fi
  check_resources
  local result=0
  dependency_report "${profile}" || result=$?
  check_network
  if ((result > 0)); then
    fatal "Compatibility check found ${result} missing or unavailable requirement(s)"
  fi
  success "Compatibility check passed for ${profile}"
}

install_prerequisites() {
  load_os_release
  automatic_packages_supported \
    || fatal "Automatic installation is unavailable for ${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}}. Supported releases: $(supported_platform_summary) Run --check for the manual compatibility path"
  success "Selected ${PACKAGE_FAMILY} package adapter for ${SUPPORTED_PLATFORM_LABEL}"
  platform_advisories
  check_resources
  confirm_changes
  install_base_packages
  check_network
  install_private_node
  if [[ "${DRY_RUN}" == false ]]; then pin_published_release; fi
  install_docker
  refresh_docker_membership
  docker_environment_ready || fatal "Docker is available but does not meet the local Linux daemon requirements"
  if [[ "${MODE}" == "migration" ]]; then install_migration_tools; fi
  if [[ "${DRY_RUN}" == false ]]; then
    dependency_report "${MODE}" || fatal "Installed prerequisites did not pass validation"
  fi
}

main() {
  parse_arguments "$@"
  [[ -z "${REQUESTED_RELEASE}" || "${REQUESTED_RELEASE}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fatal "ALPR_BOOTSTRAP_RELEASE and --release require an exact stable vMAJOR.MINOR.PATCH tag"
  [[ "$(id -u)" -ne 0 ]] || fatal "Run the bootstrap as the normal account that will own ALPR, not as root"
  [[ -n "${INSTALL_HOME}" && -d "${INSTALL_HOME}" ]] || fatal "Unable to resolve the home directory for ${INSTALL_USER}"
  [[ "${RUNTIME_ROOT}" == /* ]] || fatal "The private Node.js runtime path must be absolute"
  [[ -n "${MODE}" ]] || interactive_menu
  if [[ -z "${INSTALL_DIRECTORY}" ]]; then
    if [[ "${MODE}" == "migration" || ("${MODE}" == "check" && "${CHECK_PROFILE}" == "migration") ]]; then
      INSTALL_DIRECTORY="${INSTALL_HOME}/alpr-community-target"
    else
      INSTALL_DIRECTORY="${INSTALL_HOME}/alpr-community"
    fi
  fi
  INSTALL_DIRECTORY="$(realpath -m -- "${INSTALL_DIRECTORY}")"

  info "ALPR Community bootstrap v${BOOTSTRAP_VERSION}"
  if [[ "${MODE}" == "check" ]]; then
    run_compatibility_check "${CHECK_PROFILE}"
    return 0
  fi

  validate_install_destination
  install_prerequisites
  prepare_checkout
  [[ "${DRY_RUN}" == false ]] || return 0

  if [[ "${MODE}" == "new" ]]; then
    info "Starting the guarded fresh installer"
    (cd "${INSTALL_DIRECTORY}" && ALPR_NODE_BINARY="${NODE_BINARY}" ./alpr-community install)
  else
    cat <<EOF

Migration preparation is complete.

Community target checkout: ${INSTALL_DIRECTORY}

No source ALPR database, storage, container, or service was changed. This target
host may have received the prerequisite packages and repository configuration
described above. Continue with:

  cd "${INSTALL_DIRECTORY}"
  ALPR_NODE_BINARY="${NODE_BINARY}" ./alpr-community migrate wizard

The migration wizard creates and validates its own empty PostgreSQL 17 target.
It will ask for the source database, image-storage location, and a new Community
administrator password. Follow docs/MIGRATION_GUIDE.md and keep the source
unchanged until database, image-storage, application, and restart validation
are accepted.
EOF
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
