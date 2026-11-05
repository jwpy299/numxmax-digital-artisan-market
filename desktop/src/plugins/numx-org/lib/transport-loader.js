import { fileURLToPath } from 'node:url';

export const REQUIRED_TRANSPORT_FUNCTIONS = [
  'assertMaxBytes', 'isLoopbackHostname', 'isSecureUrl', 'trpcUrl', 'jsonStringByteLength',
  'normalizeJson', 'normalizeWithinBudget', 'maxNodesForBytes', 'readBoundedText', 'readTrpcResponse', 'unwrapTrpc', 'upstreamErrorCode',
];

export function assertTransportShape(value) {
  if (!value || typeof value !== 'object') throw new Error('org_plugin_transport_invalid');
  for (const key of REQUIRED_TRANSPORT_FUNCTIONS) {
    if (typeof value[key] !== 'function') throw new Error(`org_plugin_transport_invalid:${key}`);
  }
  return value;
}

export async function loadOrgTransport() {
  try {
    return assertTransportShape((await import('@numx/org-transport')).default);
  } catch (error) {
    const missingTarget = error?.code === 'ERR_MODULE_NOT_FOUND' && /^Cannot find package ['"]@numx\/org-transport['"]/.test(String(error?.message));
    if (!missingTarget) throw error;
    const candidates = ['../../../org-transport/index.cjs', '../../@numx/org-transport/index.cjs'];
    const errors = [];
    for (const candidate of candidates) {
      const candidateUrl = new URL(candidate, import.meta.url);
      const candidatePath = fileURLToPath(candidateUrl);
      try { return assertTransportShape((await import(candidate)).default); }
      catch (fallbackError) {
        errors.push(fallbackError);
        const message = String(fallbackError?.message || '');
        const missingCandidate = fallbackError?.code === 'ERR_MODULE_NOT_FOUND'
          && (message.includes(candidatePath) || message.includes(candidateUrl.href));
        if (!missingCandidate) throw fallbackError;
      }
    }
    throw new Error('org_plugin_transport_unavailable', { cause: errors.at(-1) });
  }
}

export const transport = await loadOrgTransport();
