import { useState } from 'react'
import { ChevronDown, Monitor, Server } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useRemoteServers } from '@/services/remote-servers'
import { cn } from '@/lib/utils'

interface SessionRemoteBackendPickerProps {
  value: string | null // null = local, string = server id
  onChange: (serverId: string | null) => void
}

/**
 * Minimal chip button in the chat toolbar that lets users choose whether the
 * session runs locally or on a connected remote server.
 *
 * Only renders when at least one remote server is connected and provisioned.
 */
export function SessionRemoteBackendPicker({
  value,
  onChange,
}: SessionRemoteBackendPickerProps) {
  const [open, setOpen] = useState(false)
  const { data: servers = [] } = useRemoteServers()

  const connectedServers = servers.filter(
    s => s.status === 'connected' && s.http_token
  )

  // Only show this control when remote servers are actually available
  if (connectedServers.length === 0) return null

  const selectedServer = value ? servers.find(s => s.id === value) : null
  const label = selectedServer ? selectedServer.name : 'Local'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Session runs on: ${label}`}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 text-xs font-medium transition-colors',
            'text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground'
          )}
        >
          {selectedServer ? (
            <Server className="size-3 shrink-0" />
          ) : (
            <Monitor className="size-3 shrink-0" />
          )}
          <span className="max-w-[96px] truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-40" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="w-48 p-1"
        align="start"
        side="top"
        sideOffset={6}
      >
        <div className="mb-1 px-2 pb-1 pt-0.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Run session on
          </p>
        </div>

        {/* Local option */}
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent',
            !value && 'bg-accent text-accent-foreground'
          )}
          onClick={() => {
            onChange(null)
            setOpen(false)
          }}
        >
          <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
          <span>Local</span>
          {!value && (
            <span className="ml-auto size-1.5 rounded-full bg-primary" />
          )}
        </button>

        {connectedServers.map(server => (
          <button
            key={server.id}
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent',
              value === server.id && 'bg-accent text-accent-foreground'
            )}
            onClick={() => {
              onChange(server.id)
              setOpen(false)
            }}
          >
            <Server className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{server.name}</span>
            {value === server.id && (
              <span className="size-1.5 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
