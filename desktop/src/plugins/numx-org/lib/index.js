import { assertToolPoliciesComplete } from './approval.js';
import { registerGatedTools } from './lifecycle.js';
import { registerOrgUi } from './ui-routes.js';
import { createSessionStore, disposeSessions } from './session.js';
import { createTools, TOOL_POLICIES } from './tools.js';

export const name = 'numx-org';
export const inject = ['tools', 'credentials', 'connection'];

export async function apply(ctx) {
  if (typeof ctx?.on !== 'function') throw new Error('org_plugin_approval_gate_unavailable');
  if (typeof ctx?.tools?.register !== 'function') throw new Error('org_plugin_tools_unavailable');
  if (typeof ctx?.provide !== 'function' || typeof ctx?.credentials?.readRecord !== 'function' || typeof ctx?.credentials?.deleteRecord !== 'function' || typeof ctx?.credentials?.modifyRecord !== 'function') {
    throw new Error('org_plugin_credentials_unavailable');
  }
  assertToolPoliciesComplete();
  const disposeTools = registerGatedTools(ctx, {
    extraPolicies: {},
    tools: createTools(ctx),
    provideAuth: () => ctx.provide('numxOrgAuth', createSessionStore(ctx)),
    onDispose: () => { disposeSessions(ctx); },
    prefix: 'org_plugin',
  });
  try {
    const disposeUi = await registerOrgUi(ctx);
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      let firstError;
      try { await disposeUi(); } catch (error) { firstError = error; }
      try { disposeTools(); } catch (error) {
        if (firstError) throw new AggregateError([firstError, error], 'org_plugin_dispose_failed');
        throw error;
      }
      if (firstError) throw firstError;
    };
  } catch (error) {
    try { disposeTools(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'org_plugin_rollback_failed');
    }
    throw error;
  }
}

export { createTools } from './tools.js';
