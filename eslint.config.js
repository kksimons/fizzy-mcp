import effect from "@effect/eslint-plugin";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config mirroring the Effect project's setup: eslint + typescript-eslint
// recommended, plus @effect/eslint-plugin's dprint rule for deterministic
// formatting (no semicolons, double quotes, 2-space, 120 cols). Run
// `bun run lint:fix` to format.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...effect.configs.dprint,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@effect/dprint": [
        "error",
        {
          config: {
            indentWidth: 2,
            lineWidth: 120,
            semiColons: "asi",
            quoteStyle: "alwaysDouble",
            trailingCommas: "never",
            operatorPosition: "maintain",
            "arrowFunction.useParentheses": "force",
          },
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-console": "error",
    },
  },
);
