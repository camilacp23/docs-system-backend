// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'src/generated/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'node_modules/**',
      // Phase 2 evidence is frozen (CLAUDE.md rule 9): not linted, not reformatted.
      'tests/0[1-9]_*',
      'tests/10_*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // R-1 / D-20: Prisma queries are lazy promises; every write must be awaited inside the audit context.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Frozen Phase 2 code (CLAUDE.md rule 9): authService.ts and testApp.ts are loosely typed and use Express 4 async
    // handlers; rewriting them is out of scope. Everything else in src/ is fully checked, with no exceptions.
    files: ['src/security/{authService,testApp}.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
  {
    // node:test's describe()/it()/hooks return promises that the runner itself tracks (they cannot be awaited
    // inside describe callbacks). Only those calls are allowed; any other floating promise in tests is an error.
    files: ['tests/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['test', 'describe', 'it', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
    },
  },
  {
    // Plain JS/MJS files (configs, Phase 2 .mjs test) are not part of a TypeScript project.
    files: ['**/*.{js,mjs}', 'prisma.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
