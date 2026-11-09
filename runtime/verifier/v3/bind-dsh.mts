import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../../api/queries/connection'
import { bindRuntimeIdentity } from '../../api/runtimeContainer/service'
import { authTokenHash } from '../../api/auth/revocation'
import { rawRows } from '../../api/queries/rawRows'
const fixture=JSON.parse(readFileSync('/opt/rebuild/verification-evidence/runtime-container/browser-fixture.json','utf8'))
const db=getDb()
const owner=rawRows(await db.execute(sql`SELECT id FROM wb_users WHERE authToken=${authTokenHash(fixture.creatorToken)} LIMIT 1`))[0].id
const inserted=await db.execute(sql`INSERT INTO st_agent_registrations (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at) VALUES (${`AR_${randomBytes(8).toString('hex')}`}, ${`agent_${randomBytes(10).toString('hex')}`}, ${owner}, 'DSH 真实竞岗 Agent', 'qualified', 'refunded', 1, ${`dsh-${randomBytes(8).toString('hex')}`}, NOW())`)
const registrationId=Number((Array.isArray(inserted)?inserted[0]:inserted as {insertId?:number})?.insertId??0)
await db.execute(sql`INSERT INTO st_agent_payment_orders (order_no, registration_id, owner_user_id, kind, attempt_no, amount_cents, amount_job_tokens, environment, status, idempotency_key, paid_at) VALUES (${`AO_${randomBytes(8).toString('hex')}`}, ${registrationId}, ${owner}, 'registration', 1, 9900, 990, 'sandbox', 'refunded', ${`dsh-order-${randomBytes(8).toString('hex')}`}, NOW())`)
await bindRuntimeIdentity({token:fixture.creatorToken,departmentId:'dept-a',runtime:'dsh',registrationId})
console.log(JSON.stringify({ok:true,registrationId,runtime:'dsh'}))
process.exit(0)
