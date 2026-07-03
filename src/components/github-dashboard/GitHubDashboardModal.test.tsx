import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor, render } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { GitHubDashboardModal } from './GitHubDashboardModal'

const mockInvoke = vi.hoisted(() => vi.fn())
const mockUseProjects = vi.hoisted(() => vi.fn())
const mockUseGhCliAuth = vi.hoisted(() => vi.fn())

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  listen: vi.fn(),
}))

vi.mock('@/services/projects', () => ({
  isTauri: () => true,
  isFolder: () => false,
  useProjects: mockUseProjects,
  useCreateWorktree: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@/hooks/useGhLogin', () => ({
  useGhLogin: () => ({ triggerLogin: vi.fn(), isGhInstalled: true }),
}))

vi.mock('@/services/gh-cli', () => ({
  useGhCliAuth: mockUseGhCliAuth,
}))

vi.mock('@/components/shared/GhAuthError', () => ({
  GhAuthError: () => <div data-testid="gh-auth-error">GitHub auth prompt</div>,
}))

vi.mock('@/components/worktree/IssuePreviewModal', () => ({
  IssuePreviewModal: () => null,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
  },
}))

const project = {
  id: 'project-1',
  name: 'Project 1',
  path: '/tmp/project-1',
}

const favoriteProject = {
  id: 'project-2',
  name: 'Favorite Project',
  path: '/tmp/project-2',
}

function renderDashboard() {
  useUIStore.setState({ githubDashboardOpen: true })
  render(<GitHubDashboardModal />)
}

function emptyIssueResult() {
  return { issues: [], totalCount: 0 }
}

function resolveEmptyDashboardCommand(command: string) {
  if (command === 'list_github_issues')
    return Promise.resolve(emptyIssueResult())
  if (command === 'list_github_prs') return Promise.resolve([])
  if (command === 'list_dependabot_alerts') return Promise.resolve([])
  if (command === 'list_repository_advisories') return Promise.resolve([])
  return Promise.resolve(null)
}

describe('GitHubDashboardModal auth error handling', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
    Element.prototype.hasPointerCapture ??= vi.fn(() => false)
    Element.prototype.setPointerCapture ??= vi.fn()
    Element.prototype.releasePointerCapture ??= vi.fn()
    Element.prototype.scrollIntoView ??= vi.fn()

    mockInvoke.mockReset()
    mockUseProjects.mockReset()
    mockUseGhCliAuth.mockReset()
    useProjectsStore.setState({
      githubDashboardFavoriteProjectIds: [],
    })

    mockUseProjects.mockReturnValue({ data: [project] })
    mockUseGhCliAuth.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
    })
  })

  it('does not show the login prompt for unsupported GitHub remotes that mention gh auth login', async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_github_issues') {
        return Promise.reject(
          'gh issue list failed: none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`'
        )
      }
      return resolveEmptyDashboardCommand(command)
    })

    renderDashboard()

    expect(await screen.findByText('No open issues found')).toBeInTheDocument()
    expect(screen.queryByTestId('gh-auth-error')).not.toBeInTheDocument()
    expect(mockUseGhCliAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })

  it('shows a command error instead of a login prompt when gh is authenticated', async () => {
    mockUseGhCliAuth.mockReturnValue({
      data: { authenticated: true, error: null },
      isLoading: false,
      isFetching: false,
    })
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_github_issues') {
        return Promise.reject(
          "GitHub CLI not authenticated. Run 'gh auth login' first."
        )
      }
      return resolveEmptyDashboardCommand(command)
    })

    renderDashboard()

    expect(
      await screen.findByText(
        "GitHub CLI not authenticated. Run 'gh auth login' first.",
        {},
        { timeout: 3000 }
      )
    ).toBeInTheDocument()
    expect(screen.queryByTestId('gh-auth-error')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mockUseGhCliAuth).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: true })
      )
    })
  })

  it('shows the login prompt only when gh auth status reports unauthenticated', async () => {
    mockUseGhCliAuth.mockReturnValue({
      data: { authenticated: false, error: 'not logged in' },
      isLoading: false,
      isFetching: false,
    })
    mockInvoke.mockImplementation((command: string) => {
      if (command === 'list_github_issues') {
        return Promise.reject(
          "GitHub CLI not authenticated. Run 'gh auth login' first."
        )
      }
      return resolveEmptyDashboardCommand(command)
    })

    renderDashboard()

    expect(
      await screen.findByTestId('gh-auth-error', {}, { timeout: 3000 })
    ).toBeInTheDocument()
  })

  it('renders as a padded large modal instead of full-screen or the old smaller modal', () => {
    mockInvoke.mockImplementation(resolveEmptyDashboardCommand)

    renderDashboard()

    const dashboard = screen.getByRole('dialog', { name: 'GitHub Dashboard' })
    expect(dashboard).toHaveClass(
      '!w-[calc(100vw-4rem)]',
      '!h-[calc(100dvh-6rem)]',
      '!max-w-[calc(100vw-4rem)]',
      '!max-h-[calc(100dvh-6rem)]',
      '!rounded-lg'
    )
    expect(dashboard.className).not.toContain('!w-screen')
    expect(dashboard.className).not.toContain('!h-dvh')
    expect(dashboard.className).not.toContain('sm:!w-[90vw]')
    expect(dashboard.className).not.toContain('sm:!h-[85vh]')
  })

  it('lets projects be favorited and keeps favorites at the top of the project filter', async () => {
    const user = userEvent.setup()
    mockUseProjects.mockReturnValue({ data: [project, favoriteProject] })
    mockInvoke.mockImplementation(resolveEmptyDashboardCommand)

    renderDashboard()

    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: 'Favorite Project' }))
    await user.click(
      screen.getByRole('button', {
        name: 'Favorite Favorite Project in GitHub dashboard',
      })
    )

    const favoriteIds =
      useProjectsStore.getState().githubDashboardFavoriteProjectIds
    expect(favoriteIds).toEqual(['project-2'])

    await user.click(screen.getByRole('combobox'))
    const options = screen
      .getAllByRole('option')
      .map(option => option.textContent)
    expect(options).toEqual(['All Projects', 'Favorite Project', 'Project 1'])
  })
})
