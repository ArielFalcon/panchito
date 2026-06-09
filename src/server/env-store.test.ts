import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEnvVars } from "./env-store";

function makeFs(initial: string | null) {
  let content = initial;
  return {
    read: () => content,
    write: (c: string) => { content = c; },
    get: () => content,
  };
}

test("applies to env object and appends each var on its OWN line (no inline comments)", () => {
  const fs = makeFs("EXISTING=1\n");
  const env: Record<string, string | undefined> = {};
  const applied = applyEnvVars({ SHOP_DEV_PASSWORD: "s3cr3t", API_KEY: "k" }, { fs, env });
  assert.deepEqual(applied.sort(), ["API_KEY", "SHOP_DEV_PASSWORD"]);
  assert.equal(env.SHOP_DEV_PASSWORD, "s3cr3t");
  assert.match(fs.get()!, /^EXISTING=1$/m);
  assert.match(fs.get()!, /^SHOP_DEV_PASSWORD=s3cr3t$/m);
  assert.match(fs.get()!, /^API_KEY=k$/m);
});

test("replaces an existing line instead of duplicating it", () => {
  const fs = makeFs("API_KEY=old\n");
  const env: Record<string, string | undefined> = {};
  applyEnvVars({ API_KEY: "new" }, { fs, env });
  const lines = fs.get()!.split("\n").filter((l) => l.startsWith("API_KEY="));
  assert.deepEqual(lines, ["API_KEY=new"]);
});

test("rejects invalid keys and values with newlines BEFORE touching anything", () => {
  const fs = makeFs("");
  const env: Record<string, string | undefined> = {};
  assert.throws(() => applyEnvVars({ "bad-key": "v" }, { fs, env }));
  assert.throws(() => applyEnvVars({ GOOD: "line1\nline2" }, { fs, env }));
  assert.equal(env.GOOD, undefined);
});

test("starts a fresh .env when no prior content exists", () => {
  const fs = makeFs(null);
  const env: Record<string, string | undefined> = {};
  applyEnvVars({ NEW_KEY: "v" }, { fs, env });
  assert.match(fs.get()!, /^NEW_KEY=v$/m);
});
