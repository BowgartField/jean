import { useEffect, useRef } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { invoke, registerRemoteTransport } from '@/lib/transport'
import type { RemoteConnection } from '@/types/remote'
import {
  remoteServersQueryKeys,
  useRemoteServers,
} from '@/services/remote-servers'

const HEALTH_CHECK_INTERVAL_MS = 30_000

async function connectServer(
  serverId: string,
  queryClient: QueryClient
): Promise<void> {
  const connection = await invoke<RemoteConnection>('connect_remote_server', {
    serverId,
  })
  try {
    await registerRemoteTransport(
      connection.server_id,
      connection.local_port,
      connection.token
    )
  } catch (error) {
    await invoke('disconnect_remote_server', { serverId }).catch(
      () => undefined
    )
    throw error
  }
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['projects', 'worktrees'],
    }),
    queryClient.invalidateQueries({
      queryKey: ['remote-servers'],
    }),
  ])
}

/**
 * Auto-connects to all provisioned remote servers on startup.
 * It also recreates a tunnel once when runtime polling reports that its SSH
 * child exited. The existing transport is retained so stream replay sequence
 * state survives a local-port change.
 */
export function useAutoConnectRemoteServers(): void {
  const { data: servers } = useRemoteServers()
  const queryClient = useQueryClient()
  const hasConnectedRef = useRef(false)
  const connectingServerIdsRef = useRef(new Set<string>())
  const attemptedRecoveriesRef = useRef(new Set<string>())
  const serverIds = servers?.map(server => server.id).join('|') ?? ''

  useEffect(() => {
    // Only run once, and only after servers have loaded
    if (hasConnectedRef.current || !servers || servers.length === 0) return
    hasConnectedRef.current = true

    for (const server of servers) {
      // Only connect provisioned servers (http_token set)
      if (!server.http_token) continue
      connectingServerIdsRef.current.add(server.id)

      connectServer(server.id, queryClient)
        .catch(() => {
          // Silent — failed connections are surfaced through server status polling
        })
        .finally(() => {
          connectingServerIdsRef.current.delete(server.id)
        })
    }
  }, [servers, queryClient])

  useEffect(() => {
    if (!hasConnectedRef.current || !servers) return

    for (const server of servers) {
      if (server.status !== 'error') {
        attemptedRecoveriesRef.current.delete(server.id)
        continue
      }
      if (
        !server.http_token ||
        connectingServerIdsRef.current.has(server.id) ||
        attemptedRecoveriesRef.current.has(server.id)
      ) {
        continue
      }

      attemptedRecoveriesRef.current.add(server.id)
      connectingServerIdsRef.current.add(server.id)
      void connectServer(server.id, queryClient)
        .catch(() => {
          // Keep the error status visible; a later status transition can retry.
        })
        .finally(() => {
          connectingServerIdsRef.current.delete(server.id)
        })
    }
  }, [servers, queryClient])

  useEffect(() => {
    if (!serverIds) return
    const ids = serverIds.split('|')
    const checkHealth = async () => {
      await Promise.allSettled(
        ids.map(serverId => invoke('check_remote_server_health', { serverId }))
      )
      await queryClient.invalidateQueries({
        queryKey: remoteServersQueryKeys.all,
      })
    }
    const interval = window.setInterval(
      () => void checkHealth(),
      HEALTH_CHECK_INTERVAL_MS
    )
    return () => window.clearInterval(interval)
  }, [queryClient, serverIds])
}
