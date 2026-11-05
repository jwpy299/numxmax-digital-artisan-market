import mysql from "mysql2/promise";
const c = await mysql.createConnection(process.env.DATABASE_URL!);
const [t1] = await c.query<any[]>("SHOW TABLES LIKE 'wb_users'");
const [t2] = await c.query<any[]>("SHOW TABLES LIKE 'wb_devices'");
console.log("wb_users:", (t1 as any[]).length, "wb_devices:", (t2 as any[]).length);
const [u] = await c.query<any[]>("SELECT COUNT(*) AS n FROM wb_users WHERE authToken='bad'");
console.log("bad-token rows:", (u as any[])[0].n);
await c.end();
