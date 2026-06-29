import { useEffect, useRef } from 'react'
import { invoke, registerRemoteTransport } from '@/lib/transport'
import type { RemoteConnection } from '@/types/remote'
import { useRemoteServers } from '@/services/remote-servers'

/**
 * Auto-connects to all provisioned remote servers on startup.
 * Runs once after servers are first loaded — silent background operation,
 * no toasts or loading states.
 */
export function useAutoConnectRemoteServers(): void {
  const { data: servers } = useRemoteServers()
  const hasConnectedRef = useRef(false)

  useEffect(() => {
    // Only run once, and only after servers have loaded
    if (hasConnectedRef.current || !servers || servers.length === 0) return
    hasConnectedRef.current = true

    for (const server of servers) {
      // Only connect provisioned servers (http_token set)
      if (!server.http_token) continue

      invoke<RemoteConnection>('connect_remote_server', { serverId: server.id })
        .then(connection => {
          registerRemoteTransport(
            connection.server_id,
            connection.local_port,
            connection.token
          )
        })
        .catch(() => {
          // Silent — failed connections are surfaced through server status polling
        })
    }
  }, [servers])
}
