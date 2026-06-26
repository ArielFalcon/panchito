// PARITY: the lifted pure classifiers must match src/qa/confinement.ts byte-for-byte until Plan 7
// deletes the legacy originals. Imports from src/ (outside qa-engine rootDir) — excluded from
// qa-engine typecheck (see qa-engine/tsconfig.json), runs via tsx at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";
import {
  parseStatusOutput,
  isE2eStray,
  isCodeDenied,
  isDangerousPath,
  classifyStrays,
} from "../../../../../src/qa/confinement.ts";

const svc = new WriteConfinementService();

// Representative path table covering: rename lines, quoted paths, .env.*, case-insensitive
// DOCKERFILE, suffix *.env, .github/ directory prefix, docker-compose*, ordinary paths.
const STATUS_OUTPUTS = [
  // Rename line
  'R  old.ts -> new.ts',
  // Quoted path with spaces
  '?? "spa ced.ts"',
  // Untracked file in e2e
  '?? e2e/a.spec.ts',
  // Modified src file
  ' M src/app.ts',
  // Multiple lines combined
  'R  old.ts -> new.ts\n?? "spa ced.ts"\n M e2e/a.spec.ts\n?? src/helper.ts',
  // Copy entry
  'C  original.ts -> copy.ts',
  // Empty output
  '',
];

test("PARITY: parseStatusOutput matches legacy across the representative table", () => {
  for (const out of STATUS_OUTPUTS) {
    const legacy = parseStatusOutput(out);
    const local = svc.parseStatusOutput(out);
    assert.deepEqual(local, legacy, `input: ${JSON.stringify(out)}`);
  }
});

const E2E_STRAY_PATHS = [
  "src/x.ts",
  "e2e/a.spec.ts",
  "e2e",
  "e2e/",
  "e2e/.qa/manifest.json",
  ".env",
  "src/foo/bar.ts",
  "e2efoo.ts",   // must NOT be confused with e2e/
];

test("PARITY: isE2eStray matches legacy across the path table", () => {
  for (const path of E2E_STRAY_PATHS) {
    assert.equal(svc.isE2eStray(path), isE2eStray(path), `path: ${path}`);
  }
});

const CODE_DENIED_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".ENV",             // case-insensitive host
  "secrets.env",      // suffix glob
  "SECRETS.ENV",      // case-insensitive suffix
  ".github/workflows/ci.yml",
  ".github/",
  "Dockerfile",
  "DOCKERFILE",       // case-insensitive
  "docker-compose.yml",
  "docker-compose.override.yml",
  ".gitattributes",
  ".gitmodules",
  "src/app.ts",
  "src/service/main.ts",
  "README.md",
];

test("PARITY: isCodeDenied matches legacy across the path table", () => {
  for (const path of CODE_DENIED_PATHS) {
    assert.equal(svc.isCodeDenied(path), isCodeDenied(path), `path: ${path}`);
  }
});

const DANGEROUS_PATHS = [
  ".env",
  ".env.local",
  ".ENV",
  "secrets.env",
  "SECRETS.ENV",
  "config.env",
  "e2e/a.spec.ts",
  "src/app.ts",
  ".github/workflows/ci.yml",
];

test("PARITY: isDangerousPath matches legacy across the path table", () => {
  for (const path of DANGEROUS_PATHS) {
    assert.equal(svc.isDangerousPath(path), isDangerousPath(path), `path: ${path}`);
  }
});

// classifyStrays fixture: mix of e2e-stray, code-denied, dangerous, and clean paths.
const CLASSIFY_CHANGES = [
  { xy: "??", path: "src/new-file.ts" },
  { xy: " M", path: "src/existing.ts" },
  { xy: "??", path: "e2e/new.spec.ts" },
  { xy: " M", path: "e2e/existing.spec.ts" },
  { xy: "??", path: ".env" },
  { xy: "??", path: "secrets.env" },
  { xy: " M", path: ".github/workflows/ci.yml" },
  { xy: "??", path: "Dockerfile" },
  { xy: " M", path: "docker-compose.yml" },
  { xy: "??", path: "README.md" },
];

test("PARITY: classifyStrays matches legacy for e2e target (isCode=false)", () => {
  const legacy = classifyStrays(CLASSIFY_CHANGES, false);
  const local = svc.classifyStrays(CLASSIFY_CHANGES, false);
  assert.deepEqual(local, legacy, "e2e target classifyStrays");
});

test("PARITY: classifyStrays matches legacy for code target (isCode=true)", () => {
  const legacy = classifyStrays(CLASSIFY_CHANGES, true);
  const local = svc.classifyStrays(CLASSIFY_CHANGES, true);
  assert.deepEqual(local, legacy, "code target classifyStrays");
});
