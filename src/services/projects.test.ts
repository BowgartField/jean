import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  remoteServers: [] as {
    id: string
    status: string
    http_token: string | null
  }[],
}))

vi.mock('@/lib/transport', () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  useWsConnectionStatus: vi.fn(),
  setAppDataDir: vi.fn(),
}))

vi.mock('@/lib/environment', () => ({
  hasBackend: () => true,
}))

vi.mock('@/services/remote-servers', () => ({
  useRemoteServers: () => ({ data: mocks.remoteServers }),
}))

import { invoke } from '@/lib/transport'
import { cloneProjectToServer, useProjects } from './projects'

function createWrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  mocks.remoteServers = []
})

describe('cloneProjectToServer', () => {
  it('passes the copyEnvFile flag to the backend command', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      server_id: 'server-1',
      remote_path: '/srv/jean/example',
    })

    await cloneProjectToServer('project-1', 'server-1', true)

    expect(invoke).toHaveBeenCalledWith(
      'clone_project_to_remote',
      expect.objectContaining({
        projectId: 'project-1',
        serverId: 'server-1',
        copyEnvFile: true,
      })
    )
  })
})

describe('useProjects', () => {
  it('includes projects discovered on connected remote servers', async () => {
    mocks.remoteServers = [
      {
        id: 'server-1',
        status: 'connected',
        http_token: 'token',
      },
    ]
    vi.mocked(invoke)
      .mockResolvedValueOnce([
        {
          id: 'local-project',
          name: 'Local',
          path: '/local',
          default_branch: 'main',
          added_at: 1,
          order: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'remote-project',
          name: 'Remote',
          path: '/remote',
          default_branch: 'main',
          added_at: 1,
          order: 0,
        },
      ])

    const queryClient = new QueryClient()
    const { result } = renderHook(() => useProjects(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(result.current.data).toHaveLength(2)
    })
    expect(result.current.data?.[1]).toMatchObject({
      id: 'remote-project',
      server_id: 'server-1',
    })
    expect(invoke).toHaveBeenCalledWith('list_projects', {
      _backendHandle: 'server-1',
    })
  })
})
