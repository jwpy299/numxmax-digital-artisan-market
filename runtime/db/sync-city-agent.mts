/**
 * sync-city-agent：城市智能运行时第一块龙骨（2026-08-29 彭总令「干」）。
 * st_city_agents：城市运营官实体表——每城一名运营官，有编制、有 KPI、有状态。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_city_agents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  city VARCHAR(16) NOT NULL UNIQUE COMMENT '城市码（foshan/zhaoqing/...）',
  officer_name VARCHAR(32) NOT NULL COMMENT '运营官名（如 佛枢/肇星）',
  kpi_json JSON NULL COMMENT 'KPI 快照（点亮数/交付/活跃）',
  state VARCHAR(16) NOT NULL DEFAULT 'on_duty' COMMENT 'on_duty在岗/observing观察/standby待命',
  last_beat_at DATETIME NULL COMMENT '上次节拍',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='城市运营官（城市智能运行时实体）'`);

// v172b 广东 21 城全编制（运营官名为确定性人设，一城一官）
const OFFICERS: [string, string][] = [
  ["guangzhou", "穗枢"], ["shenzhen", "深澜"], ["zhuhai", "珠岫"], ["shantou", "汕明"],
  ["foshan", "佛枢"], ["shaoguan", "韶衡"], ["zhanjiang", "湛澜"], ["zhaoqing", "肇星"],
  ["jiangmen", "江笙"], ["maoming", "茂策"], ["huizhou", "惠熙"], ["meizhou", "梅笙"],
  ["shanwei", "尾澄"], ["heyuan", "源澈"], ["yangjiang", "阳汐"], ["qingyuan", "清霁"],
  ["dongguan", "莞铖"], ["zhongshan", "中桓"], ["chaozhou", "潮音"], ["jieyang", "揭钧"], ["yunfu", "云玕"],
];
for (const [city, name] of OFFICERS) {
  await conn.query(
    `INSERT INTO st_city_agents (city, officer_name, state) VALUES (?, ?, 'on_duty')
     ON DUPLICATE KEY UPDATE officer_name=VALUES(officer_name)`,
    [city, name],
  );
}
console.log("st_city_agents: ready（21 城运营官全编制）");
await conn.end();
