import type { ProviderName } from './types.ts';

export type RepoErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'validation'
  | 'unsupported'
  | 'provider_error'
  | 'network_error';

export interface RepoErrorOptions {
  code: RepoErrorCode;
  provider: ProviderName;
  status?: number;
  retryAfter?: number;
  retryable?: boolean;
  cause?: unknown;
  secrets?: readonly string[];
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join('[redacted]');
    }
  }
  return result;
}

const RETRYABLE_CODES: ReadonlySet<RepoErrorCode> = new Set(['rate_limited', 'network_error']);

export class RepoError extends Error {
  readonly code: RepoErrorCode;
  readonly provider: ProviderName;
  readonly status?: number;
  readonly retryAfter?: number;
  readonly retryable: boolean;

  constructor(message: string, options: RepoErrorOptions) {
    super(redactSecrets(message, options.secrets ?? []), { cause: options.cause });
    this.name = 'RepoError';
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.retryable =
      options.retryable ??
      (RETRYABLE_CODES.has(options.code) ||
        (options.status !== undefined && options.status >= 500));
  }
}

export function codeFromStatus(status: number): RepoErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  return 'provider_error';
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  return undefined;
}
