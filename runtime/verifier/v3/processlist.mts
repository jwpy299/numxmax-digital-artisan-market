import {getDb} from '../../api/queries/connection.ts'
import {sql} from 'drizzle-orm'
import {rawRows} from '../../api/queries/rawRows.ts'
const rows=rawRows(await getDb().execute(sql`SELECT ID,USER,HOST,DB,COMMAND,TIME,STATE,LEFT(INFO,160) AS info FROM information_schema.PROCESSLIST WHERE DB LIKE 'numx_agent_employment_test%'`))
console.log(JSON.stringify(rows,null,2))
process.exit(0)
