import { useMemo, useState } from 'react'
import { Pin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'
import type { PinnedTable } from '@/types/chat'
import { useChatStore } from '@/store/chat-store'
import { cn } from '@/lib/utils'

interface PinnedTablesPanelProps {
  sessionId: string
  tables: Record<string, PinnedTable>
  className?: string
}

export function PinnedTablesPanel({
  sessionId,
  tables,
  className,
}: PinnedTablesPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const pinnedTables = useMemo(
    () => Object.values(tables).sort((a, b) => b.pinned_at - a.pinned_at),
    [tables]
  )
  const selected = selectedKey ? tables[selectedKey] : null

  if (pinnedTables.length === 0) return null

  return (
    <>
      <div
        className={cn(
          'rounded-lg border bg-card/95 p-2 shadow-sm backdrop-blur',
          className
        )}
      >
        <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
          <Pin className="size-3.5" />
          Pinned tables
        </div>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {pinnedTables.map(table => (
            <div key={table.key} className="group flex items-center gap-1">
              <button
                type="button"
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => setSelectedKey(table.key)}
              >
                <span className="block truncate">{table.title}</span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 opacity-60 hover:opacity-100"
                aria-label={`Unpin ${table.title}`}
                onClick={() =>
                  useChatStore.getState().unpinTable(sessionId, table.key)
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={open => {
          if (!open) setSelectedKey(null)
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{selected?.title ?? 'Pinned table'}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[70vh]">
            <Markdown>{selected?.markdown ?? ''}</Markdown>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  )
}
