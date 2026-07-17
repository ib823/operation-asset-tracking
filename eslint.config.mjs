import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/*.tsbuildinfo', 'sbom.json', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Enforces the SAP boundary as a lint rule as well as a type: `packages/core` is the
    // domain and must not learn about SAP or about any specific connector. ADR-0002 sets
    // the dependency direction; this is what stops it eroding one convenient import at a time.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@oat/sap', '@oat/sap/*'], message: 'core must not depend on the SAP integration (ADR-0002).' },
            {
              group: ['@oat/connectors', '@oat/connectors/*'],
              message: 'core must not depend on connectors (ADR-0002); connectors depend on core.',
            },
          ],
        },
      ],
    },
  },
  {
    // Node scripts and seeds run on Node, not in a browser: give them Node's globals.
    files: ['scripts/**/*.mjs', 'packages/db/prisma/**/*.ts', '**/*.config.{ts,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.test.ts', 'e2e/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
)
