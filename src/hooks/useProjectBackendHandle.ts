import { useQueryClient } from '@tanstack/react-query'
import { projectsQueryKeys } from '@/services/projects'
import type { Project, Worktree } from '@/types/projects'

/**
 * Returns the remote server ID for a given project, or null if the project
 * is local. Reads from TanStack Query cache (no network request).
 */
export function useProjectBackendHandle(
  projectId: string | null | undefined
): string | null {
  const queryClient = useQueryClient()
  if (!projectId) return null
  const projects = queryClient.getQueryData<Project[]>(projectsQueryKeys.list())
  return projects?.find(p => p.id === projectId)?.server_id ?? null
}

/**
 * Returns the remote server ID for the project that owns the given worktree,
 * or null if local. Reads from TanStack Query cache.
 */
export function useBackendHandleForWorktree(
  worktreeId: string | null | undefined
): string | null {
  const queryClient = useQueryClient()
  if (!worktreeId) return null
  const worktree = queryClient.getQueryData<Worktree>([
    'projects',
    'worktree',
    worktreeId,
  ])
  if (!worktree) return null
  const projects = queryClient.getQueryData<Project[]>(projectsQueryKeys.list())
  return projects?.find(p => p.id === worktree.project_id)?.server_id ?? null
}
