import { beforeEach, describe, expect, it } from "vitest";
import { withAgentTokenWalletTx } from "./agentTokenWallet";
import { AGENT_TOKEN_BALANCE_MAX } from "../../contracts/agentEmploymentRules";

function sqlTextOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter((chunk) => (chunk as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((chunk) => { const value = (chunk as { value?: unknown }).value; return Array.isArray(value) ? value.join("") : String(value ?? ""); }).join("");
}
function sqlParamsOf(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const out: unknown[] = [];
  const walk = (chunk: unknown): void => {
    const rec = chunk as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
    if (rec?.constructor?.name === "StringChunk") return;
    if (rec && Array.isArray(rec.queryChunks)) { for (const child of rec.queryChunks) walk(child); return; }
    if (rec && typeof rec === "object" && "value" in rec) out.push(rec.value);
    else out.push(chunk);
  };
  for (const chunk of chunks) walk(chunk);
  return out;
}

const wallets = new Map<string, { balance: number; registrationId: number | null; ownerType: string }>();
const flows: Record<string, unknown>[] = [];
const db = {
  transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  execute: async (query: unknown) => {
    const text = sqlTextOf(query).replace(/\s+/g, " ").trim();
    const params = sqlParamsOf(query);
    if (text.startsWith("INSERT INTO st_agent_token_wallets")) {
      const [key, registrationId, ownerType] = params as [string, number | null, string];
      if (!wallets.has(key)) wallets.set(key, { balance: 0, registrationId, ownerType });
      return [{ insertId: 1, affectedRows: 1 }];
    }
    if (text.startsWith("UPDATE st_agent_token_wallets SET balance_job_tokens=balance_job_tokens-")) {
      const [amount, key, minimum] = params as [number, string, number];
      const wallet = wallets.get(key);
      if (!wallet || wallet.balance < Number(minimum)) return [{ affectedRows: 0 }];
      wallet.balance -= Number(amount);
      return [{ affectedRows: 1 }];
    }
    if (text.startsWith("UPDATE st_agent_token_wallets SET balance_job_tokens=balance_job_tokens+")) {
      const [amount, key] = params as [number, string];
      const wallet = wallets.get(key);
      if (!wallet) return [{ affectedRows: 0 }];
      wallet.balance += Number(amount);
      return [{ affectedRows: 1 }];
    }
    if (text.includes("SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE registration_id=")) {
      const wallet = [...wallets.values()].find((item) => item.registrationId === Number(params[0]));
      return [wallet ? [{ balance: wallet.balance }] : []];
    }
    if (text.includes("SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE wallet_key=")) {
      const wallet = wallets.get(String(params[0]));
      return [wallet ? [{ balance: wallet.balance }] : []];
    }
    if (text.startsWith("INSERT INTO st_wallet_flows")) {
      flows.push({ params });
      return [{ insertId: flows.length, affectedRows: 1 }];
    }
    throw new Error(`unexpected_sql:${text}`);
  },
};

function change(amount: number, direction: "in" | "out" = "in", bizType = "test_wallet") {
  return { amount, direction, bizType, refId: "test-ref", note: "测试钱包流水" };
}

beforeEach(() => { wallets.clear(); flows.length = 0; });

describe("Agent job_token 钱包原语", () => {
  it("拒绝零、负数和非整数，且不得触碰钱包", async () => {
    for (const amount of [0, -1, 1.5]) {
      await expect(withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.changeAgentTokenWallet(7, change(amount, "out")))).rejects.toThrow(/大于零的整数/);
    }
    expect(wallets.size).toBe(0);
  });

  it("Agent 与平台余额不足分别失败关闭，不透支", async () => {
    wallets.set("agent:7", { balance: 5, registrationId: 7, ownerType: "agent" });
    wallets.set("platform", { balance: 0, registrationId: null, ownerType: "platform" });
    await expect(withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.changeAgentTokenWallet(7, change(10, "out")))).rejects.toThrow(/Agent job_token 余额不足/);
    await expect(withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.changePlatformTokenWallet(change(1, "out")))).rejects.toThrow(/平台 job_token 余额不足/);
    expect(wallets.get("agent:7")?.balance).toBe(5);
    expect(wallets.get("platform")?.balance).toBe(0);
  });

  it("使用统一 wallet_key 创建 Agent 与平台钱包并写入 canonical 流水", async () => {
    const agentBalance = await withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.changeAgentTokenWallet(7, change(10, "in", "exchange")));
    const platformBalance = await withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.changePlatformTokenWallet(change(20, "in")));
    expect(agentBalance).toBe(10);
    expect(platformBalance).toBe(20);
    expect([...wallets.keys()].sort()).toEqual(["agent:7", "platform"]);
    expect(flows).toHaveLength(2);
  });

  it("用户兑换受余额上限约束，系统退款和工资仍可入账", async () => {
    wallets.set("agent:7", { balance: AGENT_TOKEN_BALANCE_MAX, registrationId: 7, ownerType: "agent" });
    await expect(withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.changeAgentTokenWallet(7, change(1, "in")))).rejects.toThrow(/上限/);
    const balance = await withAgentTokenWalletTx(db as never, async (_tx, wallet) => wallet.creditSystemAgentTokenWallet(7, { ...change(1, "in", "agent_future_system_credit"), direction: "in" }));
    expect(balance).toBe(AGENT_TOKEN_BALANCE_MAX + 1);
  });
});
