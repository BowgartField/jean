import userEvent from '@testing-library/user-event'
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, within } from '@/test/test-utils'
import { PinnedTablesPanel } from './PinnedTablesPanel'
import { useChatStore } from '@/store/chat-store'

describe('PinnedTablesPanel', () => {
  beforeEach(() => {
    useChatStore.setState({ pinnedTables: {} })
  })

  it('opens a pinned table in a modal and can unpin it', async () => {
    useChatStore.setState({
      pinnedTables: {
        'session-1': {
          'message-1:10': {
            key: 'message-1:10',
            title: 'Priority / Issue',
            markdown: '| Priority | Issue |\n| --- | --- |\n| P0 | Broken |',
            pinned_at: 100,
          },
        },
      },
    })

    render(
      <PinnedTablesPanel
        sessionId="session-1"
        tables={useChatStore.getState().pinnedTables['session-1'] ?? {}}
      />
    )

    await userEvent.click(
      screen.getByRole('button', { name: /^priority \/ issue$/i })
    )

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('P0')).toBeInTheDocument()
    expect(within(dialog).getByText('Broken')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }))

    await userEvent.click(
      screen.getByRole('button', { name: /unpin priority \/ issue/i })
    )

    expect(useChatStore.getState().pinnedTables['session-1']).toBeUndefined()
  })
})
