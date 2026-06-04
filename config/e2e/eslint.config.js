// Linter del Filtro B: el "corrector de estilo" que caza los errores típicos de
// tests E2E mal escritos SIN ejecutarlos. Si algo de esto salta, el run es
// "invalid" y los specs no llegan a ejecutarse.
//
// typescript-eslint aporta el PARSER de TypeScript (sin él, ESLint no entiende
// la sintaxis .ts y el gate fallaría por error de parseo, no por calidad real).

import playwright from "eslint-plugin-playwright";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  playwright.configs["flat/recommended"],
  {
    files: ["**/*.spec.ts", "fixtures.ts"],
    rules: {
      // Esperas fijas (sleep) → fuente nº1 de flakiness.
      "playwright/no-wait-for-timeout": "error",
      // Element handles en vez de locators → frágil.
      "playwright/no-element-handle": "error",
      // Un test sin assert no prueba nada (falso positivo garantizado).
      "playwright/expect-expect": "error",
    },
  },
);
