export const AGENT_RUNTIME_PLUGIN_PROTOCOL = {
  protocol: 'arp-v1',
  sourceOfTruth: 'canonical-mysql',
  eventDriven: true,
  notPkx: true,
  changesExistingSubscriptionPackages: false,
  operations: {
    health: { method: 'query', returns: 'configured/ready/capabilities/modelProfile; no credentials' },
    createTicket: { method: 'mutation', input: 'department/role/title/brief/rewardJobTokens/idempotencyKey', creates: 'existing agentWork competition and claim records' },
    getEvents: { method: 'query', returns: 'canonical outbox/audit events with lease/fencing/retry/cancel state' },
    getResult: { method: 'query', returns: 'deliverable/resultSha256/agentSession; awaiting_review is not accepted' },
    cancelTicket: { method: 'mutation', effect: 'revoke lease/delegation/outbox and cancel existing work task; late result is outcome_unknown' },
  },
  requiredCapabilities: ['agent-session', 'event-deliverable'],
  agentNotModel: true,
  rules: [
    'DSH native and DSH model profiles must run a real agent session and tool loop.',
    'An OpenAI-compatible chat completion alone is not an Agent runtime.',
    'Executed or submitted is not done; independent review is required before the existing wage ledger settles.',
    'No arbitrary code upload and no change to PKX or subscription plugin packages.',
  ],
} as const
