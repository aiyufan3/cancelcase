import js from "@eslint/js";
import nextPlugin from "eslint-config-next";
import tseslint from "typescript-eslint";

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "data/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextPlugin,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
];

export default config;
