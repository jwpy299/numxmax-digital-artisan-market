import { createClient } from './client.js';
import contract, { deepFreeze, limits } from './contract.js';
import { resolveToken } from './session.js';

const LIMITS = limits();
const IDEM_KEY_PATTERN = new RegExp(`^[a-zA-Z0-9-]{${LIMITS.idemKeyMinChars},${LIMITS.idemKeyChars}}$`);
export const PASSTHROUGH_OUTPUT = Object.freeze({
  schema: Object.freeze({
    oneOf: Object.freeze([
      Object.freeze({ type: 'object' }),
      Object.freeze({ type: 'array' }),
      Object.freeze({ type: 'null' }),
    ]),
  }),
  render: (_args, value) => value,
});

const MARKET_PROCEDURES = deepFreeze({ catalog: 'packages.list', entitlement: 'packages.myEntitlement' });

/** 工具执行与审批门共用同一张过程表，禁止两处字面量漂移。 */
export const TOOL_POLICIES = deepFreeze({
  workspace_list: { readOnly: true, procedure: 'orgPlugin.workspaces' },
  cabin_list: { readOnly: true, procedure: 'entCabin.map' },
  org_query: { readOnly: true, procedure: 'harnessProxy.tasks' },
  contacts_query: { readOnly: true, procedure: 'harnessProxy.employees' },
  org_write: { procedure: 'harnessProxy.delegate' },
  file_dispatch: { procedure: 'harnessProxy.dispatchFile' },
  cross_collab: {
    readOnly: (args) => args.action === 'list',
    procedure: (args) => {
      if (args.action === 'list') return 'harnessProxy.collabList';
      if (args.action === 'propose') return 'harnessProxy.collabPropose';
      return null;
    },
  },
  market_search: { readOnly: true, procedures: Object.values(MARKET_PROCEDURES) },
});

export function procedureForPolicy(policy, args = {}) {
  if (!policy) return null;
  if (typeof policy.procedure === 'function') return policy.procedure(args);
  return typeof policy.procedure === 'string' ? policy.procedure : null;
}

function deptParameters() {
  return {
    dept: { type: 'string', description: '部门舱码，可省略（admin 查看全厂）' },
    limit: { type: 'number', description: `返回条数，${LIMITS.queryLimitMin}-${LIMITS.queryLimitMax}，越界夹取` },
  };
}

async function client(exec, ctx) {
  return createClient({ apiBase: contract.network.endpoint, token: await resolveToken(exec?.agent?.id, ctx) });
}

export async function call(exec, procedure, input = {}, write = false, ctx) {
  const apiClient = await client(exec, ctx);
  return apiClient.postTrpc(procedure, input, write, exec?.signal);
}

export function requiredText(value, missingCode, maxLength, typeCode = 'org_plugin_input_type', tooLongCode = 'org_plugin_input_too_long') {
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('org_plugin_input_invalid_limit');
  if (value === undefined || value === null) throw new Error(missingCode);
  if (typeof value !== 'string') throw new Error(typeCode);
  const text = value.trim();
  if (!text) throw new Error(missingCode);
  if (text.length > maxLength) throw new Error(tooLongCode);
  return text;
}

export function idemKey(value, { missingCode = 'org_plugin_idem_required', invalidCode = 'org_plugin_idem_key_invalid', typeCode = 'org_plugin_input_type', tooLongCode = 'org_plugin_input_too_long' } = {}) {
  const text = requiredText(value, missingCode, LIMITS.idemKeyChars, typeCode, tooLongCode);
  if (!IDEM_KEY_PATTERN.test(text)) throw new Error(invalidCode);
  return text;
}

export function optionalText(value, maxLength, typeCode = 'org_plugin_input_type', tooLongCode = 'org_plugin_input_too_long') {
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('org_plugin_input_invalid_limit');
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(typeCode);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new Error(tooLongCode);
  return text;
}

export function argsOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function queryLimit(value, code = 'org_plugin_limit_invalid') {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(code);
  return Math.min(Math.max(Math.trunc(value), LIMITS.queryLimitMin), LIMITS.queryLimitMax);
}

export function wbFileUri(value, maxLength = LIMITS.fileUriChars, { invalidCode = 'org_plugin_file_uri_invalid', typeCode = 'org_plugin_input_type', tooLongCode = 'org_plugin_input_too_long' } = {}) {
  const text = optionalText(value, maxLength, typeCode, tooLongCode);
  if (text && !/^wbfile:\d+$/.test(text)) throw new Error(invalidCode);
  return text;
}

function deptInput(args = {}) {
  const output = {};
  const dept = optionalText(args.dept, LIMITS.deptChars);
  if (dept) output.dept = dept;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) throw new Error('org_plugin_limit_invalid');
    output.limit = queryLimit(args.limit);
  }
  return output;
}

