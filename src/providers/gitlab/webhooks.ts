import type { IncomingWebhookRequest, ParsedWebhookEvent } from '../../types.ts';
import { headShaOrUndefined } from '../../webhooks/parse.ts';
import {
  timingSafeEqual,
  toIncomingWebhook,
  type VerifyWebhookParams,
} from '../../webhooks/verify.ts';

export type { VerifyWebhookParams } from '../../webhooks/verify.ts';

interface GitLabWebhookPayload {
  ref?: string;
  after?: string;
  project?: { path_with_namespace?: string };
  commits?: { id?: string; message?: string }[];
}

/**
 * GitLab sends the configured secret verbatim in `X-Gitlab-Token` (a plain shared
 * token, not an HMAC signature). Compare it against the expected secret in
 * constant time.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  if (!params.secret) return false;
  const incoming = await toIncomingWebhook('request' in params ? params.request : params);
  const token = incoming.headers['x-gitlab-token'];
  if (!token) return false;
  return timingSafeEqual(token, params.secret);
}

export async function parseWebhookEvent(
  input: Request | IncomingWebhookRequest,
): Promise<ParsedWebhookEvent> {
  const incoming = await toIncomingWebhook(input);
  const eventName = incoming.headers['x-gitlab-event'];
  const payload = (incoming.body ? JSON.parse(incoming.body) : {}) as GitLabWebhookPayload;

  let type: ParsedWebhookEvent['type'] = 'unknown';
  if (eventName === 'Push Hook') type = 'push';
  else if (eventName === 'Tag Push Hook') type = 'tag_push';
  else if (eventName === 'Release Hook') type = 'release';

  const commits = Array.isArray(payload.commits)
    ? payload.commits.map((commit) => ({ sha: commit.id ?? '', message: commit.message }))
    : undefined;

  return {
    type,
    repo: payload.project?.path_with_namespace,
    ref: payload.ref,
    commits,
    headCommitSha: headShaOrUndefined(payload.after),
    deliveryId: incoming.headers['x-gitlab-event-uuid'],
    webhookId: incoming.headers['x-gitlab-webhook-uuid'],
    raw: payload,
  };
}
