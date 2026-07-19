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
