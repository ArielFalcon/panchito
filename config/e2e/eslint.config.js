// Linter del Filtro B: el "corrector de estilo" que caza los errores típicos de
// tests E2E mal escritos SIN ejecutarlos. Si algo de esto salta, el run es
// "invalid" y los specs no llegan a ejecutarse.

import playwright from "eslint-plugin-playwright";

export default [
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
      // Selectores CSS/XPath crudos en vez de getByRole/getByTestId.
      "playwright/no-raw-locators": "warn",
    },
  },
];
