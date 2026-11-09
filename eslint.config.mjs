import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/next-env.d.ts', 'db/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Architecture rule: API modules never open DB connections or set tenant context themselves.
    // All access goes through DbService (common/db.service.ts), which applies the RLS context.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/common/db.service.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Use DbService instead of raw pg connections.' },
            { name: 'drizzle-orm/node-postgres', message: 'Use DbService instead of creating drizzle clients.' },
            { name: '@rakan/db', importNames: ['createPool', 'withContext'], message: 'Use DbService (tenant context) instead.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  {
    files: ['**/scripts/**/*.ts', '**/*.test.ts', 'apps/api/test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['e2e/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', process: 'readonly', __dirname: 'readonly', console: 'readonly' } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-require-imports': 'off' },
  },
);
