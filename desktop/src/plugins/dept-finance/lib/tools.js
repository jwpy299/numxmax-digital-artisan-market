import { argsOf, call, requiredText as orgRequiredText, optionalText as orgOptionalText, idemKey as orgIdemKey, queryLimit, wbFileUri, PASSTHROUGH_OUTPUT } from 'numx-org/lib/tools.js';
import { deepFreeze, limits } from 'numx-org/lib/contract.js';
import { FINANCE_DEPT, FINANCE_LEAD_STATION } from './manifest.js';

const LIMITS = limits();
const OUTPUT = PASSTHROUGH_OUTPUT;
const DELEGATION_STATUSES = new Set(['open', 'done', 'failed', 'blocked']);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected', 'signed']);
const NOTICE_STATUSES = new Set(['unread', 'read']);
const ITEM_TYPES = new Set(['doc', 'rpt', 'warn', 'plan', 'other']);
const DECISIONS = new Set(['approved', 'rejected', 'signed']);

function requiredText(value, code, maxLength) {
  return orgRequiredText(value, code, maxLength, 'dept_finance_input_type', 'dept_finance_input_too_long');
}
function optionalText(value, maxLength) {
  return orgOptionalText(value, maxLength, 'dept_finance_input_type', 'dept_finance_input_too_long');
}
function readLimit(args = {}) {
  return queryLimit(args.limit, 'dept_finance_limit_invalid');
}
function status(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.has(value.trim())) throw new Error('dept_finance_status_invalid');
  return value.trim();
}
function readTool(name, { extra, description, ...parameters }, ctx) {
  const policy = FINANCE_POLICIES[name];
  if (typeof policy?.procedure !== 'string') throw new Error(`dept_finance_manifest_procedure_missing:${name}`);
  const procedure = policy.procedure;
  if (typeof description !== 'string' || !description.trim()) throw new Error(`dept_finance_description_missing:${name}`);
  return { name, output: OUTPUT, description, parameters, execute: async (args = {}, exec) => {
    const limit = readLimit(args);
    return call(exec, procedure, { ...extra?.(args), dept: FINANCE_DEPT, ...(limit !== undefined ? { limit } : {}) }, false, ctx);
  } };

}
function idemKey(value) {
  return orgIdemKey(value, {
    missingCode: 'dept_finance_idem_required', invalidCode: 'dept_finance_idem_key_invalid',
    typeCode: 'dept_finance_input_type', tooLongCode: 'dept_finance_input_too_long',
  });
}
function wbfile(value) {
  return wbFileUri(value, LIMITS.payloadUriChars, {
    invalidCode: 'dept_finance_file_uri_invalid', typeCode: 'dept_finance_input_type', tooLongCode: 'dept_finance_input_too_long',
  });
}

export const FINANCE_POLICIES = deepFreeze({
  finance_tasks: { readOnly: true, procedure: 'harnessProxy.tasks' },
  finance_delegations: { readOnly: true, procedure: 'harnessProxy.delegations' },
  finance_employees: { readOnly: true, procedure: 'harnessProxy.employees' },
  finance_reviews: { readOnly: true, procedure: 'harnessProxy.reviews' },
  finance_notices: { readOnly: true, procedure: 'harnessProxy.notices' },
  finance_delegate: { procedure: 'harnessProxy.delegate' },
  finance_review_submit: { procedure: 'harnessProxy.reviewSubmit' },
  finance_review_decide: { procedure: 'harnessProxy.reviewDecide' },
  finance_notice_read: { procedure: 'harnessProxy.noticeRead' },
});

