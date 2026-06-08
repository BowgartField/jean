import { describe, expect, it } from 'vitest'
import { MR_ROBOT_SETTINGS_BADGE } from './AutoFixPane'

describe('AutoFixPane', () => {
  it('labels Mr. Robot settings as beta', () => {
    expect(MR_ROBOT_SETTINGS_BADGE).toBe('Beta')
  })
})
