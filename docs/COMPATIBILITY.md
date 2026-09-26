# Host compatibility and recovery paths

ALPR Database Community is supported on Linux x86-64. The automatic package
installer uses explicit APT and RPM adapters so package names, repositories,
service control, and rollback behavior remain predictable.

| Host situation | Supported path |
| --- | --- |
| Ubuntu 22.04, 24.04, or 26.04 x86-64 | Run the automated bootstrap in new-install or migration-preparation mode. Ubuntu 24.04 remains the simplest recommended VM choice. |
| Debian 12 or 13 x86-64 | Run the automated bootstrap in new-install or migration-preparation mode. |
| Current RHEL, Rocky Linux, or AlmaLinux 8, 9, or 10 x86-64 | Run the automated bootstrap. Patch to the current supported minor release before migration so the PostgreSQL repository matches the host. |
| CentOS Stream 9 or 10 x86-64 | Run the automated bootstrap. Other CentOS variants are not accepted by the automatic adapter. |
| Fedora 43 or 44 x86-64 | The automatic adapter works, but Fedora's short support cycle makes an LTS or enterprise distribution preferable for a long-lived server. |
| Existing ALPR moving to a separate supported Linux target | Run migration preparation on the target, then use the automated migration wizard. This is the recommended migration path. |
| Other x86-64 Linux distribution or version | Run the read-only check. Install equivalent prerequisites manually, then use the exact-tag installer or migration wizard. Automatic package changes are not performed. |
| Native Windows Docker, WSL controlling Windows Docker, or appliance container UI | Not supported by the current installer/updater. Use a supported x86-64 Linux VM. |
| ARM/AArch64 | Not currently supported. |

## If a compatibility check fails

The check does not repair or modify the host. Read the reported failures and
choose one of these paths:

1. Create a supported Ubuntu 24.04 LTS x86-64 destination VM and rerun the
   bootstrap. This remains the lowest-complexity choice.
2. On another x86-64 Linux distribution, manually install Docker Engine,
   Compose v2, Buildx, Git, and Node.js 24. Migration hosts also need
   PostgreSQL 17 clients, `rsync`, and OpenSSH. Rerun the check before ALPR.
3. Upgrade the guest operating system and dependencies using that
   distribution's documented process, then rerun the check. Back up the host
   first; ALPR does not automate operating-system upgrades.

Do not remove or replace an existing Docker installation merely to satisfy the
bootstrap. It deliberately refuses conflicting packages and leaves that
decision to the host operator.

The automatic matrix tracks upstream repository support. When a distribution
release reaches end of life or its upstream Docker or PostgreSQL repository no
longer supplies the required packages, move to a maintained release; the
bootstrap does not perform operating-system upgrades.

## Runtime components versus host tools

The host runs Git, Node.js 24, Docker Engine, Compose, and Buildx. PostgreSQL 17
client utilities are host requirements only for database migration. The ALPR
application, PostgreSQL server, OpenVINO 2025.4 runtime, ReID code, and pinned
models run inside versioned Docker images. Optional Blue Iris, MQTT, email,
Pushover, and webhook connections require credentials and endpoints in
Settings, but no additional ALPR host packages.

## Capacity guidance

The enforced bootstrap floor is 2 logical CPUs, 4 GiB RAM, and 20 GiB free
before application data. For normal use, allocate at least 4 vCPU, 8 GiB RAM,
and 100 GiB disk. Image retention, database growth, and backup policy determine
long-term storage needs. Heavy visual search or large image libraries may need
more CPU, RAM, and disk.
