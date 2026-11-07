import { createHash } from 'node:crypto'

export interface TrainingOutcomeVisibilityInput {
  showcaseOptIn: unknown
  score: unknown
  reviewedAt: unknown
  evidenceSha256: unknown
}

/** 公开成绩必须同时满足主动授权、独立复核时间与证据哈希；缺一项即不可见。 */
export function assertTrainingOutcomeVisible(input: TrainingOutcomeVisibilityInput): void {
  if (input.showcaseOptIn !== 1 && input.showcaseOptIn !== true && input.showcaseOptIn !== '1') {
    throw new Error('training_outcome_not_public')
  }
  if (input.score === null || input.score === undefined || input.score === '' || typeof input.score === 'boolean' || (typeof input.score !== 'number' && typeof input.score !== 'string')) throw new Error('training_outcome_score_invalid')
  const score = Number(input.score)
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) throw new Error('training_outcome_score_invalid')
  const reviewedAt = input.reviewedAt instanceof Date ? input.reviewedAt.getTime() : Date.parse(String(input.reviewedAt ?? ''))
  if (!Number.isFinite(reviewedAt)) throw new Error('training_outcome_not_independently_reviewed')
  if (typeof input.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.evidenceSha256)) {
    throw new Error('training_outcome_evidence_missing')
  }
}

export function marketLiveFeedVersion(items: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex')
}
