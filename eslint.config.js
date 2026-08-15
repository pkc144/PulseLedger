import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // benchmarks/k6/** runs in k6's own JS runtime (k6 globals like __ENV/__VU, a virtual `k6`
    // module resolved by the k6 binary) -- it is not part of this Node/TypeScript project.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'eslint.config.js', 'benchmarks/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
