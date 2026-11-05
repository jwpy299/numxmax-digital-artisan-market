/**
 * edgeNode —— 精灵→桌面端控制链路（彭总 2026-09-03：个人工作台=电脑桌面的边缘节点）。
 *
 * 云-边指令通道：
 * - 边缘节点注册/心跳（register/heartbeat）：开机上线报"我在"，能力清单上报；
 *   离线判定：90s 无心跳 → offline（指令照攒，上线补领）
 * - 指令队列（issue/poll/ack）：精灵意图 → st_edge_commands 状态机
 *   pending → claimed（节点领到）→ done/failed（回执）
 * - 安全分级：B 级读操作直排；B+ 写操作需 APP 确认；C 级一律双签票据（复用 devices 闸口，
 *   本路由不放行 C 级——只回"去超终签"，与 deviceMcp 同构不另立规矩）
 * - 一切动作落审计（指令含 issuedBy 用户身份 + 全文留档，桌面端执行回执也留档）
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";

async function ensureEdgeTables(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS st_edge_nodes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      node_key VARCHAR(40) NOT NULL,
      owner_user_id BIGINT UNSIGNED NOT NULL,
      factory_id BIGINT UNSIGNED NOT NULL,
      hostname VARCHAR(128) NOT NULL,
      capabilities TEXT,
      status VARCHAR(12) NOT NULL DEFAULT 'online',
      last_heartbeat DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_node_key (node_key),
      KEY idx_owner (owner_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS st_edge_commands (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      node_id BIGINT UNSIGNED NOT NULL,
      issued_by BIGINT UNSIGNED NOT NULL,
      action VARCHAR(32) NOT NULL,
      payload TEXT,
      level VARCHAR(4) NOT NULL DEFAULT 'B',
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimed_at DATETIME NULL,
      done_at DATETIME NULL,
      KEY idx_node_status (node_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/** 动作分级白名单（B=读/直排 B+=写/需确认；其余一律视作 C 拒绝直排） */
const ACTION_LEVELS: Record<string, "B" | "B+" | "C"> = {
  list_files: "B", read_file: "B", find_file: "B", screenshot: "B", app_status: "B",
  organize_desktop: "B+", open_app: "B+", create_doc: "B+",
  send_file: "C", delete_file: "C", shell_exec: "C",
};

export const edgeNodeRouter = createRouter({
  /** register（mutation）：边缘节点注册/刷新（桌面端开机调用） */
  register: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      nodeKey: z.string().trim().min(6).max(40),
      hostname: z.string().trim().min(1).max(128),
      capabilities: z.array(z.string().max(32)).max(30).default([]),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      await ensureEdgeTables();
      await getDb().execute(
        sql`INSERT INTO st_edge_nodes (node_key, owner_user_id, factory_id, hostname, capabilities, status, last_heartbeat)
            VALUES (${input.nodeKey}, ${session.user.id}, ${session.factory.id}, ${input.hostname}, ${JSON.stringify(input.capabilities)}, 'online', NOW())
            ON DUPLICATE KEY UPDATE hostname=VALUES(hostname), capabilities=VALUES(capabilities), status='online', last_heartbeat=NOW()`,
      );
      return { ok: true as const };
    }),

  /** heartbeat（mutation）：心跳 + 顺便领指令（边缘节点 30s 一次） */
  heartbeat: publicQuery
    .input(z.object({ token: z.string().trim().min(1), nodeKey: z.string().trim().min(6).max(40) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      await db.execute(
        sql`UPDATE st_edge_nodes SET last_heartbeat=NOW(), status='online'
            WHERE node_key=${input.nodeKey} AND owner_user_id=${session.user.id}`,
      );
      const nodes = rawRows(
        await db.execute(
          sql`SELECT id FROM st_edge_nodes WHERE node_key=${input.nodeKey} AND owner_user_id=${session.user.id} LIMIT 1`,
        ),
      ) as unknown as { id: number }[];
      const nodeId = nodes[0]?.id ?? 0;
      if (!nodeId) throw new TRPCError({ code: "NOT_FOUND", message: "节点未注册" });
      // 领指令（两步：先读 pending 快照，再按 id 集标记 claimed——MySQL 无 RETURNING，读标记分离）
      const pendRows = rawRows(
        await db.execute(
          sql`SELECT id, action, payload, level FROM st_edge_commands
              WHERE node_id=${nodeId} AND status='pending' ORDER BY id ASC LIMIT 10`,
        ),
      ) as unknown as { id: number; action: string; payload: string; level: string }[];
      if (pendRows.length > 0) {
        const ids = pendRows.map((r) => r.id);
        await db.execute(
          sql`UPDATE st_edge_commands SET status='claimed', claimed_at=NOW()
              WHERE node_id=${nodeId} AND status='pending' AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
        );
      }
      return { ok: true as const, commands: pendRows };
    }),

  /** issue（mutation）：精灵/工作台下发指令（B 直排，B+ 标确认，C 拒绝并指引双签） */
  issue: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      nodeKey: z.string().trim().min(6).max(40),
      action: z.string().trim().min(1).max(32),
      payload: z.any().optional(),
      confirmed: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const level = ACTION_LEVELS[input.action] ?? "C";
      if (level === "C") {
        throw new TRPCError({ code: "FORBIDDEN", message: "该动作属 C 级，需超级终端双签票据——精灵会引导你去签" });
      }
      if (level === "B+" && !input.confirmed) {
        return { ok: false as const, needsConfirm: true as const, level };
      }
      const nodes = rawRows(
        await db.execute(
          sql`SELECT id, status FROM st_edge_nodes WHERE node_key=${input.nodeKey} AND owner_user_id=${session.user.id} LIMIT 1`,
        ),
      ) as unknown as { id: number; status: string }[];
      const node = nodes[0];
      if (!node) throw new TRPCError({ code: "NOT_FOUND", message: "这台电脑的工作台边缘节点还没上线" });
      const ins = await db.execute(
        sql`INSERT INTO st_edge_commands (node_id, issued_by, action, payload, level, status)
            VALUES (${node.id}, ${session.user.id}, ${input.action}, ${JSON.stringify(input.payload ?? {})}, ${level}, 'pending')`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      const commandId = Number((first as { insertId?: number })?.insertId ?? 0);
      return {
        ok: true as const,
        commandId,
        nodeStatus: node.status, // offline 时调用方提示"电脑离线，指令已攒着"
      };
    }),

  /** ack（mutation）：边缘节点回执（done/failed + 结果） */
  ack: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      commandId: z.number().int().positive(),
      ok: z.boolean(),
      result: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      await getDb().execute(
        sql`UPDATE st_edge_commands SET status=${input.ok ? "done" : "failed"}, result=${input.result ?? null}, done_at=NOW()
            WHERE id=${input.commandId} AND issued_by=${session.user.id} AND status='claimed'`,
      );
      return { ok: true as const };
    }),

  /** myNodes（query）：我的边缘节点（在线状态） */
  myNodes: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      await ensureEdgeTables();
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT node_key AS nodeKey, hostname, capabilities, status, last_heartbeat AS lastHeartbeat
              FROM st_edge_nodes WHERE owner_user_id=${session.user.id} ORDER BY id DESC LIMIT 10`,
        ),
      );
      return { nodes: rows };
    }),
});
