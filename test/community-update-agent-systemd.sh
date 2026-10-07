#!/usr/bin/env bash
# Disposable CI account only: exercise actual systemd, sudo, and no-login startup.
set -euo pipefail
[[ "${CI:-}" == true && "$EUID" == 0 ]] || { echo 'Run only as root on a disposable CI runner'; exit 2; }
node_binary="$1"
fixture_owner="alpr-helper-ci"
fixture_home="$(mktemp -d /tmp/alpr-helper-ci.XXXXXXXX)"
sudoers_file="/etc/sudoers.d/alpr-helper-ci"
[[ ! -e "$sudoers_file" ]] && ! id "$fixture_owner" >/dev/null 2>&1
cleanup() {
  local result=$?
  if [[ "$result" != 0 ]]; then
    fixture_uid="$(id -u "$fixture_owner" 2>/dev/null || true)"
    if [[ -n "$fixture_uid" ]]; then
      systemctl status "user@${fixture_uid}.service" --no-pager || true
      journalctl --no-pager --unit="user@${fixture_uid}.service" --lines=60 || true
      journalctl --no-pager "_UID=$fixture_uid" --lines=60 || true
    fi
  fi
  loginctl disable-linger "$fixture_owner" || true
  fixture_uid="$(id -u "$fixture_owner" 2>/dev/null || true)"
  if [[ -n "$fixture_uid" ]]; then systemctl stop "user@${fixture_uid}.service" || true; fi
  userdel "$fixture_owner" || true
  rm -f -- "$sudoers_file"
  [[ "$fixture_home" == /tmp/alpr-helper-ci.* ]] && rm -rf -- "$fixture_home"
}
trap cleanup EXIT
useradd --user-group --home-dir "$fixture_home" --shell /bin/bash "$fixture_owner"
mkdir -p "$fixture_home/app/scripts" "$fixture_home/app/lib"
cp scripts/community-update-agent{,-setup}.mjs scripts/community-updater-process.mjs "$fixture_home/app/scripts/"
cp lib/community-update-{control,shape}.mjs "$fixture_home/app/lib/"
cp test/community-update-agent-systemd.mjs "$fixture_home/app/verify.mjs"
chown -R "$fixture_owner:$fixture_owner" "$fixture_home"
chmod 700 "$fixture_home"
printf '%s ALL=(root) NOPASSWD: /usr/bin/loginctl enable-linger %s\n' "$fixture_owner" "$fixture_owner" > "$sudoers_file"
chmod 440 "$sudoers_file"
visudo -cf "$sudoers_file"
run_owner() {
  sudo -u "$fixture_owner" -H env -u XDG_RUNTIME_DIR -u DBUS_SESSION_BUS_ADDRESS "$node_binary" "$fixture_home/app/verify.mjs" "$@"
}
echo "Installing and verifying helper for the account without a login session"
run_owner install
echo "Verified initial helper heartbeat and persistent enablement"
fixture_uid="$(id -u "$fixture_owner")"
echo "Restarting the isolated account user manager"
systemctl restart "user@${fixture_uid}.service"
echo "User manager restarted; checking its automatic helper startup"
run_owner verify-startup
run_owner preserve
echo 'Real Linux helper installation, no-login user-manager restart, fresh heartbeat and idempotency passed.'
