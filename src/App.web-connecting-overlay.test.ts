import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('web connecting overlay', () => {
  const source = readFileSync(`${process.cwd()}/src/App.tsx`, 'utf8')

  it('blurs the full app including the title bar', () => {
    expect(source).toContain('!isNativeApp() && !wsConnected')
    expect(source).toContain('backdrop-blur-md')
    expect(source).toContain('pointer-events-auto')
    expect(source).toContain('z-[70]')
    expect(source).toContain('fixed inset-0 z-[80]')
  })

  it('renders a loading indicator in the screen center', () => {
    expect(source).toContain('size-8 animate-spin')
    expect(source).toContain('items-center justify-center')
    expect(source).toContain('Jean is loading...')
  })
})
