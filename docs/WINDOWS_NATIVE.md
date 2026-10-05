# Native Windows preview

This implementation belongs to ALPR Database Community. Windows and Linux use
the same application, version, database schema, authentication, integrations,
and AI models. Their installation and maintenance operations differ.

The native Windows package is a development preview. It requires no Docker or
WSL. It is not yet a published or certified Windows release.

## Targets and current evidence

| Target | Build/model evidence | Remaining acceptance |
| --- | --- | --- |
| Windows 10 22H2 x64, build 19045 | Explicit installer target; OS checks tested | Clean VM installation, service ACLs, reboot, integration, update and rollback |
| Maintained Windows 11 x64 | Locked dependencies, standalone build and packaged CPU inference verified locally | Clean VM installation, service ACLs, reboot, integration, update and rollback |
| Home, Pro, Enterprise, Education | Same desktop installer; no edition-specific feature dependency | Edition acceptance on the two OS baselines |

Windows Server, ARM64, 32-bit Windows, and LTSC certification are outside this
initial target. The installer rejects Server, ARM64, 32-bit PowerShell, older
Windows 10 builds, network shares, reparse-point roots, and non-NTFS volumes.
Windows 10 compatibility does not extend Microsoft's Windows 10 support period.

## Build a preview

On Windows x64 with Node.js 24 and Yarn Classic:

~~~powershell
yarn install --frozen-lockfile --ignore-scripts
node scripts/install-openvino-runtime.mjs
yarn test
yarn typecheck
yarn lint
yarn test:sanitize
yarn package:windows --preview
~~~

Packaging always rebuilds the application and embeds the exact source commit
and preview/stable channel. Stable packages require a clean exact version tag.
The preview records its base commit and the checksums of all shipped files;
uncommitted development changes are explicitly labeled preview.

The output under dist contains the standalone app, the build's Node.exe,
checksum-pinned WinSW 2.12.0, native OpenVINO DLLs, all three AI models,
the installer, fixed service control, schema, migrations, and maintenance CLI.
The packaging gate runs CPU inference for detection, embedding, and attributes
using the final bundled Node.exe and loads Sharp, bcrypt, pg, and MQTT there.
Dependency licenses and third-party source links accompany the package.

PostgreSQL and FFmpeg are operator-installed prerequisites in this preview.
The Node runtime and WinSW are bundled. Automatic prerequisite acquisition,
signed distribution, and release asset publishing remain release work.

## Fresh installation

Use a clean test VM initially. Install PostgreSQL 17 command-line tools and an
FFmpeg distribution containing ffmpeg.exe and ffprobe.exe. Install the Microsoft
Visual C++ x64 runtime required by OpenVINO if its DLL loading probe reports it
missing. PostgreSQL's installer may create its own database service; ALPR creates
a separate cluster and service, defaulting to loopback port 5433.

Open a 64-bit PowerShell window in the verified package directory:

Extract the package into a short path, such as C:\ALPR-downloads. The installer
refuses file paths beyond inbox PowerShell's legacy path limit before mutation.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -CheckOnly -AllowPreview -FfmpegBin 'C:\Tools\ffmpeg\bin'
~~~

CheckOnly verifies OS, files, package hashes, prerequisites, unused installation
locations, available ports, and model inference. It does not initialize a
database, create directories, register services, or modify firewall rules.

This execution policy applies only to the installer process. It does not change
the machine or user policy.

After those checks pass, run the same command in an elevated PowerShell window
without CheckOnly. Use AllowPreview only for an explicitly trusted development
package. Verify a distributed package against its maintainer-provided checksum
before running any installer or bundled executable.

Defaults:

| Resource | Location |
| --- | --- |
| Application and replaceable releases | C:\Program Files\ALPR Community |
| Authentication/configuration/images/logs | C:\ProgramData\ALPR Community |
| Private database, backups, initial login | Data root\management |
| Application service | ALPRCommunityApp, LocalService with service SID |
| Database service | ALPRCommunityDatabase, NetworkService with service SID |
| Application listener | 127.0.0.1:3000 |
| Database listener | 127.0.0.1:5433 |

InstallRoot, DataRoot, PgBin, FfmpegBin, AppPort, and DatabasePort are configurable.
The release and data roots must be separate and unused. The app service has read
access to code and modification rights only on its own runtime directories.
Database files and rollback backups exclude the app service. Secrets are
generated locally and stored under protected NTFS ACLs, never in source.

The app starts after the database service and restarts after failure. WinSW
sends Ctrl+C and allows 60 seconds for Next.js to shut down. Application/service
logs and PostgreSQL logs have bounded rotation. Initial administrator login is
saved in management\initial-login.txt, accessible to Administrators; store the
password and delete that file after first sign-in.

Localhost is the default. ListenOnNetwork deliberately changes the app listener
to 0.0.0.0. Configure an appropriate firewall rule and HTTPS proxy for remote
users/cameras. The installer does not silently open inbound network access.

