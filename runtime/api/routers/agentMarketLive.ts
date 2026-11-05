import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { createRouter, publicQuery } from '../middleware'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { sessionMe } from './wbSession'
import { assertTrainingOutcomeVisible, marketLiveFeedVersion } from '../lib/agentMarketLiveAccess'
import { normalizePublicDisplayName } from '../lib/agentMarketPublic'

const FEED_LIMIT = 50
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
  const jobs = rawRows(await db.execute(sql`
    SELECT t.id, t.title, t.status, t.created_at AS createdAt, t.public_actor_name AS publicActorName
    FROM st_agent_work_tasks t
    WHERE t.public_feed=1 AND t.public_actor_name IS NOT NULL AND CHAR_LENGTH(t.public_actor_name)>=2
      AND t.status IN ('open','claimed','submitted') AND (t.deadline_at IS NULL OR t.deadline_at>NOW())
    ORDER BY t.created_at DESC, t.id DESC LIMIT ${bounded}`))
  const jobItems: AgentMarketLiveItem[] = jobs.map((row) => ({
    id: `job-${Number(row.id)}`,
    kind: 'job',
    title: String(row.title),
    actor: String(row.publicActorName),
    status: String(row.status),
    occurredAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    evidenceSha256: null,
  }))
  const training = rawRows(await db.execute(sql`
    SELECT c.id, c.score, c.status, c.reviewed_at AS reviewedAt, r.agent_name AS agentName,
           r.showcase_opt_in AS showcaseOptIn,
           (SELECT t.evidence_sha256 FROM st_agent_training_tasks t
            WHERE t.cycle_id=c.id AND t.evidence_sha256 IS NOT NULL
            ORDER BY t.day_no DESC LIMIT 1) AS evidenceSha256
    FROM st_agent_training_cycles c
    JOIN st_agent_registrations r ON r.id=c.registration_id
    WHERE c.status IN ('passed','failed') AND c.score IS NOT NULL AND c.reviewed_at IS NOT NULL
      AND r.showcase_opt_in=1
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
      actor: normalizePublicDisplayName(String(row.agentName)),
      status: String(row.status),
      occurredAt: row.reviewedAt instanceof Date ? row.reviewedAt.toISOString() : String(row.reviewedAt),
      evidenceSha256: String(row.evidenceSha256),
    })
    } catch { skippedInvalidTraining += 1 }
  }
  const items = [...jobItems, ...trainingItems].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, bounded)
  return { items, feedVersion: marketLiveFeedVersion(items), serverTime: new Date().toISOString(), source: 'mysql' as const, skippedInvalidTraining }
}

export const agentMarketLiveRouter = createRouter({
  feed: publicQuery.input(z.object({ limit: z.number().int().min(1).max(FEED_LIMIT).optional() }).optional()).query(async ({ input }) => {
    return readAgentMarketLiveFeed(getDb(), input?.limit ?? 30)
  }),
  setShowcase: publicQuery.input(z.object({ token: z.string().trim().min(1), registrationId: z.number().int().positive(), enabled: z.boolean() })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token)
    const uid = Number(session.user.id)
    const db = getDb()
    const registration = rawRows(await db.execute(sql`SELECT owner_user_id AS ownerUserId, status FROM st_agent_registrations WHERE id=${input.registrationId} LIMIT 1`))[0]
    if (!registration || Number(registration.ownerUserId) !== uid) throw new Error('报名记录不存在或不属于你')
    if (registration.status !== 'qualified') throw new Error('只有训练达标后才能公开实习成绩')
    await db.execute(sql`UPDATE st_agent_registrations SET showcase_opt_in=${input.enabled ? 1 : 0} WHERE id=${input.registrationId} AND owner_user_id=${uid}`)
    return { ok: true as const, showcaseOptIn: input.enabled }
  }),
})
