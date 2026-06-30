import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  registerRemoteTransport: vi.fn(),
  servers: [
    {
      id: 'server-test',
      http_token: 'token',
    },
  ],
}))

vi.mock('@/lib/transport', () => ({
  invoke: mocks.invoke,
  registerRemoteTransport: mocks.registerRemoteTransport,
}))

vi.mock('@/services/remote-servers', () => ({
  useRemoteServers: () => ({ data: mocks.servers }),
}))

import { useAutoConnectRemoteServers } from './useAutoConnectRemoteServers'

function createWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe('useAutoConnectRemoteServers', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.registerRemoteTransport.mockReset()
    mocks.invoke.mockResolvedValue({
      server_id: 'server-test',
      local_port: 57304,
      token: 'token',
    })
    mocks.registerRemoteTransport.mockResolvedValue(undefined)
  })

  it('refetches worktrees after the remote websocket is ready', async () => {
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useAutoConnectRemoteServers(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(mocks.registerRemoteTransport).toHaveBeenCalledWith(
        'server-test',
        57304,
        'token'
      )
    })
    await waitFor(() => {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['projects', 'worktrees'],
      })
    })
  })
})
