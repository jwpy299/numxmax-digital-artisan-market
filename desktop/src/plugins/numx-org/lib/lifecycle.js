import { createApprovalGate } from './approval.js';

/** org 与部门舱共用的“审批门→工具注册→逆序卸载”生命周期；任何不确定都保留审批门。 */
export function registerGatedTools(ctx, { extraPolicies, tools, provideAuth, onDispose, prefix }) {
  const disposeTools = [];
  let disposeAuth;
  let disposeGate;
  let disposed = false;
  let orphanToolNeedsGate = false;
  const cleanup = (preserveGate = false) => {
    if (disposed) return;
    disposed = true;
    let firstError;
    let toolsDisposed = true;
    for (const callback of disposeTools.splice(0).reverse()) {
      try { callback(); } catch (error) { toolsDisposed = false; firstError ||= error; }
    }
    if (!preserveGate && toolsDisposed && typeof disposeGate === 'function') {
      try { disposeGate(); } catch (error) { firstError ||= error; }
    }
    if (typeof disposeAuth === 'function') {
      try { disposeAuth(); } catch (error) { firstError ||= error; }
    }
    if (typeof onDispose === 'function') {
      try { onDispose(); } catch (error) { firstError ||= error; }
    }
    if (firstError) throw firstError;
  };
  try {
    if (provideAuth) {
      disposeAuth = provideAuth();
      if (typeof disposeAuth !== 'function') throw new Error(`${prefix}_auth_disposer_unavailable`);
    }
    disposeGate = ctx.on('tools/pre-execute', createApprovalGate(extraPolicies, tools));
    if (typeof disposeGate !== 'function') throw new Error(`${prefix}_approval_disposer_unavailable`);
    for (const tool of tools) {
      try {
        const disposeTool = ctx.tools.register(tool);
        if (typeof disposeTool !== 'function') throw new Error(`${prefix}_tool_disposer_unavailable:${tool.name}`);
        disposeTools.push(disposeTool);
      } catch (error) {
        orphanToolNeedsGate = true;
        throw error;
      }
    }
    return () => cleanup(false);
  } catch (error) {
    try { cleanup(orphanToolNeedsGate); } catch {}
    throw error;
  }
}
