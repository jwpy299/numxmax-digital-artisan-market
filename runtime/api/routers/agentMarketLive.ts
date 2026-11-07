import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { sql } from 'drizzle-orm'
import { createRouter, publicQuery } from '../middleware'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { sessionMe } from './wbSession'
import { assertTrainingOutcomeVisible, marketLiveFeedVersion } from '../lib/agentMarketLiveAccess'
import { normalizePublicDisplayName } from '../lib/agentMarketPublic'
import { assertAgentEmploymentSchemaReady } from './agentEmployment'

const FEED_LIMIT = 50
const FEED_CACHE_MS = 5_000
type FeedCacheEntry = { expiresAt: number; value: Promise<Record<string, unknown>> }
const feedCaches = new Map<object, Map<number, FeedCacheEntry>>()
export function invalidateAgentMarketLiveFeedCache(): void { feedCaches.clear() }
export interface AgentMarketLiveItem {
  id: string
  kind: 'job' | 'training'
  title: string
  actor: string
  status: string
  occurredAt: string
  evidenceSha256: string | null
}

export async function readAgentMarketLiveFeed(db = getDb(), limit = 30) {
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, FEED_LIMIT) : 30
  const byLimit = feedCaches.get(db) ?? new Map<number, FeedCacheEntry>()
  const cached = byLimit.get(bounded)
  if (cached && cached.expiresAt > Date.now()) return cached.value as ReturnType<typeof readAgentMarketLiveFeedUncached>
  const pending = readAgentMarketLiveFeedUncached(db, bounded)
  byLimit.set(bounded, { expiresAt: Date.now() + FEED_CACHE_MS, value: pending })
  feedCaches.set(db, byLimit)
  try { return await pending } catch (error) { byLimit.delete(bounded); throw error }
}

async function readAgentMarketLiveFeedUncached(db = getDb(), limit = 30) {
  await assertAgentEmploymentSchemaReady(db)
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, FEED_LIMIT) : 30
  const jobs = rawRows(await db.execute(sql`
    SELECT t.id, t.title, t.status, t.created_at AS createdAt, t.public_actor_name AS publicActorName
    FROM st_agent_work_tasks t
    WHERE t.public_feed=1 AND t.public_actor_name IS NOT NULL AND CHAR_LENGTH(t.public_actor_name)>=2
      AND t.status IN ('open','claimed','submitted') AND (t.deadline_at IS NULL OR t.deadline_at>NOW())
    ORDER BY t.created_at DESC, t.id DESC LIMIT ${bounded}`))
  const jobItems: AgentMarketLiveItem[] = []
  let skippedInvalidJobs = 0
  for (const row of jobs) {
    try {
      jobItems.push({
        id: `job-${Number(row.id)}`,
        kind: 'job',
        title: String(row.title),
        actor: normalizePublicDisplayName(String(row.publicActorName)),
        status: String(row.status),
        occurredAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        evidenceSha256: null,
      })
    } catch { skippedInvalidJobs += 1 }
  }
  const training = rawRows(await db.execute(sql`
    SELECT c.id, c.score, c.status, c.reviewed_at AS reviewedAt, r.public_display_name AS publicDisplayName,
           r.showcase_opt_in AS showcaseOptIn,
           (SELECT t.evidence_sha256 FROM st_agent_training_tasks t
            WHERE t.cycle_id=c.id AND t.evidence_sha256 IS NOT NULL
            ORDER BY t.day_no DESC LIMIT 1) AS evidenceSha256
    FROM st_agent_training_cycles c
    JOIN st_agent_registrations r ON r.id=c.registration_id
    WHERE c.status IN ('passed','failed') AND c.score IS NOT NULL AND c.reviewed_at IS NOT NULL
      AND r.showcase_opt_in=1 AND r.public_display_name IS NOT NULL AND CHAR_LENGTH(r.public_display_name)>=2
    ORDER BY c.reviewed_at DESC, c.id DESC LIMIT ${bounded}`))
  const trainingItems: AgentMarketLiveItem[] = []
  let skippedInvalidTraining = 0
  for (const row of training) {
    try {
      assertTrainingOutcomeVisible({
        showcaseOptIn: row.showcaseOptIn,
        score: row.score,
        reviewedAt: row.reviewedAt,
        evidenceSha256: row.evidenceSha256,
      })
      trainingItems.push({
        id: `training-${Number(row.id)}`,
        kind: 'training',
        title: `训练实习成绩 ${Number(row.score)} 分`,
        actor: normalizePublicDisplayName(String(row.publicDisplayName)),
        status: String(row.status),
        occurredAt: row.reviewedAt instanceof Date ? row.reviewedAt.toISOString() : String(row.reviewedAt),
        evidenceSha256: String(row.evidenceSha256),
      })
    } catch { skippedInvalidTraining += 1 }
  }
  const items = [...jobItems, ...trainingItems].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, bounded)
  return { items, feedVersion: marketLiveFeedVersion(items), serverTime: new Date().toISOString(), source: 'mysql' as const, skippedInvalidTraining, skippedInvalidJobs }
}

export const agentMarketLiveRouter = createRouter({
  feed: publicQuery.input(z.object({ limit: z.number().int().min(1).max(FEED_LIMIT).optional() }).optional()).query(async ({ input }) => {
    return readAgentMarketLiveFeed(getDb(), input?.limit ?? 30)
  }),
  setShowcase: publicQuery.input(z.object({ token: z.string().trim().min(1), registrationId: z.number().int().positive(), enabled: z.boolean(), publicDisplayName: z.string().trim().max(80).optional() })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token)
    const uid = Number(session.user.id)
    const db = getDb()
    await assertAgentEmploymentSchemaReady(db)
    await db.transaction(async (tx) => {
      const registration = rawRows(await tx.execute(sql`SELECT owner_user_id AS ownerUserId, status, showcase_opt_in AS showcaseOptIn, public_display_name AS publicDisplayName FROM st_agent_registrations WHERE id=${input.registrationId} FOR UPDATE`))[0]
      if (!registration || Number(registration.ownerUserId) !== uid) throw new TRPCError({ code: 'NOT_FOUND', message: '报名记录不存在或不属于你' })
      if (input.enabled && registration.status !== 'qualified') throw new TRPCError({ code: 'FORBIDDEN', message: '只有训练达标后才能公开实习成绩' })
      const publicDisplayName = input.enabled ? normalizePublicDisplayName(input.publicDisplayName) : null
      const previousOptIn = Number(registration.showcaseOptIn) === 1
      const changed = previousOptIn !== input.enabled || (input.enabled && String(registration.publicDisplayName ?? '') !== String(publicDisplayName ?? ''))
      if (!changed) return
      await tx.execute(sql`INSERT INTO st_agent_showcase_visibility_audit (registration_id, owner_user_id, from_opt_in, to_opt_in, public_display_name) VALUES (${input.registrationId}, ${uid}, ${previousOptIn ? 1 : 0}, ${input.enabled ? 1 : 0}, ${publicDisplayName})`)
      await tx.execute(sql`UPDATE st_agent_registrations SET showcase_opt_in=${input.enabled ? 1 : 0}, public_display_name=${publicDisplayName} WHERE id=${input.registrationId} AND owner_user_id=${uid}`)
    })
    invalidateAgentMarketLiveFeedCache()
    return { ok: true as const, showcaseOptIn: input.enabled }
  }),
})
