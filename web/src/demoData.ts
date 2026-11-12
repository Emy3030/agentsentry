import type {
  AuthorizationRecord,
  DenialSummary,
  PaymentActivity,
  VaultDataSource,
  VaultSnapshot,
} from './types';

const snapshot: VaultSnapshot = {
  vaultBalanceNear: '128.40',
  reservedBalanceNear: '5.00',
  frozen: false,
  consecutiveViolations: 1,
  maxConsecutiveViolations: 3,
  persistedDenialCount: '12',
};

const authorizations: AuthorizationRecord[] = [
  {
    id: 'auth_cloud_invoice_04',
    initiator: 'procurement-agent.near',
    recipient: 'cloud-services.near',
    maxAmountNear: '12.00',
    expiresAt: '2026-12-01',
    status: 'ACTIVE',
    source: 'DEMO FIXTURE',
  },
  {
    id: 'auth_vendor_tools_02',
    initiator: 'operations-agent.near',
    recipient: 'analytics-tools.near',
    maxAmountNear: '4.50',
    expiresAt: '2026-11-18',
    status: 'ACTIVE',
    source: 'DEMO FIXTURE',
  },
  {
    id: 'auth_hosting_01',
    initiator: 'procurement-agent.near',
    recipient: 'hosting-provider.near',
    maxAmountNear: '8.00',
    expiresAt: '2026-10-20',
    status: 'EXPIRED',
    source: 'DEMO FIXTURE',
  },
];

const activity: PaymentActivity[] = [
  {
    id: 'demo-activity-1',
    title: 'Cloud services invoice',
    recipient: 'cloud-services.near',
    amountNear: '5.00',
    status: 'PENDING',
    detail: 'Transfer initiated · awaiting contract callback',
    occurredAt: '03 Nov 2026 · 10:42',
    source: 'DEMO FIXTURE',
  },
  {
    id: 'demo-activity-2',
    title: 'Invoice recipient mismatch',
    recipient: 'cloud-services.attacker.near',
    amountNear: '5.00',
    status: 'DENIED',
    detail: 'Recipient did not match the approved authorization',
    occurredAt: '03 Nov 2026 · 09:18',
    source: 'DEMO FIXTURE',
  },
  {
    id: 'demo-activity-3',
    title: 'Analytics subscription',
    recipient: 'analytics-tools.near',
    amountNear: '2.25',
    status: 'EXECUTED',
    detail: 'Transfer confirmed by callback',
    occurredAt: '02 Nov 2026 · 16:07',
    source: 'DEMO FIXTURE',
  },
  {
    id: 'demo-activity-4',
    title: 'Hosting provider invoice',
    recipient: 'hosting-provider.near',
    amountNear: '3.00',
    status: 'FAILED',
    detail: 'Transfer promise failed · authorization available to retry',
    occurredAt: '02 Nov 2026 · 11:32',
    source: 'DEMO FIXTURE',
  },
];

const denials: DenialSummary[] = [
  { category: 'Recipient mismatch', count: 7 },
  { category: 'Amount above limit', count: 3 },
  { category: 'Expired authorization', count: 2 },
];

export const demoDataSource: VaultDataSource = {
  getSnapshot: () => ({ ...snapshot }),
  getAuthorizations: () => authorizations.map((record) => ({ ...record })),
  getRecentActivity: () => activity.map((record) => ({ ...record })),
  getDenialSummary: () => denials.map((record) => ({ ...record })),
};
