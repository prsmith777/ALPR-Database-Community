# Security policy

## Supported version

Security fixes are applied to the latest release on the `main` branch. Update
to the newest published image or release before reporting an issue that may
already have been corrected.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
**Security** tab by selecting **Report a vulnerability**. Do not open a public
issue containing credentials, license-plate data, images, private network
details, or reproduction steps for an unpatched vulnerability.

Include the affected version, deployment type, impact, and the smallest safe
set of reproduction steps. Remove API keys, passwords, session cookies,
database contents, and personally identifying plate data from logs and
screenshots.

If private vulnerability reporting is unavailable, open a public issue that
only requests a private contact channel and contains no vulnerability details.

## Deployment guidance

- Replace all example passwords before first startup.
- Do not publish PostgreSQL port 5432 beyond the Docker host unless it is
  protected by an explicit firewall and strong credentials.
- Use HTTPS and set `SESSION_COOKIE_SECURE=true` when the dashboard is exposed
  beyond a trusted private network.
- Keep the dashboard, base image, and PostgreSQL image updated.
- Run the dashboard only on a supported Node.js LTS release. The production
  image and CI currently use Node.js 24.
- Treat the API key, session cookie, MQTT credentials, configuration files,
  backups, logs, plate images, and database as sensitive data.
