// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "packages/database/migrations/**",
      "**/.next/**",
      "apps/web/next-env.d.ts",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.mjs", "scripts/*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Module boundaries: packages may only be imported through their public entry point.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@isela/*/src/*", "@isela/*/src/**", "@isela/*/test/**"],
              message: "Import other modules only via their public API (package entry point).",
            },
            {
              regex: "^\\.\\./\\.\\./\\.\\./",
              message: "Relative imports must not leave the package; use the package entry point.",
            },
          ],
        },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