A failed install stops only services it registered and preserves its data and
private installer-error.txt for diagnosis. It does not delete an existing
installation or database. CheckOnly refuses an already-used installation.

## Native maintenance preview

Run maintenance from an elevated PowerShell window. The browser's Software
Updates page identifies native preview mode and cannot submit host operations.

~~~powershell
$env:ALPR_WINDOWS_INSTALLATION = 'C:\Program Files\ALPR Community\installation.json'
$env:ALPR_WINDOWS_PREVIEW = 'ALPR_WINDOWS_PREVIEW_APPROVED'
$node = 'C:\Program Files\ALPR Community\runtime\node.exe'
$maintenance = 'C:\Program Files\ALPR Community\host\windows-maintenance.mjs'
& $node $maintenance status
~~~

A Windows update requires an already-extracted, newer, trusted package and the
independently obtained SHA-256 of its windows-package.json. It verifies every
file and stages/probes the package before stopping the existing app.

~~~powershell
$env:ALPR_UPDATE_ACKNOWLEDGE = 'ALPR_UPDATE_APPROVED'
& $node $maintenance update --package 'C:\ALPR-downloads\verified-package' --manifest-sha256 'MAINTAINER_PROVIDED_64_HEX_MANIFEST_HASH'
& $node $maintenance validate
~~~

The update records a custom-format PostgreSQL dump, dump checksum, exact table
counts, auth/configuration checksums, and each stored image's checksum before
migration. Auth/configuration and images stay outside releases. Technical checks
require healthy startup, the target version/commit, nondecreasing table counts,
and preservation of every pre-update stored image.
The controller also verifies the Windows service process tree and TCP listener
owner against the target release's Node.exe.

After verifying sign-in, search, ingestion, images, integrations, and restart:

~~~powershell
$env:ALPR_UPDATE_ACCEPTANCE = 'ALPR_UPDATE_ACCEPTED'
& $node $maintenance accept
~~~

Rollback discards database writes made after the pre-update dump. Confirm that
decision before setting its acknowledgement:

~~~powershell
$env:ALPR_UPDATE_ROLLBACK = 'ALPR_UPDATE_ROLLBACK'
& $node $maintenance rollback
~~~

Rollback verifies the dump/private files before stopping the app, restores the
public schema in one PostgreSQL transaction, preserves native directory ACLs,
restores auth/configuration and installation metadata, selects the previous
release, and checks exact table counts and retained images.

One recorded rollback generation remains. Accepted backups have 14-day retention.
Clean that generation before starting a subsequent preview update. Cleanup removes
only its recorded backup; it leaves releases and all live data in place.

~~~powershell
$env:ALPR_UPDATE_CLEANUP = 'ALPR_UPDATE_CLEANUP'
& $node $maintenance cleanup
~~~

A failed backup restarts the existing app when possible. A failure after migration
starts requires explicit validation or rollback. A concurrent-maintenance lock
refuses a second process; after a crash, verify no maintenance process is running
before removing management\backups\maintenance.lock. Do not remove the backup state.

Automatic release discovery, background agent/service privileges, and browser
installation are intentionally disabled for the preview. The Linux updater is
unchanged. A future Windows agent must use the same restricted request protocol,
protected release destinations, fixed operations, and canonical release checks.

## Cross-platform import

Do not copy PostgreSQL's physical data directory between operating systems.
Use a logical custom-format dump from an acknowledged stopped source, its
checksum, and an independent image/configuration/authentication export.
Restore into an isolated Windows PostgreSQL 17 installation first, migrate the
schema, and compare exact table counts and image manifests before activation.
Stored image references use forward slashes; legacy backslash references are
resolved safely on either OS. Credentials and NTFS ACLs must be recreated for
the destination. The existing guided Linux migration wizard does not install
Windows services.

## Release acceptance gates

For BOTH a clean Windows 10 22H2 x64 VM and a maintained Windows 11 x64 VM:

1. Install with unused paths, including paths containing spaces. Confirm
   non-admin prerequisite checking, invalid-platform refusal, dependency
   failure refusal, and port-conflict refusal before mutation.
2. Verify app and database service accounts, service SIDs, NTFS ACL inheritance,
   protected secrets/backups, and absence of write access to code from the app.
3. Reboot; confirm database/app startup order, health, and graceful stop/restart.
4. Sign in and ingest synthetic reads with images. Exercise search, dashboard,
   exports, all three AI models, and file/media retrieval.
5. Exercise a real Blue Iris camera, MQTT, and FFmpeg timeline export against
   operator-authorized test endpoints. Validate a Linux-to-Windows logical import.
6. Apply a newer Windows package. Verify backup, migration, acceptance/retention,
   corrupted-package refusal, interrupted backup, migration/start failure,
   transactional rollback, and preservation of protected data.
7. Pass the unchanged Linux CI and Docker runtime gates.

Windows CI provides build/unit/package evidence; its Windows Server runner does
not replace either desktop VM acceptance target. Do not publish a certified
Windows installer until these gates have recorded results.
