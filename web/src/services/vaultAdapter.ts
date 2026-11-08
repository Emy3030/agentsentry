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

/** Read-only JSON-RPC adapter for the public AgentSentry contract views. */
export class LiveRpcReadAdapter implements VaultReadAdapter {
  constructor(
    private readonly rpcEndpoint: string,
    private readonly contractAccountId: string,
  ) {}

  getVaultState(): Promise<VaultReadResult<VaultStateView>> {
    return this.callView('get_vault_state', {});
  }

  getAuthorization(authId: string): Promise<VaultReadResult<AuthorizationView | null>> {
    return this.callView('get_authorization', { auth_id: authId });
  }

  getDenialLog(fromIndex?: number, limit?: number): Promise<VaultReadResult<DenialRecordView[]>> {
    return this.callView('get_denial_log', {
      from_index: fromIndex ?? null,
      limit: limit ?? null,
    });
  }

  private async callView<T>(methodName: string, args: Record<string, unknown>): Promise<VaultReadResult<T>> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.rpcEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'agentsentry-read',
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

      const value = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
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

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
