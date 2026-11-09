import {getDb} from '../../api/queries/connection.ts'
import {sql} from 'drizzle-orm'
import {rawRows} from '../../api/queries/rawRows.ts'
const waits=rawRows(await getDb().execute(sql`SELECT ENGINE,ENGINE_LOCK_ID,ENGINE_TRANSACTION_ID,THREAD_ID,OBJECT_SCHEMA,OBJECT_NAME,INDEX_NAME,LOCK_TYPE,LOCK_MODE,LOCK_STATUS FROM performance_schema.data_lock_waits LIMIT 50`))
const locks=rawRows(await getDb().execute(sql`SELECT ENGINE,ENGINE_LOCK_ID,ENGINE_TRANSACTION_ID,THREAD_ID,OBJECT_SCHEMA,OBJECT_NAME,INDEX_NAME,LOCK_TYPE,LOCK_MODE,LOCK_STATUS FROM performance_schema.data_locks WHERE OBJECT_SCHEMA LIKE 'numx_agent_employment_test%' LIMIT 100`))
console.log(JSON.stringify({waits,locks},null,2))
process.exit(0)
