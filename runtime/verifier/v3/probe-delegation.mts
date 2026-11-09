import {getDb} from '../../api/queries/connection.ts'
import {sql} from 'drizzle-orm'
import {randomBytes} from 'node:crypto'
try {
  await getDb().execute(sql`INSERT INTO st_agent_runtime_delegations (role_id,claim_id,owner_user_id,factory_id,token_hash,token_ciphertext,scope,expires_at,revoked_at) VALUES (7,7,7811688,420001,${randomBytes(32).toString('hex')},'x','submitTask',DATE_ADD(NOW(),INTERVAL 2 HOUR),NULL) ON DUPLICATE KEY UPDATE claim_id=VALUES(claim_id),owner_user_id=VALUES(owner_user_id),factory_id=VALUES(factory_id),token_hash=VALUES(token_hash),token_ciphertext=VALUES(token_ciphertext),scope='submitTask',expires_at=VALUES(expires_at),revoked_at=NULL`)
  console.log('ok')
} catch (error) {
  console.log('error',error instanceof Error ? error.message : String(error), error?.cause?.message ?? '')
}
process.exit(0)
