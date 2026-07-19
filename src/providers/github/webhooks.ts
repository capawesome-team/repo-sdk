import type { IncomingWebhookRequest, ParsedWebhookEvent } from '../../types.ts';
import {
  toIncomingWebhook,
  verifyHmacSignature,
  type VerifyWebhookParams,
} from '../../webhooks/verify.ts';

export type { VerifyWebhookParams } from '../../webhooks/verify.ts';

interface GitHubWebhookPayload {
  ref?: string;
  ref_type?: string;
  repository?: { full_name?: string };
  commits?: { id?: string; message?: string }[];
}

export function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  return verifyHmacSignature(params, { header: 'x-hub-signature-256' });
}

export async function parseWebhookEvent(
  input: Request | IncomingWebhookRequest,
): Promise<ParsedWebhookEvent> {
  const incoming = await toIncomingWebhook(input);
  const eventName = incoming.headers['x-github-event'];
  const payload = (incoming.body ? JSON.parse(incoming.body) : {}) as GitHubWebhookPayload;

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
  } else if (eventName === 'ping') {
    type = 'ping';
  }

  const commits = Array.isArray(payload.commits)
    ? payload.commits.map((commit) => ({ sha: commit.id ?? '', message: commit.message }))
    : undefined;

  return {
    type,
    repo: payload.repository?.full_name,
    ref,
    commits,
    deliveryId: incoming.headers['x-github-delivery'],
    raw: payload,
  };
}
