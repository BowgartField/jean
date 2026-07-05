import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import type { RemoteServerConfig } from '@/types/remote'
import { useUIStore } from '@/store/ui-store'
import { RemoteServersPane } from './RemoteServersPane'

const mocks = vi.hoisted(() => ({
  servers: [] as RemoteServerConfig[],
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  provision: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  refetch: vi.fn(),
  claudeInstalled: true,
  claudeAuthenticated: false,
  claudeOutdated: false,
  invoke: vi.fn(),
}))

vi.mock('@/services/remote-cli-tools', () => ({
  remoteCliToolsQueryKeys: {
    all: (serverId: string) => ['remote-cli-tools', serverId],
  },
  getRemoteCursorInstallCommand: vi.fn(),
  useRemoteCliTools: () => [
    {
      definition: {
        backend: 'claude',
        statusCommand: 'check_claude_cli_installed',
        authCommand: 'check_claude_cli_auth',
        versionsCommand: 'get_available_cli_versions',
        installCommand: 'install_claude_cli',
      },
      status: {
        installed: mocks.claudeInstalled,
        version: '2.1.196',
        path: '/opt/jean/bin/claude',
        supports_auth_command: true,
      },
      auth: { authenticated: mocks.claudeAuthenticated, error: null },
      isLoading: false,
      isError: false,
      isAuthLoading: false,
      latestVersion: mocks.claudeOutdated ? '2.2.0' : '2.1.196',
      isOutdated: mocks.claudeOutdated,
    },
    {
      definition: {
        backend: 'codex',
        statusCommand: 'check_codex_cli_installed',
        authCommand: 'check_codex_cli_auth',
        versionsCommand: 'get_available_codex_versions',
        installCommand: 'install_codex_cli',
      },
      status: { installed: false, version: null, path: null },
      auth: undefined,
      isLoading: false,
      isError: false,
      isAuthLoading: false,
      latestVersion: null,
      isOutdated: false,
    },
  ],
}))

vi.mock('@/services/remote-servers', () => ({
  useRemoteServers: () => ({
    data: mocks.servers,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: mocks.refetch,
  }),
  useAddRemoteServer: () => ({
    mutateAsync: mocks.add,
    isPending: false,
  }),
  useUpdateRemoteServer: () => ({
    mutateAsync: mocks.update,
    isPending: false,
  }),
  useRemoveRemoteServer: () => ({ mutateAsync: mocks.remove }),
  useTestRemoteServer: () => ({ mutateAsync: mocks.test }),
  useProvisionRemoteServer: () => ({ mutateAsync: mocks.provision }),
  useRemoteJeanVersions: () => ({ data: [], isLoading: false }),
  useConnectRemoteServer: () => ({ mutateAsync: mocks.connect }),
  useDisconnectRemoteServer: () => ({ mutateAsync: mocks.disconnect }),
}))

vi.mock('@/lib/transport', () => ({
  listen: vi.fn(async () => vi.fn()),
  invoke: mocks.invoke,
}))

vi.mock('@/lib/platform', () => ({
  isMacOS: true,
}))

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(() => 'toast-id'),
    success: vi.fn(),
    error: vi.fn(),
  },
}))

const server: RemoteServerConfig = {
  id: 'server-1',
  name: 'Test server',
  host: '203.0.113.10',
  port: 22,
  username: 'test-user',
  auth: {
    type: 'ssh_key_path',
    path: '~/.ssh/id_test',
    passphrase: 'test-passphrase',
  },
  default: true,
  remote_port: 3456,
  status: 'disconnected',
  http_token: 'token',
  installed_version: '0.1.60',
}

