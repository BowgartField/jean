import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { ScriptsButton } from './ScriptsButton'

const mocks = vi.hoisted(() => ({
  scripts: [
    { name: 'dev', command: 'pnpm', args: ['run', 'dev'] },
    { name: 'test:unit', command: 'pnpm', args: ['run', 'test:unit'] },
  ],
}))

vi.mock('@/services/projects', () => ({
  usePackageScripts: () => ({ data: mocks.scripts }),
}))

describe('ScriptsButton', () => {
  beforeEach(() => {
    mocks.scripts = [
      { name: 'dev', command: 'pnpm', args: ['run', 'dev'] },
      { name: 'test:unit', command: 'pnpm', args: ['run', 'test:unit'] },
    ]
  })

  it('lists package.json scripts and runs the selected script', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(<ScriptsButton worktreePath="/repo" onRun={onRun} />)

    await user.click(screen.getByRole('button', { name: 'Scripts' }))
    await user.click(screen.getByRole('menuitem', { name: 'test:unit' }))

    expect(onRun).toHaveBeenCalledWith(mocks.scripts[1])
  })

  it('is hidden when package.json has no scripts', () => {
    mocks.scripts = []
    render(<ScriptsButton worktreePath="/repo" onRun={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Scripts' })).toBeNull()
  })
})
