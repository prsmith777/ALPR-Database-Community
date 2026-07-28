import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repositorySource = await readFile(
  new URL("../lib/identity-repository.mjs", import.meta.url),
  "utf8"
);

test("audit event actor parameters are explicitly typed as bigint", () => {
  assert.doesNotMatch(repositorySource, /VALUES \(\$1, 'browser'/);
  assert.match(
    repositorySource,
    /VALUES \(\$1::bigint, 'browser', 'identity\.owner_bootstrapped', 'user', \$1::text/
  );
  assert.match(
    repositorySource,
    /VALUES \(\$1::bigint, 'browser', 'auth\.login', 'user', \$1::text, 'succeeded'\)/
  );
});

test("failed-login throttling is persisted and updated atomically", () => {
  assert.match(repositorySource, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(repositorySource, /INSERT INTO public\.login_attempt_limits/);
  assert.match(repositorySource, /ON CONFLICT \(subject_hash\) DO UPDATE/);
  assert.match(repositorySource, /make_interval\(secs => \$4::double precision\)/);
  assert.match(repositorySource, /updated_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'/);
  assert.match(repositorySource, /DELETE FROM public\.login_attempt_limits/);
});
