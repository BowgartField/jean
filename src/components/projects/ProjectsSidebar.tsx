import { useEffect, useState } from 'react'
import { Plus, Folder, Archive, Briefcase } from 'lucide-react'
import { useSidebarWidth } from '@/components/layout/SidebarWidthContext'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useProjects, useCreateFolder } from '@/services/projects'
import { useProjectsStore } from '@/store/projects-store'
import { ProjectTree } from './ProjectTree'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { scheduleIdleWork } from '@/lib/idle'
import { useRemoteServers } from '@/services/remote-servers'
import { cn } from '@/lib/utils'

export function ProjectsSidebar() {
  const { data: projects = [], isLoading } = useProjects()
  const { setAddProjectDialogOpen } = useProjectsStore()
  const createFolder = useCreateFolder()
  const sidebarWidth = useSidebarWidth()
  const [backendCheckReady, setBackendCheckReady] = useState(false)
  useEffect(() => scheduleIdleWork(() => setBackendCheckReady(true), 1500), [])
  const { installedBackends } = useInstalledBackends({
    enabled: backendCheckReady,
  })
  const setupIncomplete = installedBackends.length === 0

  // Local/Remote view toggle
  const [view, setView] = useState<'local' | 'remote'>('local')
  const { data: remoteServers = [] } = useRemoteServers()
  const hasRemoteServers = remoteServers.some(s => s.http_token)

  // Responsive layout threshold
  const isNarrow = sidebarWidth < 180

  return (
    <div className="flex h-full flex-col">
      {/* Local / Remote toggle — only shown when remote servers are provisioned */}
      {hasRemoteServers && (
        <div className="flex shrink-0 gap-px p-2 pb-0">
          <button
            type="button"
            onClick={() => setView('local')}
            className={cn(
              'flex-1 rounded-l-md border py-0.5 text-xs font-medium transition-colors',
              view === 'local'
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-transparent text-muted-foreground hover:bg-accent'
            )}
          >
            Local
          </button>
          <button
            type="button"
            onClick={() => setView('remote')}
            className={cn(
              'flex-1 rounded-r-md border py-0.5 text-xs font-medium transition-colors',
              view === 'remote'
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-transparent text-muted-foreground hover:bg-accent'
            )}
          >
            Remote
          </button>
        </div>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-4">
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex h-full items-center justify-center px-2">
            <span className="truncate text-sm text-muted-foreground/50">
              No projects found
            </span>
          </div>
        ) : (
          <ProjectTree projects={projects} remoteView={view === 'remote'} />
        )}
      </div>

      {/* Footer - transparent buttons with hover background */}
      <div
        className={`flex gap-1 p-1.5 pb-2 ${isNarrow ? 'flex-col' : 'items-center'}`}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
            >
              {!isNarrow && <Plus className="size-3.5" />}
              New
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            style={{ width: sidebarWidth - 12 }}
          >
            <DropdownMenuItem
              onClick={() => createFolder.mutate({ name: 'New Folder' })}
            >
              <Folder className="mr-2 size-3.5" />
              Folder
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setAddProjectDialogOpen(true)}
              disabled={!backendCheckReady || setupIncomplete}
            >
              <Briefcase className="mr-2 size-3.5" />
              Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('command:open-archived-modal'))
          }
        >
          {!isNarrow && <Archive className="size-3.5" />}
          Archived
        </button>
      </div>
    </div>
  )
}
