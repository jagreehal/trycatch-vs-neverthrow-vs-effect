// ESLint 9 flat config with TypeScript, neverthrow, and Effect
// Uses FlatCompat to consume legacy "plugin:.../recommended" shareable configs

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { fixupPluginRules } from '@eslint/compat';
import effectPlugin from '@effect/eslint-plugin';
import neverthrowPlugin from 'eslint-plugin-neverthrow';
import awaitlyPlugin from 'eslint-plugin-awaitly';
// Ensure Effect rules apply only to TS files as well
const effectRecommended = effectPlugin?.configs?.recommended
  ? [
      {
        ...effectPlugin.configs.recommended,
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            project: true,
            tsconfigRootDir: import.meta.dirname,
          },
        },
      },
    ]
  : [];

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
      'awaitly/no-immediate-execution': 'error',
      // Requires thunk when using key option
      'awaitly/require-thunk-for-key': 'error',
      // Warns about dynamic cache keys
      'awaitly/stable-cache-keys': 'warn',
      // Ensures workflows are awaited
      'awaitly/no-floating-workflow': 'error',
      // Ensures Results are handled
      'awaitly/no-floating-result': 'error',
      // Enforces .ok checks before accessing value
      'awaitly/require-result-handling': 'warn',
      // Prevents options on executor instead of step
      'awaitly/no-options-on-executor': 'error',
      // Prevents ok(ok(...)) double wrapping
      'awaitly/no-double-wrap-result': 'error',
    },
  },
  ...effectRecommended,
];
