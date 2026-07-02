import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockPreferences: { zoom_level?: number } | undefined
let mockIsNativeApp = false
const mockSetZoom = vi.fn()

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: mockPreferences }),
  usePatchPreferences: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => mockIsNativeApp,
}))

vi.mock('@/lib/platform', () => ({
  isMacOS: true,
  getServerPlatform: vi.fn(() => 'mac'),
  isServerWindows: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ setZoom: mockSetZoom }),
}))

import { useZoom } from './use-zoom'

describe('useZoom', () => {
  beforeEach(() => {
    mockPreferences = { zoom_level: 125 }
    mockIsNativeApp = false
    mockSetZoom.mockReset()
    document.documentElement.style.zoom = ''
  })

  afterEach(() => {
    document.documentElement.style.zoom = ''
  })

  it('applies zoom with CSS in headless web clients', async () => {
    renderHook(() => useZoom())

    await waitFor(() => {
      expect(document.documentElement.style.zoom).toBe('1.25')
    })
    expect(mockSetZoom).not.toHaveBeenCalled()
  })
})
