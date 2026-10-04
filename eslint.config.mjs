import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// The hard limits in CLAUDE.md are enforced here, not left to review: a rule
// nobody runs decays. Counts include blank lines and comments on purpose so the
// number ESLint checks is the number `wc -l` shows.
const limits = {
  '@typescript-eslint/no-explicit-any': 'error',
  'max-lines': ['error', { max: 250, skipBlankLines: false, skipComments: false }],
  'max-lines-per-function': ['error', { max: 30, skipBlankLines: false, skipComments: false }],
  'max-params': ['error', 3],
};

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'fixtures/**', 'plugin/dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: limits,
  },
  {
    // node:test's `test()` returns a promise the runner tracks itself; awaiting
    // every top-level call would only add noise.
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Plain-JS scripts are not in a tsconfig project, so typed rules cannot run.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' } },
    rules: { 'max-lines': limits['max-lines'], 'max-lines-per-function': limits['max-lines-per-function'], 'max-params': limits['max-params'] },
  },
);
