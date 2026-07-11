import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('initial theme bootstrap', () => {
  const source = readFileSync(`${process.cwd()}/index.html`, 'utf8')

  it('applies the saved or system theme before the app module loads', () => {
    const bootstrapIndex = source.indexOf("localStorage.getItem('ui-theme')")
    const appIndex = source.indexOf('/src/main.tsx')

    expect(bootstrapIndex).toBeGreaterThan(-1)
    expect(bootstrapIndex).toBeLessThan(appIndex)
    expect(source).toContain("matchMedia('(prefers-color-scheme: dark)')")
    expect(source).toContain('classList.add(resolvedTheme)')
  })
})
