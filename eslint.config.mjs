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
  {
    // Root tool configs that are CommonJS by necessity — commitlint loads its
    // config with `require`, so `module.exports` is the only shape that works.
    // Without this they trip `no-undef` on `module`.
    //
    // The error was latent rather than absent: `pnpm run lint` does not cover
    // these files, so nothing surfaced it — but lint-staged runs eslint on any
    // staged `*.js`, so the FIRST person to edit one had their commit aborted
    // by an error they did not introduce. That is worth fixing at the config
    // rather than per-file, so the next editor does not hit the same wall.
    files: ['commitlint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
)
