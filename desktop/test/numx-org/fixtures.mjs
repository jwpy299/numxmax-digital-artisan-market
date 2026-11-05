import { credentialKeyForSession } from '../../src/plugins/numx-org/lib/session.js';
import contract from '../../src/plugins/numx-org/lib/contract.js';

export const API = contract.network.endpoint;
export const okResponse = () => new Response(JSON.stringify({ result: { data: { json: null } } }), { status: 200 });
export const createExec = () => ({ agent: { id: 'tool-input-test-session' } });

export function createToolContext(agentId) {
  return {
    credentials: {
      readRecord: async (key) => key === credentialKeyForSession(agentId) ? { kind: 'api-key', key: 'test-token' } : undefined,
      deleteRecord: async () => {},
    },
  };
}