/** 静态定义供审批策略校验/测试使用；生产执行必须经 createTools(ctx) 注入当前会话上下文。 */
export function createTools(ctx) {
  const toolList = [
  {
    name: 'workspace_list',
    output: PASSTHROUGH_OUTPUT,
    description: '列出当前账号可见工作区、逐舱角色、订阅权益与安装资格（员工免安装部门包）',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args = {}, exec) => call(exec, procedureForPolicy(TOOL_POLICIES.workspace_list), {}, false, ctx),
  },
  {
    name: 'cabin_list',
    output: PASSTHROUGH_OUTPUT,
    description: '列出当前账号可见的真实部门舱与映射状态',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args = {}, exec) => call(exec, procedureForPolicy(TOOL_POLICIES.cabin_list), {}, false, ctx),
  },
  {
    name: 'org_query',
    output: PASSTHROUGH_OUTPUT,
    description: '查询本部门真实任务数据',
    parameters: {
      type: 'object',
      properties: deptParameters(),
    },
    execute: async (args = {}, exec) => call(exec, procedureForPolicy(TOOL_POLICIES.org_query), deptInput(args), false, ctx),
  },
  {
    name: 'contacts_query',
    output: PASSTHROUGH_OUTPUT,
    description: '查询本部门数字员工与工位信息',
    parameters: {
      type: 'object',
      properties: deptParameters(),
    },
    execute: async (args = {}, exec) => call(exec, procedureForPolicy(TOOL_POLICIES.contacts_query), deptInput(args), false, ctx),
  },
  {
    name: 'org_write',
    output: PASSTHROUGH_OUTPUT,
    description: '经本人单次确认后，向部门主管提交真实主管编排任务',
    parameters: {
      type: 'object',
      properties: {
        dept: { type: 'string', description: '目标部门舱码' },
        task: { type: 'string', description: `真实任务内容，最长 ${LIMITS.taskChars} 字` },
        idemKey: { type: 'string', description: `${LIMITS.idemKeyMinChars}-${LIMITS.idemKeyChars} 位字母/数字/连字符幂等键` },
      },
      required: ['dept', 'task', 'idemKey'],
    },
    execute: async (args = {}, exec) => call(exec, procedureForPolicy(TOOL_POLICIES.org_write), {
      dept: requiredText(args.dept, 'org_plugin_dept_required', LIMITS.deptChars),
      task: requiredText(args.task, 'org_plugin_task_required', LIMITS.taskChars),
      idemKey: idemKey(args.idemKey),
    }, true, ctx),
  },
  {
    name: 'file_dispatch',
    output: PASSTHROUGH_OUTPUT,
    description: '经本人单次确认后，把本厂文件发送到指定部门与真实接收人',
    parameters: {
      type: 'object',
      properties: {
        toDept: { type: 'string', description: '目标部门舱码' },
        fileName: { type: 'string', description: '文件名' },
        toName: { type: 'string', description: '接收人姓名' },
        fileUri: { type: 'string', description: '可选 wbfile 附件 ID，格式 wbfile:<数字>' },
      },
      required: ['toDept', 'fileName', 'toName'],
    },
    execute: async (args = {}, exec) => {
      const fileUri = wbFileUri(args.fileUri);
      return call(exec, procedureForPolicy(TOOL_POLICIES.file_dispatch), {
        toDept: requiredText(args.toDept, 'org_plugin_dept_required', LIMITS.deptChars),
        fileName: requiredText(args.fileName, 'org_plugin_file_required', LIMITS.fileNameChars),
        toName: requiredText(args.toName, 'org_plugin_recipient_required', LIMITS.recipientChars),
        ...(fileUri ? { fileUri } : {}),
      }, true, ctx);
    },
  },
  {
    name: 'cross_collab',
    output: PASSTHROUGH_OUTPUT,
    description: '查询协同链，或经本人单次确认后发起限时、可撤销、可审计的跨企业协同',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'propose'], description: 'list=查询，propose=发起' },
        toFactoryId: { type: 'number', description: 'propose 时的目标企业 ID' },
        note: { type: 'string', description: `协同备注，最长 ${LIMITS.collabNoteChars} 字` },
      },
      required: ['action'],
    },
    execute: async (args = {}, exec) => {
      if (args.action === 'list') return call(exec, procedureForPolicy(TOOL_POLICIES.cross_collab, args), { limit: LIMITS.collabListLimit }, false, ctx);
      if (args.action === 'propose') {
        if (!Number.isInteger(args.toFactoryId) || args.toFactoryId <= 0) throw new Error('org_plugin_collab_factory_required');
        return call(exec, procedureForPolicy(TOOL_POLICIES.cross_collab, args), {
          toFactoryId: args.toFactoryId,
          note: optionalText(args.note, LIMITS.collabNoteChars) || '',
        }, true, ctx);
      }
      throw new Error('org_plugin_collab_action_invalid');
    },
  },
  {
    name: 'market_search',
    output: PASSTHROUGH_OUTPUT,
    description: '同时查询数字员工订阅包目录与本企业最新套餐权益（只读）',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async (_args = {}, exec) => {
      const [catalog, entitlement] = await Promise.all([
        call(exec, MARKET_PROCEDURES.catalog, {}, false, ctx),
        call(exec, MARKET_PROCEDURES.entitlement, {}, false, ctx),
      ]);
      return { catalog, entitlement };
    },
  },
  ];
  // DSH/直接调用即使传入 null 或异形参数，也只能得到稳定业务错误，不得泄漏原生 TypeError。
  return toolList.map((tool) => ({ ...tool, execute: (args, exec) => tool.execute(argsOf(args), exec) }));
}

// 静态定义仅供审批策略/参数校验，禁止在无宿主 ctx 时执行工具或落入 fallback 会话。
export const tools = createTools(null).map((tool) => {
  const { execute, ...metadata } = tool;
  return metadata;
});
