export type PaymentStatus = 'PENDING' | 'EXECUTED' | 'FAILED' | 'DENIED';

export interface VaultSnapshot {
  /** NEAR values formatted for display; source is determined by the active adapter result. */
  vaultBalanceNear: string;
  reservedBalanceNear: string;
  frozen: boolean;
  consecutiveViolations: number;
  maxConsecutiveViolations: number;
  persistedDenialCount: number;
}

/** JSON schema returned by AgentSentryVault::get_vault_state. */
export interface VaultStateView {
  owner_id: string;
  vault_balance: string;
  reserved_balance: string;
  is_frozen: boolean;
  consecutive_violations: number;
  max_consecutive_violations: number;
  total_denials_logged: number;
  denial_records_evicted: number;
  oldest_denial_index: number;
  denial_counts: Record<string, number>;
}

export interface AuthorizationView {
  auth_id: string;
  authorized_initiator: string;
  approved_recipient: string;
  max_amount: string;
  expires_at_ns: string;
  nonce: string;
  used: boolean;
  pending_transfer_id: number | null;
  revoked: boolean;
  created_at_ns: string;
}

export interface DenialRecordView {
  error_code: string;
  reason: string;
  caller_id: string;
  auth_id: string;
  attempted_recipient: string;
  attempted_amount: string;
  timestamp_ns: string;
  vault_auto_frozen: boolean;
}

export type VaultReadResult<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable'; reason: 'rpc-error' | 'contract-error'; message?: string };

/** Read-only boundary for public AgentSentry contract views. */
export interface VaultReadAdapter {
  getVaultState(): Promise<VaultReadResult<VaultStateView>>;
  getAuthorization(authId: string): Promise<VaultReadResult<AuthorizationView | null>>;
  getDenialLog(fromIndex?: number, limit?: number): Promise<VaultReadResult<DenialRecordView[]>>;
}

export interface AuthorizationRecord {
  id: string;
  initiator: string;
  recipient: string;
  maxAmountNear: string;
  expiresAt: string;
  status: 'ACTIVE' | 'USED' | 'REVOKED' | 'EXPIRED';
  source: 'DEMO FIXTURE' | 'LOCAL DEMO';
}

export interface PaymentActivity {
  id: string;
  title: string;
  recipient: string;
  amountNear: string;
  status: PaymentStatus;
  detail: string;
  occurredAt: string;
  source: 'DEMO FIXTURE';
}

export interface DenialSummary {
  category: string;
  count: number;
}

/** Typed boundary: replace this demo adapter with NEAR reads/writes in Phase 2. */
export interface VaultDataSource {
  getSnapshot(): VaultSnapshot;
  getAuthorizations(): AuthorizationRecord[];
  getRecentActivity(): PaymentActivity[];
  getDenialSummary(): DenialSummary[];
}
