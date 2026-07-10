import { describe, expect, it } from 'vitest'
import {
  codeReviewConfigKey,
  getCodeReviewSessionName,
  resolveCodeReviewConfigs,
} from './code-review-configs'

describe('code review configurations', () => {
  it('uses up to five unique configured backend and model pairs', () => {
    expect(
      resolveCodeReviewConfigs({
        configured: [
          { backend: 'codex', model: 'gpt-5.6-sol' },
          { backend: 'claude', model: 'claude-opus-4-8[1m]' },
          { backend: 'codex', model: 'gpt-5.6-sol' },
          { backend: 'cursor', model: 'cursor/auto' },
          { backend: 'pi', model: 'pi/default' },
          { backend: 'grok', model: 'grok/fast' },
          { backend: 'opencode', model: 'opencode/model' },
        ],
        fallbackBackend: 'claude',
        fallbackModel: 'sonnet',
      })
    ).toEqual([
      { backend: 'codex', model: 'gpt-5.6-sol' },
      { backend: 'claude', model: 'claude-opus-4-8[1m]' },
      { backend: 'cursor', model: 'cursor/auto' },
      { backend: 'pi', model: 'pi/default' },
      { backend: 'grok', model: 'grok/fast' },
    ])
  })

  it('falls back to the existing single code review selection', () => {
    expect(
      resolveCodeReviewConfigs({
        configured: [],
        fallbackBackend: 'claude',
        fallbackModel: 'claude-sonnet-5',
      })
    ).toEqual([{ backend: 'claude', model: 'claude-sonnet-5' }])
  })

  it('identifies duplicate backend and model pairs', () => {
    expect(
      codeReviewConfigKey({ backend: 'codex', model: 'gpt-5.6-sol' })
    ).toBe('codex\u0000gpt-5.6-sol')
  })

  it('builds a session name that identifies the backend and model', () => {
    expect(
      getCodeReviewSessionName({ backend: 'codex', model: 'gpt-5.6-sol' })
    ).toBe('Code Review · Codex · gpt-5.6-sol')
  })
})
