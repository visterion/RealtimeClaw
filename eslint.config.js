// ESLint flat config (required since ESLint 9; ESLint 10 removed eslintrc support entirely).
import tseslint from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  ...tseslint.configs['flat/recommended'],
  {
    rules: {
      // A leading underscore marks an intentionally unused binding (interface-conforming stubs, mocks).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Tests reach into private state and fake partial payloads; `any` casts are deliberate there.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
