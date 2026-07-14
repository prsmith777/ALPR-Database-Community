# Repository Development Rules

- Never log credentials, tokens, session identifiers, API keys, passwords, or other secrets.
- Avoid logging license plates or other sensitive data unless operationally necessary.
- Authentication and authorization must fail closed.
- Privileged server actions and API routes must perform their own authorization checks.
- Preserve Blue Iris compatibility unless a breaking change is explicitly documented.
- Keep pull requests small, focused, and reviewable.
- Require tests for security-sensitive behavior.
- Do not modify database schemas without a versioned migration and rollback plan.
- Never commit real secrets or production configuration.
- Do not merge a security-sensitive pull request until its tests and diff have been reviewed.
