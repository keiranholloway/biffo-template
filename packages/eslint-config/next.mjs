import { FlatCompat } from '@eslint/eslintrc'
import base from './index.mjs'

const compat = new FlatCompat()

/** @type {import('typescript-eslint').Config} */
export default [
  ...base,
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'error',
    },
  },
]
