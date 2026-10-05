# Native Windows preview

This implementation belongs to ALPR Database Community. Windows and Linux use
the same application, version, database schema, authentication, integrations,
and AI models. Their installation and maintenance operations differ.

The native Windows package is a development preview. It requires no Docker or
WSL. It is not yet a published or certified Windows release.

## Targets and current evidence

| Target | Build/model evidence | Remaining acceptance |
| --- | --- | --- |
| Windows 10 22H2 x64, build 19045 | Supervised Pro VM installation, chosen-password sign-in, Settings repair, automatic startup after reboot, laptop LAN sign-in, Blue Iris read-only connection and plate-alert ingestion reported working; remote health/login HTTP checks passed | Service ACL review, LAN disable/reboot checks, ingestion persistence after reboot, image/workflow acceptance, other integrations, update, rollback and uninstall |
| Maintained Windows 11 x64 | Locked dependencies, standalone build and packaged CPU inference verified locally | Clean VM installation, service ACLs, reboot, integration, update and rollback |
| Home, Pro, Enterprise, Education | Same desktop installer; no edition-specific feature dependency | Edition acceptance on the two OS baselines |

Windows Server, ARM64, 32-bit Windows, and LTSC certification are outside this
initial target. The installer rejects Server, ARM64, 32-bit PowerShell, older
Windows 10 builds, network shares, reparse-point roots, and non-NTFS volumes.
Windows 10 compatibility does not extend Microsoft's Windows 10 support period.

## Graphical setup preview

The Windows setup executable is the user-facing installation path. It includes
the Community application, Node, WinSW, recognition models, and a graphical
password screen. Users do not need a terminal, Docker, WSL, or developer tools.

For a clean test computer:

1. Copy the maintainer-provided `ALPR-Community-...-Setup.exe` into Windows.
2. Double-click it and approve the Windows administrator prompt.
3. Choose and confirm an ALPR administrator password, then click **Install**.
   Select **Allow access from other devices on my local network** if cameras
   or another computer will connect to ALPR.
4. Wait for setup to finish. Click **Finish** to open ALPR in the browser.
   Sign in with that password; leave the username blank on the initial login.

An internet connection is required. Setup downloads PostgreSQL 17.10 and FFmpeg
8.1.2 directly from their publishers using fixed versions and SHA-256 checksums.
It installs the Microsoft Visual C++ x64 runtime when needed, verifying its
checksum and Microsoft signature. If that component requires a reboot, restart
Windows and run setup again. PostgreSQL and FFmpeg are copied into the protected
application directory, so users do not need to maintain separate tool folders.

Setup checks the OS, package inventory, ports, and all three recognition models
before creating ALPR services or its database. Download/extraction scratch space
is private to the installer and removed when it exits. The chosen password is
passed through a private temporary file rather than a command-line argument.

An **ALPR Database Community** shortcut opens the application. Windows **Apps &
features** can remove the app and its services while preserving plate records,
images, settings, and backups in `C:\ProgramData\ALPR Community`. This fresh-install
preview refuses existing installations and retained data; guided repair,
reinstallation, and upgrades are still release work. Use a clean VM for the first
installer test and retain its pre-installation backup for repeatable testing.

The current setup executable is unsigned and intended for maintainer-supervised
testing. Windows may show an unknown-publisher or SmartScreen prompt. Signing,
public distribution, and the remaining desktop acceptance gates are required
before recommending it to community users.

The setup build executes a compiled startup probe before producing the installer.
It creates the real password controls and temporary workspace name, then exits
before installation. The probe includes no payload or installation actions and
requires no administrator privileges. It also runs on Windows Server CI without
changing the desktop OS requirements of the delivered installer. This catches
script runtime errors that successful Inno compilation alone cannot detect;
actual VM installation, service, reboot, and uninstall acceptance remain separate.

The runtime test signs in with the chosen password and requests every Settings
page with the build checkout made unavailable. Release metadata uses a static
JSON import so the standalone bundle carries its version rather than resolving
package.json from the maintainer's machine.

### Supervised Settings repair

For an already-installed preview with the Settings packaging defect, a maintainer
can build a separate graphical repair from a verified fixed package and the exact
previous package:

