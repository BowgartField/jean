import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test/test-utils'
import type { Project, ProjectAutoFixSettings } from '@/types/projects'
import {
  AutoFixPane,
  hasAutoFixSettingsChanges,
  MR_ROBOT_SETTINGS_BADGE,
} from './AutoFixPane'

const mutateMock = vi.fn()
let projectsMock: Project[] = []

vi.mock('@/services/projects', () => ({
  useProjects: () => ({ data: projectsMock }),
  useUpdateProjectSettings: () => ({ mutate: mutateMock, isPending: false }),
}))

const baseAutoFixSettings: ProjectAutoFixSettings = {
  enabled: false,
  interval_minutes: 30,
  issue_limit: 2,
  max_parallel_worktrees: 3,
  planning_backend: 'claude',
  planning_model: 'haiku',
  auto_yolo_enabled: false,
  yolo_backend: 'claude',
  yolo_model: null,
  active_hours_enabled: false,
  active_hours_start: 20,
  active_hours_end: 8,
}

function project(
  autoFixSettings: Partial<ProjectAutoFixSettings> = {}
): Project {
  return {
    id: 'project-id',
    name: 'Project',
    path: '/tmp/project',
    default_branch: 'main',
    added_at: 1,
    order: 1,
    auto_fix_settings: {
      ...baseAutoFixSettings,
      ...autoFixSettings,
    },
  }
}

function renderPane() {
  return render(<AutoFixPane projectId="project-id" />)
}

function getElementAt<T>(items: T[], index: number): T {
  const item = items[index]
  if (!item) throw new Error(`Expected element at index ${index}`)
  return item
}

describe('AutoFixPane', () => {
  beforeEach(() => {
    mutateMock.mockReset()
    projectsMock = [project()]
    HTMLElement.prototype.hasPointerCapture = vi.fn()
    HTMLElement.prototype.releasePointerCapture = vi.fn()
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('labels Mr. Robot settings as beta', () => {
    expect(MR_ROBOT_SETTINGS_BADGE).toBe('Beta')
  })

  it('renders with project auto-fix settings', () => {
    renderPane()

    expect(screen.getByText('Mr. Robot')).toBeInTheDocument()
    expect(screen.getByText('Mr. Robot issue sweeps')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Save settings' })
    ).toBeInTheDocument()
  })

  it('disables save until settings change', () => {
    renderPane()

    const button = screen.getByRole('button', { name: 'Save settings' })
    expect(button).toBeDisabled()

    fireEvent.change(getElementAt(screen.getAllByRole('spinbutton'), 0), {
      target: { value: '45' },
    })

    expect(button).not.toBeDisabled()
  })

  it('does not submit unchanged settings', () => {
    renderPane()

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('detects deep settings changes', () => {
    expect(
      hasAutoFixSettingsChanges(baseAutoFixSettings, baseAutoFixSettings)
    ).toBe(false)
    expect(
      hasAutoFixSettingsChanges(baseAutoFixSettings, {
        ...baseAutoFixSettings,
        interval_minutes: 45,
      })
    ).toBe(true)
  })

  it('saves when toggles change', async () => {
    const user = userEvent.setup()
    renderPane()

    const switches = screen.getAllByRole('switch')
    await user.click(getElementAt(switches, 0))
    await user.click(getElementAt(switches, 1))

    expect(mutateMock).toHaveBeenNthCalledWith(1, {
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({ enabled: true }),
    })
    expect(mutateMock).toHaveBeenNthCalledWith(2, {
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        active_hours_enabled: true,
      }),
    })
  })

  it('clamps numeric inputs to at least one before saving', async () => {
    const user = userEvent.setup()
    renderPane()

    fireEvent.change(getElementAt(screen.getAllByRole('spinbutton'), 0), {
      target: { value: '0' },
    })
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({ interval_minutes: 1 }),
    })
  })

  it('clears the planning model when the planning backend changes', async () => {
    const user = userEvent.setup()
    renderPane()

    const comboboxes = screen.getAllByRole('combobox')
    expect(getElementAt(comboboxes, 1)).toHaveTextContent('Claude Haiku')

    await user.click(getElementAt(comboboxes, 0))
    await user.click(await screen.findByRole('option', { name: 'Codex' }))

    expect(getElementAt(screen.getAllByRole('combobox'), 1)).toHaveTextContent(
      'Backend default'
    )
  })

  it('trims model strings and saves blank models as null', async () => {
    const user = userEvent.setup()
    projectsMock = [
      project({
        planning_model: '  haiku  ',
        yolo_model: '   ',
      }),
    ]
    renderPane()

    fireEvent.change(getElementAt(screen.getAllByRole('spinbutton'), 0), {
      target: { value: '31' },
    })
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(mutateMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      autoFixSettings: expect.objectContaining({
        interval_minutes: 31,
        planning_model: 'haiku',
        yolo_model: null,
      }),
    })
  })
})
