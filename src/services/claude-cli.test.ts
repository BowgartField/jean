import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke,
  listen: vi.fn(),
  useWsConnectionStatus: () => true,
}))

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { useClaudeCliAuth, useClaudeCliStatus } from './claude-cli'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('remote Claude CLI status', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('routes installation checks to the selected server', async () => {
    invoke.mockResolvedValue({
      installed: true,
      version: '2.1.196',
      path: '/remote/claude',
      supports_auth_command: true,
    })

    const { result } = renderHook(
      () => useClaudeCliStatus({ serverId: 'server-test' }),
      { wrapper: createWrapper() }
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invoke).toHaveBeenCalledWith('check_claude_cli_installed', {
      _backendHandle: 'server-test',
    })
  })

  it('routes authentication checks to the selected server', async () => {
    invoke.mockResolvedValue({ authenticated: false, error: 'Not logged in' })

    const { result } = renderHook(
      () => useClaudeCliAuth({ serverId: 'server-test' }),
      { wrapper: createWrapper() }
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(invoke).toHaveBeenCalledWith('check_claude_cli_auth', {
      _backendHandle: 'server-test',
    })
  })
})
