import { codeFromStatus, parseRetryAfter, RepoError, type RepoErrorCode } from './errors.ts';
import type { ProviderName } from './types.ts';

export type QueryValue = string | number | boolean | string[] | undefined;

export interface HttpRequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  redirect?: RequestRedirect;
}

export interface ProviderErrorInfo {
  code?: RepoErrorCode;
  message?: string;
}

export interface HttpClientOptions {
  provider: ProviderName;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  authHeaders: () => Record<string, string> | Promise<Record<string, string>>;
  mapError?: (status: number, body: unknown, response: Response) => ProviderErrorInfo;
  secrets?: () => readonly string[];
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  buildUrl(path: string, query?: Record<string, QueryValue>): URL {
    const url = /^https?:\/\//.test(path)
      ? new URL(path)
      : new URL(this.options.baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(key, entry);
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  async raw(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      ...(await this.options.authHeaders()),
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] ??= 'application/json';
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: options.signal,
        redirect: options.redirect,
      });
    } catch (error) {
      throw new RepoError(`Request to ${url.origin}${url.pathname} failed`, {
        code: 'network_error',
        provider: this.options.provider,
        cause: error,
        secrets: this.options.secrets?.() ?? [],
      });
    }
    if (
      !response.ok &&
      !(options.redirect === 'manual' && response.status >= 300 && response.status < 400)
    ) {
      throw await this.toError(response);
    }
    return response;
  }

  async json<T>(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<{ data: T; response: Response }> {
    const response = await this.raw(path, options);
    const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    return { data, response };
  }

  private async toError(response: Response): Promise<RepoError> {
    const text = await response.text().catch(() => '');
    let responseBody: unknown = text;
    try {
      responseBody = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const mapped = this.options.mapError?.(response.status, responseBody, response) ?? {};
    return new RepoError(
      mapped.message ?? `${this.options.provider} request failed with status ${response.status}`,
      {
        code: mapped.code ?? codeFromStatus(response.status),
        provider: this.options.provider,
        status: response.status,
        retryAfter: parseRetryAfter(response.headers.get('retry-after')),
        cause: responseBody,
        secrets: this.options.secrets?.() ?? [],
      },
    );
  }
}
