import { describe, expect, it } from 'vitest'
import { assertTrainingOutcomeVisible } from './agentMarketLiveAccess'

const valid = { showcaseOptIn: 1, score: 88, reviewedAt: '2026-11-05T00:00:00Z', evidenceSha256: 'a'.repeat(64) }

describe('训练成绩公开边界', () => {
  it('真实 0 分可公开，空值/false/数组不得伪装成 0 分', () => {
    expect(() => assertTrainingOutcomeVisible({ ...valid, score: 0 })).not.toThrow()
    expect(() => assertTrainingOutcomeVisible({ ...valid, score: '0' })).not.toThrow()
    for (const score of [null, undefined, '', false, [], {}]) {
      expect(() => assertTrainingOutcomeVisible({ ...valid, score })).toThrow('training_outcome_score_invalid')
    }
  })
})
