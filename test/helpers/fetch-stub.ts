export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
}

export interface StubResponseInit {
  status?: number;
  headers?: Record<string, string | undefined>;
  json?: unknown;
  body?: string;
}

export type StubHandler = (
  request: CapturedRequest,
) => StubResponseInit | Promise<StubResponseInit>;

export interface FetchStub {
  fetch: typeof fetch;
  requests: CapturedRequest[];
}

/**
 * Minimal `fetch` double: captures every request and returns canned responses
 * produced by `handler`. Shared across provider unit tests.
 */
export function createFetchStub(handler: StubHandler): FetchStub {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    };
    requests.push(captured);

    const result = await handler(captured);
    const status = result.status ?? 200;
    const payload = result.json !== undefined ? JSON.stringify(result.json) : result.body;
    const emptyBody = status === 204 || status === 304 || (status >= 300 && status < 400);
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      if (value !== undefined) responseHeaders.set(key, value);
    }
    return new Response(emptyBody ? null : (payload ?? null), {
      status,
      headers: responseHeaders,
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}
