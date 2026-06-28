import type { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'destructive'
}

export function Button({ variant = 'primary', className, children, ...props }: ButtonProps) {
  return (
    <button className={className} data-variant={variant} {...props}>
      {children}
    </button>
  )
}