~~~powershell
node scripts/build-windows-repair.mjs 'dist\FIXED_PACKAGE' 'dist\INSTALLED_PACKAGE'
~~~

Users double-click that repair executable, approve elevation, and click **Repair**.
It verifies the exact installed source commit and every target checksum, requires
an unchanged version, schema, and migration file, stages the new code, records the
previous protected installation metadata, and restarts only the application.
It preserves the password, configuration, images and database. It runs no schema
migration or database restore. A failed startup restores the previous application
selection and checks that its service owns the listener. Both code releases and
the protected repair record remain available. This supervised repair does not
replace the planned general upgrade, reinstallation, or repair workflow.

## Local network access

Localhost is the default. Selecting network access listens on all IPv4 interfaces
and creates one owned Windows firewall rule for the application port (normally
3000), TCP, with remote addresses restricted to `LocalSubnet` and edge traversal
blocked. It applies to all Windows network profiles so the same home network
works even when Windows labels it Public; it does not change that profile.
The database remains on loopback and no database firewall rule is created.
This option is for a local network; it does not set up internet access or HTTPS.

For an already-installed supervised preview, the maintainer can build the small
graphical tool with `node scripts/build-windows-network.mjs` from clean source.
It requires the original preview commit in Git history to pin the existing
uninstaller checksum. Users double-click `ALPR-Network-Access-...exe`, approve
elevation, leave **Allow other computers and cameras on my local network**
selected, and click **Apply**. The tool displays the addresses to open from
other devices. Choose **Only this computer** and apply again to disable access.

The tool verifies release checksums and service ownership under the shared
maintenance lock. It refuses pending updates and unexpected firewall rules,
preserves credentials and stored data, and restarts only the application.
It verifies health, process ownership and listener binding after the change.
If the change fails, it restores the previous binding and firewall state.
It also upgrades the exact original preview's uninstall script so uninstall
removes the owned LAN rule. No database migration or restore runs.

Automated tests use isolated fixtures and mocked service/firewall commands;
compiled wizard startup also runs without installation or elevation. Actual
desktop elevation, firewall enforcement and access from another LAN device
remain acceptance checks on Windows 10 and Windows 11.

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
yarn package:windows:setup --package 'dist\alpr-community-VERSION-COMMIT-windows-x64' --preview
~~~

Replace the setup command's package path with the directory printed by the native
package build. The setup builder downloads a checksum-pinned Inno Setup 6.7.3
compiler in portable mode into the build cache. It does not install a compiler
or ALPR services on the build machine. The output in `dist\setup` includes the
single setup executable, its SHA-256 sidecar, and a build record identifying the
payload commit and prerequisite pins. Build setup from the same clean source
commit as its native package.

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

The graphical installer acquires PostgreSQL and FFmpeg automatically. The
unwrapped native package also supports the operator workflow below with existing
prerequisites. Signed distribution and release asset publishing remain release
work.

## Operator installation from the native package

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

The app starts automatically after the database service and restarts after failure.
Its automatic startup is delayed, so ALPR may need a short wait after a reboot.
WinSW sends Ctrl+C and allows 60 seconds for Next.js to shut down. Application/service
logs and PostgreSQL logs have bounded rotation. Initial administrator login is
saved in management\initial-login.txt, accessible to Administrators; store the
password and delete that file after first sign-in.

Localhost is the default. `ListenOnNetwork` deliberately changes the app listener
to `0.0.0.0` and creates the local-subnet application firewall rule described
above. Network access requires this explicit installer selection. An operator
must separately configure HTTPS and access controls for use beyond a local LAN.

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
   Exercise the graphical setup with a normal Windows account, administrator
   elevation, chosen-password login, component downloads, cancellation,
   restart-required handling, shortcuts, and uninstall with retained data.
2. Verify app and database service accounts, service SIDs, NTFS ACL inheritance,
   protected secrets/backups, and absence of write access to code from the app.
3. Reboot; confirm database/app startup order, health, and graceful stop/restart.
   Enable local network access and verify signed-in use from another device;
   disable it and verify remote refusal with localhost still working. Confirm
   uninstall removes only the owned firewall rule and preserves stored data.
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
