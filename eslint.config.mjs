// ESLint 9 flat config with TypeScript, neverthrow, and Effect
// Uses FlatCompat to consume legacy "plugin:.../recommended" shareable configs

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { fixupPluginRules } from '@eslint/compat';
import effectPlugin from '@effect/eslint-plugin';
import neverthrowPlugin from 'eslint-plugin-neverthrow';
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
  ...effectRecommended,
];
