// ESLint 9 flat config with TypeScript, neverthrow, awaitly, and Effect
// Uses FlatCompat to consume legacy "plugin:.../recommended" shareable configs

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { fixupPluginRules } from '@eslint/compat';
import effectPlugin from '@effect/eslint-plugin';
import neverthrowPlugin from 'eslint-plugin-neverthrow';
import awaitlyPlugin from 'eslint-plugin-awaitly';

export default [
  // Ignore build output, deps, and the ESLint config itself
  { ignores: ['dist', 'node_modules', 'eslint.config.*'] },

  // Base JS recommendations
  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      // Loosen strict TS rules for test scaffolding/mocks
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*'],
    plugins: { neverthrow: fixupPluginRules(neverthrowPlugin) },
    rules: {
      'neverthrow/must-use-result': 'error',
    },
  },
  // Awaitly plugin rules for workflow safety
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*'],
    plugins: { awaitly: fixupPluginRules(awaitlyPlugin) },
    rules: {
      // Prevents step(fn()) - must be step(() => fn())
      'awaitly/step-no-immediate-execution': 'error',
      // Requires thunk when using key option
      'awaitly/step-require-thunk-for-key': 'error',
      // Warns about dynamic cache keys
      'awaitly/step-stable-cache-keys': 'warn',
      // Ensures workflows are awaited
      'awaitly/workflow-no-floating': 'error',
      // Ensures Results are handled
      'awaitly/result-no-floating': 'error',
      // Enforces .ok checks before accessing value
      'awaitly/result-require-handling': 'warn',
      // Prevents options on executor instead of step
      'awaitly/workflow-options-position': 'error',
      // Prevents ok(ok(...)) double wrapping
      'awaitly/result-no-double-wrap': 'error',
    },
  },
  // Effect.ts plugin: no barrel imports (prefer "effect/Effect" over "effect")
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*'],
    plugins: { '@effect': fixupPluginRules(effectPlugin) },
    rules: {
      '@effect/no-import-from-barrel-package': 'warn',
      // Optional: enable @effect/dprint for Effect's formatter (can conflict with Prettier)
      // '@effect/dprint': 'error',
    },
  },
];
