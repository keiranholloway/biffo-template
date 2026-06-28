import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Root config used by lint-staged pre-commit hooks.
// Uses recommended (not strictTypeChecked) — type-aware rules require per-package
// tsconfig resolution and belong in `pnpm run lint`, not the fast pre-commit path.
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/migrations/versions/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
