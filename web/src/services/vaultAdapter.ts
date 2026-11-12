import type {
  AuthorizationView,
  DenialRecordView,
  VaultReadAdapter,
  VaultReadResult,
  VaultStateView,
} from '../types';

interface NearRpcResponse {
  result?: { result?: number[] };
  error?: { code?: number; message?: string };
}

/** Read-only JSON-RPC adapter for the public BastionPro contract views. */
export class LiveRpcReadAdapter implements VaultReadAdapter {
  constructor(
    private readonly rpcEndpoint: string,
    private readonly contractAccountId: string,
  ) {}

  getVaultState(): Promise<VaultReadResult<VaultStateView>> {
    return this.callView('get_vault_state', {}, isVaultStateView);
  }

  getAuthorization(authId: string): Promise<VaultReadResult<AuthorizationView | null>> {
    return this.callView('get_authorization', { auth_id: authId }, isAuthorizationView);
  }

  getDenialLog(fromIndex?: string, limit?: string): Promise<VaultReadResult<DenialRecordView[]>> {
    return this.callView('get_denial_log', {
      from_index: fromIndex ?? null,
      limit: limit ?? null,
    }, isDenialLog);
  }

  private async callView<T>(
    methodName: string,
    args: Record<string, unknown>,
    isView: (value: unknown) => value is T,
  ): Promise<VaultReadResult<T>> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.rpcEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'bastionpro-read',
          method: 'query',
          params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: this.contractAccountId,
            method_name: methodName,
            args_base64: encodeBase64(JSON.stringify(args)),
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return { status: 'unavailable', reason: 'rpc-error', message: `RPC returned HTTP ${response.status}` };
      }

      const payload = await response.json() as NearRpcResponse;
      if (payload.error) {
        return {
          status: 'unavailable',
          reason: 'contract-error',
          message: `NEAR view query failed (${payload.error.code ?? 'unknown'})`,
        };
      }

      const bytes = payload.result?.result;
      if (!Array.isArray(bytes) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        return { status: 'unavailable', reason: 'rpc-error', message: 'RPC response did not contain view result bytes' };
      }

      const value: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
      if (!isView(value)) {
        return { status: 'unavailable', reason: 'contract-error', message: 'Contract returned an unexpected view schema' };
      }
      return { status: 'available', value };
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'NEAR RPC request timed out'
        : 'Could not reach or decode the NEAR RPC response';
      return { status: 'unavailable', reason: 'rpc-error', message };
    } finally {
      window.clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnsignedString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isVaultStateView(value: unknown): value is VaultStateView {
  if (!isRecord(value) || !isRecord(value.denial_counts)) return false;
  const counts = value.denial_counts;
  return typeof value.owner_id === 'string'
    && isUnsignedString(value.vault_balance)
    && isUnsignedString(value.reserved_balance)
    && typeof value.is_frozen === 'boolean'
    && isNonNegativeInteger(value.consecutive_violations)
    && isNonNegativeInteger(value.max_consecutive_violations)
    && isUnsignedString(value.total_denials_logged)
    && isUnsignedString(value.denial_records_evicted)
    && isUnsignedString(value.oldest_denial_index)
    && ['invalid_amount', 'vault_frozen', 'auth_not_found', 'auth_revoked', 'auth_already_used',
      'auth_expired', 'recipient_not_approved', 'amount_exceeded', 'insufficient_vault_balance', 'other']
      .every((key) => isUnsignedString(counts[key]));
}

function isAuthorizationView(value: unknown): value is AuthorizationView | null {
  if (value === null) return true;
  return isRecord(value)
    && typeof value.auth_id === 'string'
    && typeof value.authorized_initiator === 'string'
    && typeof value.approved_recipient === 'string'
    && isUnsignedString(value.max_amount)
    && isUnsignedString(value.expires_at_ns)
    && typeof value.nonce === 'string'
    && typeof value.used === 'boolean'
    && (value.pending_transfer_id === null || isUnsignedString(value.pending_transfer_id))
    && typeof value.revoked === 'boolean'
    && isUnsignedString(value.created_at_ns);
}

function isDenialLog(value: unknown): value is DenialRecordView[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry)
    && typeof entry.error_code === 'string'
    && typeof entry.reason === 'string'
    && typeof entry.caller_id === 'string'
    && typeof entry.auth_id === 'string'
    && typeof entry.attempted_recipient === 'string'
    && isUnsignedString(entry.attempted_amount)
    && isUnsignedString(entry.timestamp_ns)
    && typeof entry.vault_auto_frozen === 'boolean');
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
