import type { IncomingWebhookRequest, ParsedWebhookEvent } from '../../types.ts';
import { headShaOrUndefined } from '../../webhooks/parse.ts';
import {
  hmacSha256Hex,
  timingSafeEqual,
  toIncomingWebhook,
  type VerifyWebhookParams,
} from '../../webhooks/verify.ts';

export type { VerifyWebhookParams } from '../../webhooks/verify.ts';

interface GiteaWebhookPayload {
  ref?: string;
  ref_type?: string;
  after?: string;
  repository?: { full_name?: string };
  commits?: { id?: string; message?: string }[];
}

/**
 * Gitea signs deliveries with HMAC-SHA256 like GitHub, but `X-Gitea-Signature`
 * carries the bare hex digest — no `sha256=` scheme prefix — so the shared
 * `verifyHmacSignature` helper does not apply.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  if (!params.secret) return false;
  const incoming = await toIncomingWebhook('request' in params ? params.request : params);
  const signature = incoming.headers['x-gitea-signature'];
  if (!signature) return false;
  return timingSafeEqual(signature, await hmacSha256Hex(params.secret, incoming.body));
}

export async function parseWebhookEvent(
  input: Request | IncomingWebhookRequest,
): Promise<ParsedWebhookEvent> {
  const incoming = await toIncomingWebhook(input);
  const eventName = incoming.headers['x-gitea-event'];
  const payload = (incoming.body ? JSON.parse(incoming.body) : {}) as GiteaWebhookPayload;

  let type: ParsedWebhookEvent['type'] = 'unknown';
  let ref = payload.ref;

  if (eventName === 'push') {
    type = payload.ref?.startsWith('refs/tags/') ? 'tag_push' : 'push';
  } else if (eventName === 'create' || eventName === 'delete') {
    if (payload.ref_type === 'tag') {
      type = 'tag_push';
      ref = `refs/tags/${payload.ref}`;
    }
  } else if (eventName === 'release') {
    type = 'release';
  }

  const commits = Array.isArray(payload.commits)
    ? payload.commits.map((commit) => ({ sha: commit.id ?? '', message: commit.message }))
    : undefined;

  return {
    type,
    repo: payload.repository?.full_name,
    ref,
    commits,
    headCommitSha: headShaOrUndefined(payload.after),
    deliveryId: incoming.headers['x-gitea-delivery'],
    raw: payload,
  };
}
