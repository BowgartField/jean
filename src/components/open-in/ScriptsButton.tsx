import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePackageScripts, type PackageScript } from '@/services/projects'

interface ScriptsButtonProps {
  worktreePath: string
  onRun: (script: PackageScript) => void
}

export function ScriptsButton({ worktreePath, onRun }: ScriptsButtonProps) {
  const { data: scripts = [] } = usePackageScripts(worktreePath)

  if (scripts.length === 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-label="Scripts"
        >
          <Play className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Scripts</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {scripts.map(script => (
          <DropdownMenuItem key={script.name} onSelect={() => onRun(script)}>
            <Play className="h-3.5 w-3.5" />
            <span className="font-mono text-xs">{script.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
