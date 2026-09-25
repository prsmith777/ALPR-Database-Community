# Fresh Community installation

This guide creates a new, empty ALPR Database Community installation. It does
not import an existing database. Existing-system operators should use the
[guided migration runbook](MIGRATION_GUIDE.md) and keep the source system
unchanged until migration acceptance is complete.

## Supported host

The first guided installer supports an x86-64 Linux host with:

- Docker Engine with a running daemon;
- the Docker Compose plugin (`docker compose`);
- Git;
- Node.js 24; and
- at least 8 GiB of free space during the image build.

A Linux virtual machine is supported regardless of whether its physical host
uses Unraid, Proxmox, VMware, Hyper-V, VirtualBox, or another hypervisor. The
guest operating system, Docker Engine, and Compose determine compatibility.
Native Windows Docker and appliance-managed NAS container interfaces are not
supported by this first installer; use a Linux VM until a separately tested
adapter is available.

Install Docker Engine and Compose from the
[official Docker documentation](https://docs.docker.com/engine/install/) and
Node.js 24 from the [official Node.js downloads](https://nodejs.org/en/download).
The installer validates prerequisites but does not modify operating-system
packages or firewall rules.

Verify the host before downloading ALPR:

```bash
docker version
docker compose version
docker info >/dev/null && echo "Docker operational"
git --version
node --version
```

`node --version` must report major version 24. Run the installer as the normal
account that owns the release checkout and has permission to use Docker. Do not
run the whole installer with `sudo`.

## Interactive installation

Clone the canonical repository and detach at the exact stable release tag:

```bash
git clone https://github.com/prsmith777/ALPR-Database-Community.git
cd ALPR-Database-Community
git checkout --detach v0.1.29
./alpr-community install
```

The installer asks for:

1. an administrator password containing 12 through 128 characters;
2. an IANA time zone such as `America/Denver` or the safe `UTC` default;
3. the application port, normally `3000`; and
4. the loopback-only PostgreSQL port, normally `5432`.

The administrator password may contain ordinary symbols, including `$` and
`#`, but not quotes, backslashes, line breaks, NUL characters, or leading or
trailing whitespace. Input is hidden. The installer generates a separate
high-entropy database password; the user never needs to enter that generated
value.

Before changing Docker state, the installer refuses:

- a dirty or untagged source checkout, non-ignored untracked files, a
  noncanonical Git remote, or a tag
  that does not resolve to the same commit on canonical `origin/main`;
- a preexisting `.env` or completed installer state;
- preexisting `auth/`, `config/`, `storage/`, or `update-control/` directories;
- a colliding Compose project, volume, network, or host port;
- an image whose recorded source revision disagrees with the release; or
- insufficient disk space.

It then creates a private `.env`, builds a commit-qualified image, assigns the
application runtime directories to container UID/GID `1000`, and creates a
set-group-ID `update-control/` directory shared only with the installing host
account's primary group. It then starts PostgreSQL, applies the migrations
transactionally, and starts the application. Installation succeeds
only after all of these checks pass:

- PostgreSQL is ready;
- `/api/health-check` returns `{"status":"ok"}`;
- the running image and OCI revision label match the exact release commit;
- plates, reads, known plates, tags, plate tags, and notifications are empty;
- staging-fixture tables are absent; and
- the clean-install image-migration marker is complete.

No sample or test records are loaded.

## First sign-in

Open the address printed at completion, replacing `SERVER_ADDRESS` with the
Linux host or VM address when necessary:

```text
http://SERVER_ADDRESS:3000
```

Leave the username blank and enter the administrator password chosen during
installation. The generated database password in `.env` is not an application
login password. Create a named administrator under Settings after sign-in.

To enable browser-managed updates on a systemd-based Linux host, run this once
from the installation directory as the same normal account:

```bash
./alpr-community agent install
sudo loginctl enable-linger "$USER"
```

The second command allows the per-user agent to start after a reboot without
an interactive login. Open **Settings → Software Updates** and confirm the
agent is shown as ready. Hosts without systemd can run
`./alpr-community agent run` under their existing service supervisor; the
terminal updater remains available through `./alpr-community`.

Verify the installation from the host:

```bash
curl --fail http://127.0.0.1:3000/api/health-check
docker compose ps
./alpr-community install --status
```

The status command displays only release, ports, project identity, and
validation state. It never displays either password. `.env` and the installer
state file are private runtime files excluded from Git.

## Non-interactive installation

Interactive installation is preferred because it keeps the administrator
password out of command history. For controlled automation, supply the values
through a protected secret store or private process environment:

```bash
export ALPR_INSTALL_ADMIN_PASSWORD='choose-a-private-password'
export ALPR_INSTALL_TIMEZONE='UTC'
export ALPR_INSTALL_APP_PORT='3000'
export ALPR_INSTALL_DB_PORT='5432'
export ALPR_INSTALL_ACKNOWLEDGE='ALPR_FRESH_INSTALL'
./alpr-community install
unset ALPR_INSTALL_ADMIN_PASSWORD ALPR_INSTALL_ACKNOWLEDGE
```

`ALPR_INSTALL_PROJECT_NAME` may optionally set a unique lowercase Compose
project name. The same collision and emptiness checks apply in non-interactive
mode.

## Interrupted-install recovery

A normal installation failure triggers automatic cleanup of only the exact
Compose project, volumes, runtime directories, environment file, and image
recorded as created by that attempt. It never runs `docker system prune`,
deletes unrelated volumes, or touches a preexisting nonempty directory.

Power loss or forced process termination can interrupt cleanup. Inspect the
redacted record, then request the narrow recovery explicitly:

```bash
./alpr-community install --status
ALPR_INSTALL_RECOVERY=ALPR_RECOVER_FAILED_INSTALL \
  ./alpr-community install --recover
```

Recovery refuses a completed installation. It also refuses to remove `.env`
if that file changed after installation began, preventing cleanup from erasing
configuration that an operator subsequently adopted or edited. If the
recorded `.env` is missing, recovery preserves its state and stops so it cannot
strand Docker resources without their recovery record.

After a successful installation, use the
[Community update guide](UPDATES.md) for exact-tag updates, acceptance,
rollback, and bounded cleanup.
