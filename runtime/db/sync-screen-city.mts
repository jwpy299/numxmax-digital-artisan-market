/**
 * sync-screen-city：人机共生大屏城市归属（2026-08-29 彭总令：佛山/肇庆先行）。
 * wb_factories.city / wb_users.city：NULL=待点亮（未归属）。
 * 自动归属口径：名称含「佛山」→ foshan，含「肇庆」→ zhaoqing；灵智枢生态系默认佛山（总部）。
 * 其余保持 NULL 如实待点亮——绝不编造归属。additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

for (const table of ["wb_factories", "wb_users"]) {
  const [cols] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE 'city'`);
  if ((cols as unknown[]).length > 0) console.log(`${table}.city: already`);
  else {
    await conn.query(
      `ALTER TABLE ${table} ADD COLUMN city VARCHAR(16) NULL DEFAULT NULL COMMENT '城市归属：foshan/zhaoqing/NULL待点亮'`,
    );
    console.log(`${table}.city: added`);
  }
}

// 名称自动归属（只动 NULL 的，幂等）——v171 扩广东 21 地级市
const GD_CITIES: [string, string][] = [
  ["guangzhou", "广州"], ["shenzhen", "深圳"], ["zhuhai", "珠海"], ["shantou", "汕头"],
  ["foshan", "佛山"], ["shaoguan", "韶关"], ["zhanjiang", "湛江"], ["zhaoqing", "肇庆"],
  ["jiangmen", "江门"], ["maoming", "茂名"], ["huizhou", "惠州"], ["meizhou", "梅州"],
  ["shanwei", "汕尾"], ["heyuan", "河源"], ["yangjiang", "阳江"], ["qingyuan", "清远"],
  ["dongguan", "东莞"], ["zhongshan", "中山"], ["chaozhou", "潮州"], ["jieyang", "揭阳"], ["yunfu", "云浮"],
];
for (const [code, cn] of GD_CITIES) {
  await conn.query(`UPDATE wb_factories SET city=? WHERE city IS NULL AND enterpriseName LIKE ?`, [code, `%${cn}%`]);
  // 个人用户不按名称猜属地（昵称不可信）——用户城市只认注册通道 v170 自报口径
}
// 灵智枢生态系（公司主体在佛山）默认佛山
await conn.query(`UPDATE wb_factories SET city='foshan' WHERE city IS NULL AND (enterpriseName LIKE '%灵智枢%' OR enterpriseName LIKE '%灵枢%')`);

const [fs] = await conn.query(`SELECT COUNT(*) c FROM wb_factories WHERE city='foshan'`);
const [zq] = await conn.query(`SELECT COUNT(*) c FROM wb_factories WHERE city='zhaoqing'`);
const [un] = await conn.query(`SELECT COUNT(*) c FROM wb_factories WHERE city IS NULL`);
console.log(`wb_factories: 佛山 ${(fs as { c: number }[])[0].c} / 肇庆 ${(zq as { c: number }[])[0].c} / 待点亮 ${(un as { c: number }[])[0].c}`);
await conn.end();
