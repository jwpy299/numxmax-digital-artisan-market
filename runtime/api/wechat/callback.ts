/**
 * api/wechat/callback —— 微信公众号/服务号服务器回调（公开接口，不走 tRPC）。
 *
 * 在 api/boot.ts 中于 `app.all("/api/*")` 之前注册：
 *   import { registerWechatCallback } from "./wechat/callback";
 *   registerWechatCallback(app);
 *
 * - GET  /api/wechat/callback：微信服务器验证。将 [token, timestamp, nonce] 字典序拼接 sha1
 *   与 signature 比对，一致原样返回 echostr（text/plain）；不一致 401「签名校验失败」；
 *   token 从 st_wechat_config（id=1）读取，未配置 → 503「客服未配置」。
 * - POST /api/wechat/callback：解析 XML 消息（正则提取，不引依赖，仅支持文本消息）。
 *   MsgType=text → answerWithKb 应答（与配置页测试窗同一逻辑），返回被动回复 XML（4.5s 内）；
 *   MsgType=event 且 Event=subscribe → 返回欢迎语；其他一律返回 "success"。
 *
 * 安全口径：公开接口，除签名校验外不泄露任何内部信息；任何异常一律返回
 * "success" 或友好文案，绝不暴露堆栈；token/密钥不写日志。
 */
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { answerWithKb, readWechatConfig, DEFAULT_WELCOME } from "../routers/wechat";

/** sha1 hex（node crypto） */
function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 微信服务器签名校验：[token, timestamp, nonce] 字典序拼接 sha1 */
export function verifyWechatSignature(
  token: string,
  timestamp: string,
  nonce: string,
  signature: string,
): boolean {
  const digest = sha1([token, timestamp, nonce].sort().join(""));
  return digest === signature;
}

/**
 * 正则提取 XML 字段（支持 CDATA 与普通文本；仅用于微信文本消息，不引 XML 依赖）。
 * 返回解码后的字符串；字段不存在返回空串。
 */
export function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`);
  const m = xml.match(re);
  if (!m) return "";
  return (m[1] ?? m[2] ?? "").trim();
}

/** CDATA 包裹（内容含 "]]>" 时切分，避免注出） */
function cdata(text: string): string {
  return `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** 构造微信被动回复文本 XML */
export function buildTextReplyXml(toUser: string, fromUser: string, content: string): string {
  return [
    "<xml>",
    `<ToUserName>${cdata(toUser)}</ToUserName>`,
    `<FromUserName>${cdata(fromUser)}</FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    `<MsgType>${cdata("text")}</MsgType>`,
    `<Content>${cdata(content)}</Content>`,
    "</xml>",
  ].join("");
}

const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8" };

export function registerWechatCallback(app: Hono<{ Bindings: HttpBindings }>) {
  // ─── GET：微信服务器验证 ───────────────────────────────────────────────────
  app.get("/api/wechat/callback", async (c) => {
    const signature = c.req.query("signature") ?? "";
    const timestamp = c.req.query("timestamp") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const echostr = c.req.query("echostr") ?? "";

    const cfg = await readWechatConfig();
    if (!cfg || !cfg.token) {
      return c.text("客服未配置", 503);
    }
    if (!verifyWechatSignature(cfg.token, timestamp, nonce, signature)) {
      return c.text("签名校验失败", 401);
    }
    return c.text(echostr, 200);
  });

  // ─── POST：消息接收（仅支持文本消息与关注事件）─────────────────────────────
  app.post("/api/wechat/callback", async (c) => {
    try {
      const xml = await c.req.text();
      const toUser = extractXmlTag(xml, "ToUserName");
      const fromUser = extractXmlTag(xml, "FromUserName");
      const msgType = extractXmlTag(xml, "MsgType");

      if (msgType === "text") {
        const content = extractXmlTag(xml, "Content");
        if (!content) return c.text("success", 200);
        // 微信被动回复需在 5 秒内返回：LLM 超时收紧到 4.5s，超时/故障自动降级友好话术
        const res = await answerWithKb(content, [], 4_500);
        return new Response(buildTextReplyXml(fromUser, toUser, res.reply), {
          status: 200,
          headers: XML_HEADERS,
        });
      }

      if (msgType === "event" && extractXmlTag(xml, "Event") === "subscribe") {
        const cfg = await readWechatConfig();
        const welcome =
          cfg?.welcome ||
          DEFAULT_WELCOME;
        return new Response(buildTextReplyXml(fromUser, toUser, welcome), {
          status: 200,
          headers: XML_HEADERS,
        });
      }

      // 其他消息类型（图片/语音/事件等）：确认接收，不作回复
      return c.text("success", 200);
    } catch {
      // 公开接口：任何异常一律返回 success，绝不暴露堆栈/内部信息
      return c.text("success", 200);
    }
  });
}
