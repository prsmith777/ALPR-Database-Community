# Community release documentation checklist

Use this checklist for every stable Community release. Documentation changes
belong in the feature or fix pull request whenever possible; the final release
pull request verifies that the complete published surface is synchronized.

## Required for every release

1. Set the exact semantic version in `package.json`.
2. Add the release at the top of `CHANGELOG.md` with the user-visible changes,
   compatibility impact, and documentation changes.
3. Update `lib/release-info.mjs` and its tests so **Settings → Release** shows
   the correct title, date, and concise release notes.
4. Update exact-tag examples in `docs/INSTALL.md` and `docs/UPDATES.md`.
5. Update the version placeholder in `.github/ISSUE_TEMPLATE/bug_report.yml`.
6. Run the complete test, sanitation, typecheck, lint, application-build, and
   Docker-image gates before merging.
7. Create the GitHub release from the exact merge commit on `main`, then verify
   that it is the latest non-draft, non-prerelease release and that the release
   workflow attached `alpr-community-bootstrap.sh`, `community-maintenance.sh`,
   and a separate SHA-256 checksum for each.
8. Download both scripts and their checksum assets and independently verify
   the SHA-256 checksums.

Automated tests compare the package version with the changelog, install guide,
update guide, and bug-report form. They supplement this review; they do not
prove that prose is complete or operationally correct.

## Required when behavior changes

- Update `lib/help-manual.mjs`, increment its manual version, update its review
  date, and adjust `test/help-manual.test.mjs` and
  `test/release-info.test.mjs`.
- Review every visible Settings page affected by the change and keep
  `lib/settings-help-coverage.mjs` synchronized with its routes and important
  terms.
- Update the relevant README, bootstrap, compatibility, installation,
  migration, deployment, update, security, or contributing guidance.
- Test the host updater as well as the import validator when migrations remove
  derived tables. Cover stopped-source evidence, protected-data loss refusal,
  verified backup, transactional rollback, retry, and long-lived agent imports.
- Add recovery and troubleshooting instructions for a failure that users can
  encounter in a supported workflow.
- Verify commands, paths, ports, acknowledgement phrases, minimum resources,
  supported operating systems, bundled dependency versions, and links against
  the implementation rather than copying them from an older release.

## Required when product status changes

Update `docs/COMMUNITY_PRODUCT_ROADMAP.md` when a capability ships, is removed,
changes support status, or is reprioritized. Do not edit its review date merely
to make it look current; review the **Available now**, **Intentionally not
shipped**, and **Prioritized later work** sections against the actual release.

## GitHub-facing review

- Confirm the repository description and homepage lead to current Community
  information rather than legacy Original ALPR documentation.
- Confirm Discussions, Issues, and private vulnerability reporting are
  available and that all links in README, the Help Center, `CONTRIBUTING.md`,
  `SECURITY.md`, and the issue chooser reach the intended destination.
- Review Windows and Linux quick-start links, setup choices, backup/migration
  instructions, supported platform labels and issue-form options. When a feature
  ships, remove obsolete preview and unfinished-gate claims from current guides.
- If a GitHub wiki or Pages site exists, update its navigation to the versioned
  guides; keep detailed instructions in the repository to avoid divergent copies.
- Keep public examples synthetic and remove credentials, real plates, private
  addresses, camera imagery, database content, and operator-specific paths.

Not every document needs a textual change in every release. A document that is
unaffected should still be reviewed; changing an accurate page solely to create
release churn makes future audits harder.
