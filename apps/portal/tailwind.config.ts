import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Brand tokens (issue #1945). Every value below is a CSS custom
      // property (`var(--x)`), defined with platform-neutral defaults in
      // `src/app/globals.css`, never a literal color — a literal here would
      // have to be baked into a new Tailwind build (or a template code fork)
      // for an instance to rebrand. Reading a `var()` means a value set once
      // in globals.css, or overridden per-instance at build time (see
      // `NEXT_PUBLIC_PORTAL_PRIMARY_COLOR` in `src/app/layout.tsx`), reaches
      // every class below with no template edit required.
      colors: {
        primary: 'var(--primary)',
        'primary-hover': 'var(--primary-hover)',
        'on-primary': 'var(--on-primary)',
        'primary-container': 'var(--primary-container)',
        'on-primary-container': 'var(--on-primary-container)',
        surface: 'var(--surface)',
        'surface-variant': 'var(--surface-variant)',
        'on-surface': 'var(--on-surface)',
        'on-surface-variant': 'var(--on-surface-variant)',
        outline: 'var(--outline)',
        'error-container': 'var(--error-container)',
        'on-error-container': 'var(--on-error-container)',
      },
    },
  },
  plugins: [],
}

export default config
