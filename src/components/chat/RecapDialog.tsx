import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Markdown } from '@/components/ui/markdown'

interface RecapDialogProps {
  content: string
  isOpen: boolean
  onClose: () => void
}

export function RecapDialog({ content, isOpen, onClose }: RecapDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle>Session recap</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-4">
          <Markdown streaming={false}>{content}</Markdown>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
