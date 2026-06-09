import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  errorClassFromVerdict,
  errorClassFromCorrections,
  ERROR_CLASSES,
  type ErrorClass,
} from "./taxonomy";

describe("ERROR_CLASSES", () => {
  it("covers all 11 error classes", () => {
    assert.equal(ERROR_CLASSES.length, 11);
  });

  it("E-INFRA is present and excludable from learning", () => {
    assert(ERROR_CLASSES.includes("E-INFRA"));
  });

  it("E-REVIEWER-REJECTED is a valid ErrorClass", () => {
    assert.ok((ERROR_CLASSES as readonly string[]).includes("E-REVIEWER-REJECTED"));
  });
});

describe("errorClassFromVerdict", () => {
  it("invalid → E-STATIC", () => {
    assert.equal(errorClassFromVerdict("invalid", null, 0.7), "E-STATIC");
  });

  it("fail → E-EXEC-FAIL", () => {
    assert.equal(errorClassFromVerdict("fail", null, 0.7), "E-EXEC-FAIL");
  });

  it("flaky → E-FLAKY", () => {
    assert.equal(errorClassFromVerdict("flaky", null, 0.7), "E-FLAKY");
  });

  it("infra-error → E-INFRA", () => {
    assert.equal(errorClassFromVerdict("infra-error", null, 0.7), "E-INFRA");
  });

  it("pass with ratio above min → null (healthy green)", () => {
    assert.equal(errorClassFromVerdict("pass", 0.85, 0.7), null);
  });

  it("pass with ratio below min → E-COVERAGE-GAP", () => {
    assert.equal(errorClassFromVerdict("pass", 0.4, 0.7), "E-COVERAGE-GAP");
  });

  it("pass with null ratio → null (unmeasured)", () => {
    assert.equal(errorClassFromVerdict("pass", null, 0.7), null);
  });

  it("skipped → null", () => {
    assert.equal(errorClassFromVerdict("skipped", null, 0.7), null);
  });

  it("pass with ratio exactly at min → null (ratio >= min)", () => {
    assert.equal(errorClassFromVerdict("pass", 0.7, 0.7), null);
  });
});

describe("errorClassFromCorrections", () => {
  it("false positive keyword → E-FALSE-POSITIVE", () => {
    assert.equal(
      errorClassFromCorrections(["test clicks without asserting anything"]),
      "E-FALSE-POSITIVE",
    );
  });

  it("wrong objective → E-WRONG-OBJECTIVE", () => {
    assert.equal(
      errorClassFromCorrections(["the test is not tied to the commit diff"]),
      "E-WRONG-OBJECTIVE",
    );
  });

  it("fragile selector → E-FRAGILE-SELECTOR", () => {
    assert.equal(
      errorClassFromCorrections(["uses a fragile selector with nth-child"]),
      "E-FRAGILE-SELECTOR",
    );
  });

  it("no cleanup → E-NO-CLEANUP", () => {
    assert.equal(
      errorClassFromCorrections(["test does not clean up orphaned data"]),
      "E-NO-CLEANUP",
    );
  });

  it("returns null for unrecognized corrections", () => {
    assert.equal(
      errorClassFromCorrections(["the color should be blue not red"]),
      null,
    );
  });

  it("returns null for empty array", () => {
    assert.equal(errorClassFromCorrections([]), null);
  });

  it("first match wins when multiple anti-patterns present", () => {
    const result = errorClassFromCorrections([
      "fragile selector with magic string",
      "also does not clean up orphaned data", // E-NO-CLEANUP would match, but E-FRAGILE-SELECTOR is first
    ]);
    assert.equal(result, "E-FRAGILE-SELECTOR");
  });
});
