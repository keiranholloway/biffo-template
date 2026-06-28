import nextConfig from '@biffo/eslint-config/next'

export default [
  {
    ignores: ['.next/**', 'next-env.d.ts', 'eslint.config.mjs'],
  },
  ...nextConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]
