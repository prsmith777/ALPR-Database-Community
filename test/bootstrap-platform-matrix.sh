#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../bootstrap.sh
source "${repository_root}/bootstrap.sh"

assert_supported() {
  local id="$1" version="$2" codename="$3" pretty="$4"
  local expected_package_family="$5" expected_docker_family="$6" expected_pgdg_family="$7"
  OS_ID="${id}"
  OS_VERSION_ID="${version}"
  OS_CODENAME="${codename}"
  OS_MAJOR_VERSION="${version%%.*}"
  PRETTY_NAME="${pretty}"
  automatic_packages_supported || {
    printf 'Expected supported platform: %s %s (%s)\n' "${id}" "${version}" "${codename}" >&2
    return 1
  }
  [[ "${PACKAGE_FAMILY}" == "${expected_package_family}" ]]
  [[ "${DOCKER_REPOSITORY_DISTRIBUTION}" == "${expected_docker_family}" ]]
  [[ "${PGDG_REPOSITORY_FAMILY}" == "${expected_pgdg_family}" ]]
  [[ -n "${SUPPORTED_PLATFORM_LABEL}" ]]
}

assert_unsupported() {
  local id="$1" version="$2" codename="$3" pretty="$4"
  OS_ID="${id}"
  OS_VERSION_ID="${version}"
  OS_CODENAME="${codename}"
  OS_MAJOR_VERSION="${version%%.*}"
  PRETTY_NAME="${pretty}"
  if automatic_packages_supported; then
    printf 'Expected unsupported platform: %s %s (%s)\n' "${id}" "${version}" "${codename}" >&2
    return 1
  fi
  [[ -z "${PACKAGE_FAMILY}" ]]
  [[ -z "${DOCKER_REPOSITORY_DISTRIBUTION}" ]]
  [[ -z "${PGDG_REPOSITORY_FAMILY}" ]]
}

assert_supported ubuntu 22.04 jammy "Ubuntu 22.04.5 LTS" apt ubuntu apt
assert_supported ubuntu 24.04 noble "Ubuntu 24.04.3 LTS" apt ubuntu apt
assert_supported ubuntu 26.04 resolute "Ubuntu 26.04 LTS" apt ubuntu apt
assert_supported debian 12 bookworm "Debian GNU/Linux 12" apt debian apt
assert_supported debian 13 trixie "Debian GNU/Linux 13" apt debian apt

for id in rhel rocky almalinux; do
  for major in 8 9 10; do
    assert_supported "${id}" "${major}.1" "" "${id} ${major}.1" rpm rhel el
  done
done

assert_supported centos 9 "" "CentOS Stream 9" rpm centos el
assert_supported centos 10 "" "CentOS Stream 10" rpm centos el
assert_supported fedora 43 "" "Fedora Linux 43" rpm fedora fedora
assert_supported fedora 44 "" "Fedora Linux 44" rpm fedora fedora

assert_unsupported ubuntu 20.04 focal "Ubuntu 20.04.6 LTS"
assert_unsupported debian 11 bullseye "Debian GNU/Linux 11"
assert_unsupported centos 9 "" "CentOS Linux 9"
assert_unsupported fedora 42 "" "Fedora Linux 42"
assert_unsupported opensuse-leap 16.0 "" "openSUSE Leap 16.0"

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT
git -C "${fixture_root}" init --quiet source
git -C "${fixture_root}/source" config user.name "Community bootstrap test"
git -C "${fixture_root}/source" config user.email "bootstrap-test@example.invalid"
printf 'tracked\n' >"${fixture_root}/source/tracked.txt"
git -C "${fixture_root}/source" add tracked.txt
git -C "${fixture_root}/source" commit --quiet -m fixture

git clone --quiet --no-checkout "${fixture_root}/source" "${fixture_root}/incomplete"
[[ ! -e "${fixture_root}/incomplete/tracked.txt" ]]
is_unmaterialized_bootstrap_checkout "${fixture_root}/incomplete"

git -C "${fixture_root}/incomplete" checkout --quiet --detach HEAD
[[ -f "${fixture_root}/incomplete/tracked.txt" ]]
if is_unmaterialized_bootstrap_checkout "${fixture_root}/incomplete"; then
  printf 'A materialized checkout was incorrectly classified as recoverable.\n' >&2
  exit 1
fi

printf 'changed\n' >"${fixture_root}/incomplete/tracked.txt"
if is_unmaterialized_bootstrap_checkout "${fixture_root}/incomplete"; then
  printf 'A dirty checkout was incorrectly classified as recoverable.\n' >&2
  exit 1
fi

printf 'Bootstrap platform matrix passed.\n'
