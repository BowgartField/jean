import { useState } from 'react'
import { Download, Loader2, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getBackendIcon,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'
import { cn } from '@/lib/utils'
import {
  getRemoteCursorInstallCommand,
  remoteCliToolsQueryKeys,
  useRemoteCliTools,
  type RemoteCliStatus,
  type RemoteCliToolDefinition,
} from '@/services/remote-cli-tools'
import { useUIStore } from '@/store/ui-store'
import type { RemoteServerConfig } from '@/types/remote'
import { useQueryClient } from '@tanstack/react-query'

function loginArgs(
  tool: RemoteCliToolDefinition,
  status: RemoteCliStatus
): string[] {
  if (tool.backend === 'claude') {
    return status.supports_auth_command ? ['auth', 'login'] : ['login']
  }
  if (tool.backend === 'opencode') return ['auth', 'login']
  if (tool.backend === 'pi') return []
  return ['login']
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function RemoteServerCliShelf({
  server,
  connected,
}: {
  server: RemoteServerConfig
  connected: boolean
}) {
  const queryClient = useQueryClient()
  const tools = useRemoteCliTools(server.id, connected)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)
  const openCliUpdateModal = useUIStore(state => state.openCliUpdateModal)
  const [installOpen, setInstallOpen] = useState(false)
  const [preparingCursor, setPreparingCursor] = useState(false)
  const installedTools = tools.filter(tool => tool.status?.installed)
  const uninstalledTools = tools.filter(
    tool => !tool.isLoading && !tool.status?.installed
  )

  const handleInstall = async (tool: RemoteCliToolDefinition) => {
    if (tool.backend !== 'cursor') {
      setInstallOpen(false)
      openCliUpdateModal(tool.backend, server.id)
      return
    }

    setPreparingCursor(true)
    try {
      const command = await getRemoteCursorInstallCommand(server.id)
      setInstallOpen(false)
      openCliLoginModal(
        'cursor',
        command.command,
        command.args,
        'install',
        server.id
      )
    } catch (error) {
      toast.error('Could not prepare the Cursor installer', {
        description: errorMessage(error),
      })
    } finally {
      setPreparingCursor(false)
    }
  }

  const handleUpdate = (
    tool: RemoteCliToolDefinition,
    status: RemoteCliStatus
  ) => {
    if (tool.backend === 'cursor') {
      if (!status.path) return
      openCliLoginModal('cursor', status.path, ['update'], 'update', server.id)
      return
    }
    openCliUpdateModal(tool.backend, server.id)
  }

  const handleLogin = (
    tool: RemoteCliToolDefinition,
    status: RemoteCliStatus
  ) => {
    if (!status.path) return
    openCliLoginModal(
      tool.backend,
      status.path,
      loginArgs(tool, status),
      'login',
      server.id
    )
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Installed AI CLIs</p>
          <p className="text-[11px] text-muted-foreground">
            {connected
              ? `${installedTools.length} available on this server`
              : 'Connect the backend to inspect its tools'}
          </p>
        </div>
        {connected && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh installed AI CLIs"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: remoteCliToolsQueryKeys.all(server.id),
              })
            }
          >
            <RefreshCw />
          </Button>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {installedTools.map(tool => {
          const status = tool.status
          if (!status) return null
          const Icon = getBackendIcon(tool.definition.backend)
          const authenticated = tool.auth?.authenticated === true
          return (
            <div
              key={tool.definition.backend}
              className={cn(
                'flex size-28 shrink-0 flex-col rounded-xl border bg-muted/10 p-2.5',
                tool.isOutdated && 'border-amber-500/40 bg-amber-500/5'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="grid size-8 place-items-center rounded-lg border bg-background">
                  <Icon className="size-4" />
                </span>
                <span
                  className={cn(
                    'mt-1 size-2 rounded-full',
                    authenticated
                      ? 'bg-emerald-500'
                      : tool.isAuthLoading
                        ? 'animate-pulse bg-muted-foreground/50'
                        : 'bg-amber-500'
                  )}
                  title={authenticated ? 'Authenticated' : 'Login required'}
                />
              </div>
              <p className="mt-2 truncate text-xs font-medium">
                {getBackendPlainLabel(tool.definition.backend)}
              </p>
              <p className="truncate font-mono text-[10px] text-muted-foreground">
                {status.version ? `v${status.version}` : 'Installed'}
              </p>
              <div className="mt-auto">
                {tool.isOutdated ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 w-full border-amber-500/40 px-1.5 text-[10px] text-amber-700 dark:text-amber-400"
                    onClick={() => handleUpdate(tool.definition, status)}
                  >
                    <Download className="size-3" />
                    Outdated
                  </Button>
                ) : !tool.isAuthLoading && !authenticated ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-full px-1.5 text-[10px]"
                    onClick={() => handleLogin(tool.definition, status)}
                  >
                    Login
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}

        {connected && (
          <button
            type="button"
            onClick={() => setInstallOpen(true)}
            className="flex size-28 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/5 text-center text-muted-foreground transition-colors hover:border-sky-500/40 hover:bg-sky-500/5 hover:text-foreground"
          >
            <span className="grid size-8 place-items-center rounded-full border border-dashed bg-background">
              <Plus className="size-4" />
            </span>
            <span className="text-xs font-medium">Install more</span>
          </button>
        )}
      </div>

      <Dialog open={installOpen} onOpenChange={setInstallOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Install an AI CLI</DialogTitle>
            <DialogDescription>
              Choose another backend to install on {server.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            {uninstalledTools.map(tool => {
              const Icon = getBackendIcon(tool.definition.backend)
              return (
                <button
                  key={tool.definition.backend}
                  type="button"
                  className="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:border-sky-500/40 hover:bg-sky-500/5"
                  onClick={() => void handleInstall(tool.definition)}
                  disabled={
                    preparingCursor && tool.definition.backend === 'cursor'
                  }
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
                    {preparingCursor && tool.definition.backend === 'cursor' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Icon className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {getBackendPlainLabel(tool.definition.backend)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Install latest version
                    </span>
                  </span>
                </button>
              )
            })}
            {uninstalledTools.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground sm:col-span-2">
                Every supported AI CLI is already installed.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
