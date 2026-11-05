/**
 * sync-voice-pref：用户音色偏好列（2026-08-29，音色包拍板后落地）。
 * wb_users.voice_pref：VOICE_REGISTRY 键（lingshu/xingyun/lingshu_yue/lingshu_ba/lingshu_dj/xingyun_yue/xingyun_warm），NULL=默认。
 * additive 幂等。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

const [cols] = await conn.query(`SHOW COLUMNS FROM wb_users LIKE 'voice_pref'`);
if ((cols as unknown[]).length > 0) console.log("wb_users.voice_pref: already");
else {
  await conn.query(
    `ALTER TABLE wb_users ADD COLUMN voice_pref VARCHAR(24) NULL DEFAULT NULL COMMENT '音色偏好（VOICE_REGISTRY 键）' AFTER gender`,
  );
  console.log("wb_users.voice_pref: added");
}
await conn.end();
