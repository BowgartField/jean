import { useCallback, useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useRemoteServers } from '@/services/remote-servers'
import { cloneProjectToServer, projectsQueryKeys } from '@/services/projects'

interface CloneToRemoteModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName?: string
  clonedServerIds?: string[]
}

export function CloneToRemoteModal({
  open,
  onOpenChange,
  projectId,
  projectName,
  clonedServerIds = [],
}: CloneToRemoteModalProps) {
  const { data: remoteServers = [] } = useRemoteServers()
  const queryClient = useQueryClient()
  const [copyEnvFile, setCopyEnvFile] = useState(false)

  useEffect(() => {
    if (!open) setCopyEnvFile(false)
  }, [open])

  const isCloneable = useCallback(
    (serverId: string) => !clonedServerIds.includes(serverId),
    [clonedServerIds]
  )

  const availableServers = remoteServers.filter(
    server =>
      server.status === 'connected' &&
      !!server.http_token &&
      isCloneable(server.id)
  )

  const handleClone = useCallback(
    async (serverId: string, serverName: string) => {
      onOpenChange(false)
      const toastId = toast.loading(
        copyEnvFile
          ? `Cloning to ${serverName} and copying .env...`
          : `Cloning to ${serverName}...`
      )

      try {
        await cloneProjectToServer(projectId, serverId, copyEnvFile)
        queryClient.invalidateQueries({ queryKey: projectsQueryKeys.list() })
        toast.success(`Cloned to ${serverName}`, { id: toastId })
      } catch (error) {
        toast.error(`Clone failed: ${error}`, { id: toastId })
      }
    },
    [copyEnvFile, onOpenChange, projectId, queryClient]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Clone to remote</DialogTitle>
          {projectName && (
            <DialogDescription>
              Choose a remote server for{' '}
              <span className="font-medium">{projectName}</span>
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              id="copy-env-file"
              checked={copyEnvFile}
              onCheckedChange={checked => setCopyEnvFile(checked === true)}
            />
            <div className="space-y-1">
              <Label
                htmlFor="copy-env-file"
                className="cursor-pointer text-sm font-medium"
              >
                Copy .env file
              </Label>
              <p className="text-xs text-muted-foreground">
                Upload this project&apos;s .env to the remote clone if it
                exists.
              </p>
            </div>
          </div>

          {availableServers.length > 0 ? (
            <div className="flex flex-col gap-2">
              {availableServers.map(server => (
                <Button
                  key={server.id}
                  variant="outline"
                  className="h-auto justify-start gap-3 px-4 py-3"
                  onClick={() => handleClone(server.id, server.name)}
                >
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                  <div className="text-left">
                    <div className="text-sm font-medium">{server.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {server.host}
                    </div>
                  </div>
                </Button>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
              {clonedServerIds.length > 0
                ? 'Already cloned to all connected remote servers.'
                : 'No connected remote servers are available.'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
