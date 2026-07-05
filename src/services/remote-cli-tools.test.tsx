import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mocks.invoke,
}))

import { useRemoteCliSetup, useRemoteCliTools } from './remote-cli-tools'

function createWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('remote CLI tools', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'check_claude_cli_installed') {
        return Promise.resolve({
          installed: true,
          version: '1.0.0',
          path: '/opt/jean/bin/claude',
          supports_auth_command: true,
        })
      }
      if (command === 'check_claude_cli_auth') {
        return Promise.resolve({ authenticated: true, error: null })
      }
      if (command === 'get_available_cli_versions') {
        return Promise.resolve([
          { version: '2.0.0', prerelease: false },
          { version: '1.0.0', prerelease: false },
        ])
      }
      if (command.startsWith('check_')) {
        return Promise.resolve({ installed: false, version: null, path: null })
      }
      return Promise.resolve(undefined)
    })
  })

  it('detects outdated installed CLIs through the remote backend', async () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useRemoteCliTools('server-1', true), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(result.current[0]?.isOutdated).toBe(true)
    })
    expect(result.current[0]).toMatchObject({
      latestVersion: '2.0.0',
      auth: { authenticated: true },
    })
    expect(mocks.invoke).toHaveBeenCalledWith('check_claude_cli_installed', {
      _backendHandle: 'server-1',
    })
  })

  it('installs the selected version on the remote backend', async () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(
      () => useRemoteCliSetup('server-1', 'claude'),
      { wrapper: createWrapper(queryClient) }
    )
    const onSuccess = vi.fn()

    await act(async () => {
      result.current.install('2.0.0', { onSuccess })
    })

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled()
    })
    expect(mocks.invoke).toHaveBeenCalledWith('install_claude_cli', {
      version: '2.0.0',
      _backendHandle: 'server-1',
    })
  })
})
