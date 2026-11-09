import {getDb} from '../../api/queries/connection.ts'
import {sql} from 'drizzle-orm'
import {rawRows} from '../../api/queries/rawRows.ts'
const rows=rawRows(await getDb().execute(sql`SHOW ENGINE INNODB STATUS`))
console.log(JSON.stringify(rows).slice(-30000))
process.exit(0)
