# Contributing and getting help

Thank you for helping improve ALPR Database Community. The project accepts bug
reports, feature requests, documentation corrections, questions, and pull
requests. Support is provided on a best-effort basis by a single maintainer.

## Choose the right channel

- [Ask a question or leave general feedback](https://github.com/prsmith777/ALPR-Database-Community/discussions)
  in GitHub Discussions.
- [Report a reproducible bug](https://github.com/prsmith777/ALPR-Database-Community/issues/new?template=bug_report.yml)
  with the structured bug form.
- [Request a feature](https://github.com/prsmith777/ALPR-Database-Community/issues/new?template=feature_request.yml)
  after checking the
  [Community product roadmap](docs/COMMUNITY_PRODUCT_ROADMAP.md).
- [Report a security vulnerability privately](https://github.com/prsmith777/ALPR-Database-Community/security/advisories/new).
  Never disclose an unpatched vulnerability in an issue or discussion.

Search existing issues and discussions before creating a new report. If a bug
is already fixed in the latest stable release, update through **Settings →
Software Updates** or the guarded terminal updater before opening an issue.

## Protect private data

GitHub issues, discussions, comments, and pull requests are public. Never post:

- passwords, API keys, session cookies, database credentials, or broker
  credentials;
- `.env`, authentication, configuration, database dump, or backup files;
- real license-plate values, vehicle or person images, or personally
  identifying metadata;
- camera URLs, private network addresses, hostnames, filesystem paths, or
  integration endpoints; or
- long logs when a short, redacted excerpt demonstrates the problem.

Use synthetic plate values and crop or blur every screenshot before uploading
it. If you accidentally disclose a secret, rotate it immediately; editing a
GitHub comment does not guarantee that every copy has disappeared.

## Make a useful bug report

Include the Community release, installation type, sanitized platform details,
steps to reproduce, expected behavior, actual behavior, and the smallest safe
diagnostic excerpt. Test the latest stable release when practical. Do not use a
public bug report for a suspected security vulnerability.

## Submit a pull request

Create a focused branch from `main`, keep unrelated changes out of the commit,
and explain the user-visible result. The supported development runtime is
Node.js 24 with Yarn 1. Before submitting, run:

```bash
corepack yarn install --frozen-lockfile
yarn test
yarn test:sanitize
yarn lint
yarn build
```

The sanitation check must pass. Do not add real runtime data, private
deployment details, credentials, database dumps, or user imagery to tests,
fixtures, documentation, or commit history.
