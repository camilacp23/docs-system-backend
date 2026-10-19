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
    },
  },
  {
    // Phase 2 reference code in src/ (loosely typed, written before this tooling). Rewriting it is out of scope
    // ("no behavior changes"); the unsafe-any family is relaxed here only. New code is fully checked.
    // authService.ts and testApp.ts are frozen (CLAUDE.md rule 9) and are also exempt from no-misused-promises
    // (Express 4 async handlers); middleware.ts keeps it relaxed until the async-handler wrapper exists.
    files: ['src/db/prisma.ts', 'src/security/{authService,middleware,rbac,testApp}.ts'],
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
    // node:test's describe()/it() return promises that the runner itself tracks; awaiting them is not possible
    // inside describe callbacks. R-1 (awaited writes) is enforced on src/, where it matters.
    files: ['tests/**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Plain JS/MJS files (configs, Phase 2 .mjs test) are not part of a TypeScript project.
    files: ['**/*.{js,mjs}', 'prisma.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
