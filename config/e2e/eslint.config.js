// Filter B linter: the "style checker" that catches the typical mistakes of
// badly written E2E tests WITHOUT running them. If any of this fires, the run is
// "invalid" and the specs are never executed.
//
// typescript-eslint provides the TypeScript PARSER (without it ESLint cannot
// understand .ts syntax and the gate would fail on a parse error, not on quality).

import playwright from "eslint-plugin-playwright";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  playwright.configs["flat/recommended"],
  {
    files: ["**/*.spec.ts", "fixtures.ts"],
    rules: {
      // Hard waits (sleep) → the #1 source of flakiness.
      "playwright/no-wait-for-timeout": "error",
      // Element handles instead of locators → fragile.
      "playwright/no-element-handle": "error",
      // A test without an assert proves nothing (guaranteed false positive).
      "playwright/expect-expect": "error",
    },
  },
);