export function createTools(ctx) {
  const toolList = [
    readTool('finance_tasks', {
      description: '查询财务舱真实任务与工位负载（只读）',
      type: 'object', properties: { limit: { type: 'number', description: `返回条数，${LIMITS.queryLimitMin}-${LIMITS.queryLimitMax}，缺省走上游默认` } },
    }, ctx),
    readTool('finance_delegations', {
      description: '查询财务主管编排委派单，可按 open/done/failed/blocked 状态筛选（只读）',
      type: 'object',
      properties: { status: { type: 'string', enum: [...DELEGATION_STATUSES], description: '状态筛选，缺省不过滤' }, limit: { type: 'number', description: '返回条数，缺省走上游默认' } },
      extra: (args) => ({ status: status(args.status, DELEGATION_STATUSES, undefined) }),
    }, ctx),
    readTool('finance_employees', {
      description: '查询财务舱数字员工与工位状态（只读）',
      type: 'object', properties: { limit: { type: 'number', description: `返回条数，${LIMITS.queryLimitMin}-${LIMITS.queryLimitMax}，缺省走上游默认` } },
    }, ctx),
    readTool('finance_reviews', {
      description: '查询财务产出复核记录，默认仅看 pending（只读）',
      type: 'object',
      properties: { status: { type: 'string', enum: [...REVIEW_STATUSES], description: '状态筛选，缺省 pending' }, limit: { type: 'number', description: '返回条数，缺省走上游默认' } },
      extra: (args) => ({ status: status(args.status, REVIEW_STATUSES, 'pending') }),
    }, ctx),
    readTool('finance_notices', {
      description: '查询财务舱通知，默认仅看 unread（只读）',
      type: 'object',
      properties: { status: { type: 'string', enum: [...NOTICE_STATUSES], description: '状态筛选，缺省 unread' }, limit: { type: 'number', description: '返回条数，缺省走上游默认' } },
      extra: (args) => ({ status: status(args.status, NOTICE_STATUSES, 'unread') }),
    }, ctx),
    {
      name: 'finance_delegate',
      output: OUTPUT,
      description: '经本人单次确认后，向财务主管提交真实编排任务（必须提供幂等键）',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: `真实任务内容，最长 ${LIMITS.taskChars} 字` },
          idemKey: { type: 'string', description: `${LIMITS.idemKeyMinChars}-${LIMITS.idemKeyChars} 位字母/数字/连字符幂等键` },
          priority: { type: 'number', description: `1-${LIMITS.priorityMax} 的整数优先级` },
        },
        required: ['task', 'idemKey'],
      },
      execute: async (args = {}, exec) => {
        const priority = args.priority === undefined || args.priority === null ? undefined : args.priority;
        if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > LIMITS.priorityMax)) throw new Error('dept_finance_priority_invalid');
        return call(exec, FINANCE_POLICIES.finance_delegate.procedure, {
          dept: FINANCE_DEPT,
          task: requiredText(args.task, 'dept_finance_task_required', LIMITS.taskChars),
          idemKey: idemKey(args.idemKey),
          ...(priority !== undefined ? { priority } : {}),
        }, true, ctx);
      },
    },
    {
      name: 'finance_review_submit',
      output: OUTPUT,
      description: '经本人单次确认后，把财务产出提交为待复核记录',
      parameters: {
        type: 'object',
        properties: {
          itemType: { type: 'string', enum: [...ITEM_TYPES] },
          title: { type: 'string', description: `产出标题，最长 ${LIMITS.reviewTitleChars} 字` },
          summary: { type: 'string', description: `产出摘要，最长 ${LIMITS.reviewSummaryChars} 字` },
          payloadUri: { type: 'string', description: '可选 wbfile:<数字> 附件' },
          domain: { type: 'string', description: `可选业务域，最长 ${LIMITS.reviewDomainChars} 字` },
        },
        required: ['title'],
      },
      execute: async (args = {}, exec) => {
        const summary = optionalText(args.summary, LIMITS.reviewSummaryChars);
        const domain = optionalText(args.domain, LIMITS.reviewDomainChars);
        const payloadUri = wbfile(args.payloadUri);
        return call(exec, FINANCE_POLICIES.finance_review_submit.procedure, {
          dept: FINANCE_DEPT,
          stationKey: FINANCE_LEAD_STATION,
          itemType: status(args.itemType, ITEM_TYPES, 'other'),
          title: requiredText(args.title, 'dept_finance_title_required', LIMITS.reviewTitleChars),
          ...(summary !== undefined ? { summary } : {}),
          ...(payloadUri ? { payloadUri } : {}),
          ...(domain !== undefined ? { domain } : {}),
        }, true, ctx);
      },
    },
    {
      name: 'finance_review_decide',
      output: OUTPUT,
      description: '经本人单次确认后，对财务复核记录通过、打回或挂签；打回必须留意见',
      parameters: {
        type: 'object',
        properties: {
          reviewId: { type: 'string', description: '真实复核记录 ID' },
          decision: { type: 'string', enum: [...DECISIONS] },
          note: { type: 'string', description: `复核意见，打回必填，最长 ${LIMITS.reviewNoteChars} 字` },
        },
        required: ['reviewId', 'decision'],
      },
      execute: async (args = {}, exec) => {
        const reviewId = requiredText(args.reviewId, 'dept_finance_review_id_invalid', LIMITS.reviewIdChars);
        const rawDecision = typeof args.decision === 'string' ? args.decision.trim() : args.decision;
        if (rawDecision === undefined || rawDecision === null || rawDecision === '') throw new Error('dept_finance_decision_required');
        const decision = status(rawDecision, DECISIONS, undefined);
        const note = optionalText(args.note, LIMITS.reviewNoteChars);
        if (decision === 'rejected' && !note) throw new Error('dept_finance_reject_note_required');
        return call(exec, FINANCE_POLICIES.finance_review_decide.procedure, { dept: FINANCE_DEPT, reviewId, decision, ...(note ? { note } : {}) }, true, ctx);
      },
    },
    {
      name: 'finance_notice_read',
      output: OUTPUT,
      description: '经本人单次确认后，把财务通知标为已读（仅传真实通知 ID 数组）',
      parameters: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: LIMITS.noticeIdsMax } },
        required: ['ids'],
      },
      execute: async (args = {}, exec) => {
        if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > LIMITS.noticeIdsMax) throw new Error('dept_finance_notice_ids_invalid');
        const ids = args.ids.map((id) => requiredText(id, 'dept_finance_notice_id_invalid', LIMITS.noticeIdChars));
        return call(exec, FINANCE_POLICIES.finance_notice_read.procedure, { dept: FINANCE_DEPT, ids }, true, ctx);
      },
    },
  ];
  return toolList.map((tool) => ({ ...tool, execute: (args, exec) => tool.execute(argsOf(args), exec) }));
}
