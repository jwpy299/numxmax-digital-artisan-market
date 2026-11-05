import { registerGatedTools } from 'numx-org/lib/lifecycle.js';
import { assertFinanceManifest, FINANCE_MANIFEST } from './manifest.js';
import { createTools, FINANCE_POLICIES } from './tools.js';

export const name = FINANCE_MANIFEST.id;
export const inject = ['tools', 'credentials'];

export function apply(ctx) {
  if (typeof ctx?.on !== 'function' || typeof ctx?.tools?.register !== 'function') {
    throw new Error('dept_finance_runtime_unavailable');
  }
  if (typeof ctx?.credentials?.readRecord !== 'function') {
    throw new Error('dept_finance_credentials_unavailable');
  }
  const tools = createTools(ctx);
  assertFinanceManifest(tools, FINANCE_POLICIES);
  return registerGatedTools(ctx, { extraPolicies: FINANCE_POLICIES, tools, prefix: 'dept_finance' });
}

export { createTools } from './tools.js';
