import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test/test-utils'
import { useUIStore } from '@/store/ui-store'
import { CliUpdateModal } from './CliUpdateModal'

vi.mock('@/components/preferences/CliReinstallModal', () => ({
  ClaudeCliReinstallModal: () => null,
  GhCliReinstallModal: () => null,
  CodexCliReinstallModal: () => null,
  OpenCodeCliReinstallModal: () => null,
  PiCliReinstallModal: () => null,
  CodeRabbitCliReinstallModal: () => null,
  CommandCodeCliReinstallModal: () => null,
  GrokCliReinstallModal: () => null,
  RemoteCliReinstallModal: ({
    cliType,
    backendHandle,
  }: {
    cliType: string
    backendHandle: string
  }) => <div>{`${cliType} on ${backendHandle}`}</div>,
}))

describe('CliUpdateModal', () => {
  beforeEach(() => {
    useUIStore.getState().closeCliUpdateModal()
  })

  it('routes the shared installer modal to the selected remote backend', () => {
    useUIStore.getState().openCliUpdateModal('claude', 'server-1')

    render(<CliUpdateModal />)

    expect(screen.getByText('claude on server-1')).toBeInTheDocument()
  })
})
