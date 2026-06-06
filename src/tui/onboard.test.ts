import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildYaml, suggestName, configExists, writeConfig, OnboardInput } from "./onboard";

test("suggestName extracts the repo name from org/name", () => {
  assert.equal(suggestName("facebook/react"), "react");
  assert.equal(suggestName("my-org/my-repo"), "my-repo");
  assert.equal(suggestName("single"), "single");
});

test("buildYaml generates valid YAML for an e2e project", () => {
  const input: OnboardInput = {
    name: "test-app",
    repo: "org/repo",
    baseBranch: "main",
    baseUrl: "https://dev.example.com",
    versionUrl: "https://dev.example.com/version",
    target: "e2e",
    needsReview: true,
    shadow: true,
    testDataPrefix: "qa-bot",
  };
  const yaml = buildYaml(input);
  assert.match(yaml, /name: "test-app"/);
  assert.match(yaml, /repo: "org\/repo"/);
  assert.match(yaml, /baseUrl: "https:\/\/dev.example.com"/);
  assert.match(yaml, /versionUrl: "https:\/\/dev.example.com\/version"/);
  assert.match(yaml, /needsReview: true/);
  assert.match(yaml, /shadow: true/);
  assert.match(yaml, /testDataPrefix: "qa-bot"/);
  assert.match(yaml, /onFailure: "github-issue"/);
  assert.doesNotMatch(yaml, /code: true/);
});

test("buildYaml includes code: true for code mode and skips versionUrl", () => {
  const input: OnboardInput = {
    name: "code-app",
    repo: "org/lib",
    baseBranch: "develop",
    baseUrl: "https://github.com/org/lib",
    target: "code",
    needsReview: false,
    shadow: false,
    testDataPrefix: "test",
  };
  const yaml = buildYaml(input);
  assert.match(yaml, /code: true/);
  assert.doesNotMatch(yaml, /versionUrl/);
});

test("writeConfig creates the file and configExists detects it", () => {
  mkdirSync(join(process.cwd(), "config", "apps"), { recursive: true });
  const yaml = 'name: "tmp-test"\nrepo: "x/y"\n';
  try {
    const path = writeConfig("__test_tmp__", yaml);
    assert.ok(existsSync(path));
    assert.ok(configExists("__test_tmp__"));
    assert.equal(configExists("__nonexistent__"), false);
  } finally {
    try { unlinkSync(join(process.cwd(), "config", "apps", "__test_tmp__.yaml")); } catch {}
  }
});

test("buildYaml omits versionUrl when empty", () => {
  const input: OnboardInput = {
    name: "no-version",
    repo: "org/repo",
    baseBranch: "main",
    baseUrl: "https://dev.example.com",
    target: "e2e",
    needsReview: true,
    shadow: false,
    testDataPrefix: "qa",
  };
  const yaml = buildYaml(input);
  assert.doesNotMatch(yaml, /versionUrl/);
});

test("buildYaml handles special characters in repo name", () => {
  assert.equal(suggestName("org/my-repo_v2"), "my-repo-v2");
  assert.equal(suggestName("org/UPPERCASE"), "uppercase");
});
