#!/usr/bin/env bash
# Test doubles are resolved by functions loaded dynamically from bootstrap.sh.
# shellcheck disable=SC1090,SC2034,SC2329
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
bootstrap="${repository_root}/bootstrap.sh"
fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT

fail() { printf 'Bootstrap control-flow test failed: %s\n' "$*" >&2; exit 1; }

memory_output="$({
  source "${bootstrap}"
  INSTALL_DIRECTORY="${fixture_root}/memory-target"
  PRETTY_NAME='Fixture Linux'
  getconf() { printf '2\n'; }
  available_parent() { printf '%s\n' "${fixture_root}"; }
  df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 50000000 1 40000000 1%% /fixture\n'; }
  stat() { printf 'ext4\n'; }
  awk() {
    if [[ "${*: -1}" == /proc/meminfo ]]; then printf '4012340\n'; else /usr/bin/awk "$@"; fi
  }
  check_resources
})"
[[ "${memory_output}" == *'3.8 GiB usable RAM'* ]] \
  || fail "a normal 4 GiB VM was not accepted and reported as usable memory"

rpm_with_existing_curl="$({
  source "${bootstrap}"
  PACKAGE_FAMILY=rpm
  run() { printf '<%s>' "$@"; }
  command() {
    if [[ "${1:-}" == -v && "${2:-}" == curl ]]; then return 0; fi
    builtin command "$@"
  }
  install_base_packages
})"
[[ "${rpm_with_existing_curl}" != *'<curl>'* ]] \
  || fail "RPM base packages replace an existing curl provider"

rpm_without_curl="$({
  source "${bootstrap}"
  PACKAGE_FAMILY=rpm
  run() { printf '<%s>' "$@"; }
  command() {
    if [[ "${1:-}" == -v && "${2:-}" == curl ]]; then return 1; fi
    builtin command "$@"
  }
  install_base_packages
})"
[[ "${rpm_without_curl}" == *'<curl>'* ]] \
  || fail "RPM base packages omit curl when no provider is installed"

apt_reuse="$({
  source "${bootstrap}"
  DOCKER_REPOSITORY_DISTRIBUTION=debian
  apt_source_files_containing() { printf '/fixture/docker.list\n'; }
  sudo() { [[ "${1:-}" == apt-get && "${2:-}" == update ]]; }
  apt-cache() { printf '  Candidate: 1.2.3\n'; }
  download_file() { fail "downloaded over an existing validated APT repository"; }
  configure_apt_docker_repository
})"
[[ "${apt_reuse}" == *'Existing Docker APT repository is usable'* ]] \
  || fail "valid existing Docker APT repository was not reused"

(
  source "${bootstrap}"
  docker() { return 0; }
  getent() { return 2; }
  refresh_docker_membership
) || fail "working rootless/group-free Docker access was rejected"

mkdir -p "${fixture_root}/bin"
printf '%s\n' '#!/usr/bin/env bash' 'printf '\''<%s>'\'' "$@"' >"${fixture_root}/bin/sudo"
chmod +x "${fixture_root}/bin/sudo"
resume_output="$({
  source "${bootstrap}"
  PATH="${fixture_root}/bin:${PATH}"
  MODE=migration
  INSTALL_DIRECTORY="${fixture_root}/migration-target"
  ASSUME_YES=true
  docker() { return 1; }
  getent() { printf 'docker:x:999:test\n'; }
  id() { printf 'test docker\n'; }
  refresh_docker_membership
})"
for expected in '<--migrate>' '<--install-dir>' "<${fixture_root}/migration-target>" '<--yes>'; do
  [[ "${resume_output}" == *"${expected}"* ]] || fail "Docker group refresh lost ${expected}"
done

missing_tools_count="$({
  source "${bootstrap}"
  command() {
    if [[ "${1:-}" == -v ]]; then
      case "${2:-}" in curl|ssh) return 1;; *) printf '/fixture/%s\n' "${2:-}"; return 0;; esac
    fi
    builtin command "$@"
  }
  resolve_node() { NODE_BINARY=/bin/echo; }
  docker() { printf 'fixture Docker\n'; }
  docker_environment_ready() { return 0; }
  postgres_clients_ready() { return 0; }
  postgres_client_path() { printf '/fixture/postgresql/17/bin/psql\n'; }
  set +e
  dependency_report migration >/dev/null
  result=$?
  set -e
  printf '%s' "${result}"
})"
[[ "${missing_tools_count}" == 2 ]] \
  || fail "migration compatibility did not count missing curl and SSH"

remote_docker_output="$({
  source "${bootstrap}"
  docker() {
    case "${1:-} ${2:-}" in
      'info --format') printf 'linux|x86_64|/var/lib/docker\n' ;;
      'context show') printf 'remote\n' ;;
      'context inspect') printf 'ssh://example.invalid\n' ;;
      *) return 1 ;;
    esac
  }
  set +e
  docker_environment_ready
  printf '\nEXIT=%s' "$?"
})"
[[ "${remote_docker_output}" == *'nonlocal endpoint'* ]]
[[ "${remote_docker_output}" == *'EXIT=1'* ]]

published_release="$({
  source "${bootstrap}"
  curl() { printf 'https://github.com/prsmith777/ALPR-Database-Community/releases/tag/v1.2.3'; }
  latest_release
})"
[[ "${published_release}" == v1.2.3 ]] || fail "published-release redirect was not resolved"

invalid_release_output="$({
  set +e
  ALPR_BOOTSTRAP_RELEASE=not-a-release bash "${bootstrap}" --check new 2>&1
  printf '\nEXIT=%s' "$?"
})"
[[ "${invalid_release_output}" == *'exact stable vMAJOR.MINOR.PATCH tag'* ]]
[[ "${invalid_release_output}" == *'EXIT=1'* ]]

git init --quiet "${fixture_root}/ambiguous"
git -C "${fixture_root}/ambiguous" config user.name test
git -C "${fixture_root}/ambiguous" config user.email test@example.invalid
git -C "${fixture_root}/ambiguous" remote add origin https://github.com/prsmith777/ALPR-Database-Community.git
printf 'tracked\n' >"${fixture_root}/ambiguous/tracked"
git -C "${fixture_root}/ambiguous" add tracked
git -C "${fixture_root}/ambiguous" commit --quiet -m fixture
git -C "${fixture_root}/ambiguous" rm --quiet tracked
set +e
ambiguous_output="$({
  source "${bootstrap}"
  INSTALL_DIRECTORY="${fixture_root}/ambiguous"
  validate_install_destination 2>&1
})"
ambiguous_status=$?
set -e
[[ "${ambiguous_output}" == *'ambiguous empty-index checkout'* ]]
[[ "${ambiguous_status}" == 1 ]]

mkdir "${fixture_root}/occupied"
touch "${fixture_root}/occupied/user-file"
set +e
preflight_output="$({
  source "${bootstrap}"
  install_prerequisites() { printf 'PREREQUISITES_MUTATED\n'; }
  main --new --yes --release v1.2.3 --install-dir "${fixture_root}/occupied" 2>&1
})"
preflight_status=$?
set -e
[[ "${preflight_output}" != *'PREREQUISITES_MUTATED'* ]] \
  || fail "prerequisites ran before the occupied target was rejected"
[[ "${preflight_output}" == *'Installation destination is not empty'* ]]
[[ "${preflight_status}" == 1 ]]

printf 'Bootstrap control-flow tests passed.\n'
