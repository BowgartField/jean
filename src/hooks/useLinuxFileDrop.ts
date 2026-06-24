import { useEffect } from 'react'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { isNativeApp } from '@/lib/environment'
import { useChatStore } from '@/store/chat-store'
import {
  processDroppedImage,
  processDroppedSvg,
} from '@/components/chat/hooks/useDragAndDropImages'
import { formatPathForPty } from '@/components/chat/hooks/useTerminalImageDrop'
import {
  ALLOWED_IMAGE_EXTENSIONS,
  SVG_EXTENSION,
} from '@/components/chat/image-constants'

interface LinuxFileDropPayload {
  paths: string[]
  /** Drop position in webview device pixels (from GTK drag-drop) */
  x: number
  y: number
}

function getExtension(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

interface DropTarget {
  terminalId: string | null
  sessionId: string | null
}

/** Resolve what is under the drop point: a terminal and/or a chat session. */
function dropTargetAtPoint(x: number, y: number): DropTarget {
  const cssX = x / window.devicePixelRatio
  const cssY = y / window.devicePixelRatio
  const el = document.elementFromPoint(cssX, cssY)
  return {
    terminalId:
      el?.closest('[data-terminal-id]')?.getAttribute('data-terminal-id') ??
      null,
    sessionId:
      el
        ?.closest('[data-chat-session-id]')
        ?.getAttribute('data-chat-session-id') ?? null,
  }
}

/** Active chat session from the store (fallback when the drop point has none). */
function activeSessionId(): string | undefined {
  const { activeWorktreeId, activeSessionIds } = useChatStore.getState()
  return activeWorktreeId ? activeSessionIds[activeWorktreeId] : undefined
}

/** Write dropped file paths into a terminal's pty (Claude Code attaches them). */
async function routeToTerminal(
  terminalId: string,
  paths: string[]
): Promise<void> {
  const data = paths.map(formatPathForPty).join('')
  try {
    await invoke('terminal_write', { terminalId, data })
  } catch (error) {
    console.error('Failed to write dropped path to terminal:', error)
    toast.error('Failed to insert image into terminal', {
      description: String(error),
    })
  }
}

/** Attach dropped images to a chat session. */
function routeToChat(paths: string[], sessionId: string | undefined): void {
  if (!sessionId) {
    toast.error('No active session', {
      description: 'Open a session to attach a dropped image',
    })
    return
  }

  let handled = false
  for (const path of paths) {
    const ext = getExtension(path)
    if (ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
      processDroppedImage(path, sessionId)
      handled = true
    } else if (ext === SVG_EXTENSION) {
      processDroppedSvg(path, sessionId)
      handled = true
    }
  }
  if (!handled) {
    toast.error('No image detected', {
      description: 'Only PNG, JPEG, GIF, WebP, SVG files are accepted',
    })
  }
}

/**
 * Handle OS file drops on Linux/WebKitGTK.
 *
 * On Linux, WebKitGTK handles file drops natively (DOM drag-drop does not
 * fire usable events — tauri-apps/tauri#12052), so the Rust side intercepts
 * the drop, prevents the default navigation, and emits `linux-file-drop` with
 * the file paths + drop position. Here we route by position: a drop over a
 * terminal writes the path into its pty; anywhere else attaches the image to
 * the active chat session.
 */
export function useLinuxFileDrop(): void {
  useEffect(() => {
    if (!isNativeApp()) return

    let unlisten: (() => void) | null = null
    let cancelled = false

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<LinuxFileDropPayload>('linux-file-drop', event => {
        const { paths, x, y } = event.payload
        if (!paths || paths.length === 0) return

        const { terminalId, sessionId } = dropTargetAtPoint(x, y)
        if (terminalId) {
          routeToTerminal(terminalId, paths)
        } else {
          routeToChat(paths, sessionId ?? activeSessionId())
        }
      }).then(fn => {
        if (cancelled) fn()
        else unlisten = fn
      })
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
