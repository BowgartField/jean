import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { isNewerVersion } from '@/lib/version-utils'
import type { CliBackend } from '@/types/preferences'

export interface RemoteCliStatus {
  installed: boolean
  version: string | null
  path: string | null
  supports_auth_command?: boolean
}

interface RemoteCliAuth {
  authenticated: boolean
  error: string | null
}

interface RemoteCliVersion {
  version: string
  prerelease: boolean
}

export interface RemoteCliToolDefinition {
  backend: CliBackend
  statusCommand: string
  authCommand: string
  versionsCommand: string | null
  installCommand: string | null
}

export const REMOTE_CLI_TOOLS: RemoteCliToolDefinition[] = [
  {
    backend: 'claude',
    statusCommand: 'check_claude_cli_installed',
    authCommand: 'check_claude_cli_auth',
    versionsCommand: 'get_available_cli_versions',
    installCommand: 'install_claude_cli',
  },
  {
    backend: 'codex',
    statusCommand: 'check_codex_cli_installed',
    authCommand: 'check_codex_cli_auth',
    versionsCommand: 'get_available_codex_versions',
    installCommand: 'install_codex_cli',
  },
  {
    backend: 'opencode',
    statusCommand: 'check_opencode_cli_installed',
    authCommand: 'check_opencode_cli_auth',
    versionsCommand: 'get_available_opencode_versions',
    installCommand: 'install_opencode_cli',
  },
  {
    backend: 'cursor',
    statusCommand: 'check_cursor_cli_installed',
    authCommand: 'check_cursor_cli_auth',
    versionsCommand: null,
    installCommand: null,
  },
  {
    backend: 'pi',
    statusCommand: 'check_pi_cli_installed',
    authCommand: 'check_pi_cli_auth',
    versionsCommand: 'get_available_pi_versions',
    installCommand: 'install_pi_cli',
  },
  {
    backend: 'commandcode',
    statusCommand: 'check_commandcode_cli_installed',
    authCommand: 'check_commandcode_cli_auth',
    versionsCommand: 'get_available_commandcode_versions',
    installCommand: 'install_commandcode_cli',
  },
  {
    backend: 'grok',
    statusCommand: 'check_grok_cli_installed',
    authCommand: 'check_grok_cli_auth',
    versionsCommand: 'get_available_grok_versions',
    installCommand: 'install_grok_cli',
  },
]

export const remoteCliToolsQueryKeys = {
  all: (serverId: string) => ['remote-cli-tools', serverId] as const,
  status: (serverId: string, backend: CliBackend) =>
    [...remoteCliToolsQueryKeys.all(serverId), backend, 'status'] as const,
  auth: (serverId: string, backend: CliBackend) =>
    [...remoteCliToolsQueryKeys.all(serverId), backend, 'auth'] as const,
  versions: (serverId: string, backend: CliBackend) =>
    [...remoteCliToolsQueryKeys.all(serverId), backend, 'versions'] as const,
}

function remoteArgs(serverId: string) {
  return { _backendHandle: serverId }
}

export function useRemoteCliTools(serverId: string, enabled: boolean) {
  const statusQueries = useQueries({
    queries: REMOTE_CLI_TOOLS.map(tool => ({
      queryKey: remoteCliToolsQueryKeys.status(serverId, tool.backend),
      queryFn: () =>
        invoke<RemoteCliStatus>(tool.statusCommand, remoteArgs(serverId)),
      enabled,
      staleTime: 30_000,
    })),
  })

  const authQueries = useQueries({
    queries: REMOTE_CLI_TOOLS.map((tool, index) => ({
      queryKey: remoteCliToolsQueryKeys.auth(serverId, tool.backend),
      queryFn: () =>
        invoke<RemoteCliAuth>(tool.authCommand, remoteArgs(serverId)),
      enabled: enabled && statusQueries[index]?.data?.installed === true,
      staleTime: 15_000,
    })),
  })

  const versionQueries = useQueries({
    queries: REMOTE_CLI_TOOLS.map((tool, index) => ({
      queryKey: remoteCliToolsQueryKeys.versions(serverId, tool.backend),
      queryFn: () =>
        invoke<RemoteCliVersion[]>(
          tool.versionsCommand as string,
          remoteArgs(serverId)
        ),
      enabled:
        enabled &&
        tool.versionsCommand !== null &&
        statusQueries[index]?.data?.installed === true,
      staleTime: 15 * 60_000,
    })),
  })

  return REMOTE_CLI_TOOLS.map((tool, index) => {
    const status = statusQueries[index]
    const auth = authQueries[index]
    const versions = versionQueries[index]?.data ?? []
    const latestVersion =
      versions.find(version => !version.prerelease)?.version ?? null
    const currentVersion = status?.data?.version ?? null
    return {
      definition: tool,
      status: status?.data,
      auth: auth?.data,
      isLoading: status?.isLoading ?? false,
      isError: status?.isError ?? false,
      isAuthLoading: auth?.isLoading ?? false,
      latestVersion,
      isOutdated:
        currentVersion !== null &&
        latestVersion !== null &&
        isNewerVersion(latestVersion, currentVersion),
    }
  })
}

export function useRemoteCliSetup(serverId: string, backend: CliBackend) {
  const queryClient = useQueryClient()
  const tool = REMOTE_CLI_TOOLS.find(candidate => candidate.backend === backend)

  const status = useQuery({
    queryKey: remoteCliToolsQueryKeys.status(serverId, backend),
    queryFn: () => {
      if (!tool) throw new Error(`Unknown remote CLI: ${backend}`)
      return invoke<RemoteCliStatus>(tool.statusCommand, remoteArgs(serverId))
    },
  })
  const versions = useQuery({
    queryKey: remoteCliToolsQueryKeys.versions(serverId, backend),
    queryFn: () => {
      if (!tool?.versionsCommand) {
        throw new Error(`Remote installation is not supported for ${backend}`)
      }
      return invoke<RemoteCliVersion[]>(
        tool.versionsCommand,
        remoteArgs(serverId)
      )
    },
    staleTime: 15 * 60_000,
  })
  const installMutation = useMutation({
    mutationFn: (version: string) => {
      if (!tool?.installCommand) {
        throw new Error(`Remote installation is not supported for ${backend}`)
      }
      return invoke(tool.installCommand, {
        version,
        _backendHandle: serverId,
      })
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: remoteCliToolsQueryKeys.all(serverId),
      }),
  })

  return {
    status: status.data,
    versions: versions.data ?? [],
    isVersionsLoading: versions.isFetching,
    progress: null,
    install: (
      version: string,
      options?: { onSuccess?: () => void; onError?: (error: Error) => void }
    ) => {
      installMutation.mutate(version, options)
    },
    refetchStatus: () => void status.refetch(),
  }
}

export function getRemoteCursorInstallCommand(serverId: string) {
  return invoke<{ command: string; args: string[] }>(
    'get_cursor_install_command',
    remoteArgs(serverId)
  )
}
