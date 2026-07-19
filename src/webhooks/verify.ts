import type { IncomingWebhookRequest } from '../types.ts';

/**
 * Flattened params: pass either a fetch `Request` or a `{ headers, body }` pair,
 * always alongside the shared `secret` — e.g. `verifyWebhook({ request, secret })`.
 */
export type VerifyWebhookParams = (
  { request: Request } | { headers: Record<string, string>; body: string }
) & { secret: string };

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, payload: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const signature = await crypto.subtle.sign('HMAC', key, data as BufferSource);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  const length = Math.max(bytesA.length, bytesB.length);
  let mismatch = bytesA.length === bytesB.length ? 0 : 1;
  for (let index = 0; index < length; index++) {
    mismatch |= (bytesA[index] ?? 0) ^ (bytesB[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Shared HMAC webhook verification: compares the incoming signature header
 * against `${scheme}=<hmac-sha256(secret, body)>` in constant time. Providers
 * differ only in the header name and (rarely) the scheme prefix.
 */
export async function verifyHmacSignature(
  params: VerifyWebhookParams,
  options: { header: string; scheme?: string },
): Promise<boolean> {
  if (!params.secret) return false;
  const incoming = await toIncomingWebhook('request' in params ? params.request : params);
  const signature = incoming.headers[options.header.toLowerCase()];
  if (!signature) return false;
  const expected = `${options.scheme ?? 'sha256'}=${await hmacSha256Hex(params.secret, incoming.body)}`;
  return timingSafeEqual(signature, expected);
}

export async function toIncomingWebhook(
  input: Request | IncomingWebhookRequest,
): Promise<IncomingWebhookRequest> {
  if (input instanceof Request) {
    const headers: Record<string, string> = {};
    input.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { headers, body: await input.clone().text() };
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    headers[key.toLowerCase()] = value;
  }
  return { headers, body: input.body };
}