describe('RemoteServersPane', () => {
  beforeEach(() => {
    mocks.servers = []
    Object.values(mocks).forEach(value => {
      if (typeof value === 'function' && 'mockReset' in value) {
        value.mockReset()
      }
    })
    mocks.add.mockResolvedValue({ ...server, status: 'connected' })
    mocks.claudeInstalled = true
    mocks.claudeAuthenticated = false
    mocks.claudeOutdated = false
    mocks.invoke.mockResolvedValue({ claude_cli: false, gh_cli: false })
    useUIStore.getState().closeCliLoginModal()
    useUIStore.getState().closeCliUpdateModal()
    mocks.test.mockResolvedValue({
      success: true,
      message: 'SSH connection successful',
      hostname: 'example-remote-host',
      os: 'Linux',
      architecture: 'x86_64',
    })
  })

  it('adds a key-authenticated remote server from the empty state', async () => {
    const user = userEvent.setup()
    render(<RemoteServersPane />)

    expect(
      screen.queryByRole('button', { name: 'Add server' })
    ).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: 'Add your first server' })
    )
    await user.type(screen.getByLabelText('Display name'), 'Test server')
    await user.type(screen.getByLabelText('Host or IP address'), '203.0.113.10')
    await user.clear(screen.getByLabelText('SSH username'))
    await user.type(screen.getByLabelText('SSH username'), 'test-user')
    await user.clear(screen.getByLabelText('Private key path'))
    await user.type(screen.getByLabelText('Private key path'), '~/.ssh/id_test')
    await user.type(screen.getByLabelText(/Key passphrase/), 'test-passphrase')
    await user.click(screen.getByRole('button', { name: 'Add server' }))

    await waitFor(() => {
      expect(mocks.add).toHaveBeenCalledWith({
        name: 'Test server',
        host: '203.0.113.10',
        port: 22,
        username: 'test-user',
        auth: {
          type: 'ssh_key_path',
          path: '~/.ssh/id_test',
          passphrase: 'test-passphrase',
        },
        default: false,
        remote_port: 3456,
      })
    })
  })

  it('tests SSH for a configured server', async () => {
    mocks.servers = [server]
    const user = userEvent.setup()
    render(<RemoteServersPane />)

    expect(screen.getByText('Test server')).toBeInTheDocument()
    expect(screen.getByText('0.1.60')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Test SSH' }))

    await waitFor(() => {
      expect(mocks.test).toHaveBeenCalledWith('server-1')
    })
  })

  it('shows connecting while an SSH test is running', async () => {
    mocks.servers = [server]
    mocks.test.mockReturnValue(new Promise(() => undefined))
    const user = userEvent.setup()
    render(<RemoteServersPane />)

    await user.click(screen.getByRole('button', { name: 'Test SSH' }))

    expect(screen.getByText('Connecting')).toBeInTheDocument()
  })

  it('uses an add-server card when servers already exist', () => {
    mocks.servers = [server]

    render(<RemoteServersPane />)

    expect(
      screen.getByRole('button', { name: 'Add new server' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Add server' })
    ).not.toBeInTheDocument()
  })

  it('opens the provisioning modal and starts provisioning', async () => {
    mocks.servers = [
      {
        ...server,
        status: 'connected',
        http_token: null,
        installed_version: null,
      },
    ]
    mocks.provision.mockResolvedValue({
      success: true,
      version: '0.1.60',
      remote_port: 3456,
      service_name: 'jean-remote.service',
    })
    const user = userEvent.setup()
    render(<RemoteServersPane />)

    await user.click(screen.getByRole('button', { name: 'Provision' }))
    expect(
      screen.getByRole('heading', {
        name: 'Provision Test server',
      })
    ).toBeInTheDocument()
    expect(screen.getByText('Provisioning timeline')).toBeInTheDocument()
    expect(screen.getByText('Live logs')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Provision server' }))

    await waitFor(() => {
      expect(mocks.provision).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: 'server-1' })
      )
    })
  })

  it('detects missing Claude auth and opens login on the remote backend', async () => {
    mocks.servers = [{ ...server, status: 'connected' }]
    const user = userEvent.setup()
    render(<RemoteServersPane />)

    await user.click(screen.getByRole('button', { name: 'Login' }))

    expect(useUIStore.getState()).toMatchObject({
      cliLoginModalOpen: true,
      cliLoginModalType: 'claude',
      cliLoginModalCommand: '/opt/jean/bin/claude',
      cliLoginModalCommandArgs: ['auth', 'login'],
      cliLoginModalBackendHandle: 'server-1',
    })
  })

  it('shows installed CLIs as square cards and opens the installer picker', async () => {
    mocks.servers = [{ ...server, status: 'connected' }]
    mocks.claudeAuthenticated = true
    const user = userEvent.setup()

    render(<RemoteServersPane />)

    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('v2.1.196')).toBeInTheDocument()
    expect(screen.getByTitle('Authenticated')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Login' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Install more' }))
    expect(
      screen.getByRole('heading', { name: 'Install an AI CLI' })
    ).toBeInTheDocument()
    await user.click(screen.getByText('Codex'))
    expect(useUIStore.getState()).toMatchObject({
      cliUpdateModalOpen: true,
      cliUpdateModalType: 'codex',
      cliUpdateModalBackendHandle: 'server-1',
    })
  })

  it('opens a remote update modal for an outdated CLI', async () => {
    mocks.servers = [{ ...server, status: 'connected' }]
    mocks.claudeAuthenticated = true
    mocks.claudeOutdated = true
    const user = userEvent.setup()

    render(<RemoteServersPane />)
    await user.click(screen.getByRole('button', { name: 'Outdated' }))

    expect(useUIStore.getState()).toMatchObject({
      cliUpdateModalOpen: true,
      cliUpdateModalType: 'claude',
      cliUpdateModalBackendHandle: 'server-1',
    })
  })
})
