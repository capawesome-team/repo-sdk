import type { IncomingWebhookRequest, ParsedWebhookEvent } from '../../types.ts';
import {
  timingSafeEqual,
  toIncomingWebhook,
  type VerifyWebhookParams,
} from '../../webhooks/verify.ts';
import { BASIC_AUTH_USERNAME } from './auth.ts';

export type { VerifyWebhookParams } from '../../webhooks/verify.ts';

interface AzureWebhookPayload {
  id?: string;
  eventType?: string;
  resource?: {
    commits?: { commitId?: string; comment?: string }[];
    refUpdates?: { name?: string }[];
    repository?: { name?: string; project?: { name?: string } };
  };
}

/**
 * Azure DevOps service hooks carry no HMAC signature. The SDK registers hooks
 * with HTTP Basic auth (username `repo-sdk`, password = secret), so verification
 * is a constant-time comparison of the incoming `Authorization` header.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  if (!params.secret) return false;
  const incoming = await toIncomingWebhook('request' in params ? params.request : params);
  const header = incoming.headers['authorization'];
  if (!header) return false;
  const expected = `Basic ${btoa(`${BASIC_AUTH_USERNAME}:${params.secret}`)}`;
  return timingSafeEqual(header, expected);
}

export async function parseWebhookEvent(
  input: Request | IncomingWebhookRequest,
): Promise<ParsedWebhookEvent> {
  const incoming = await toIncomingWebhook(input);
  const payload = (incoming.body ? JSON.parse(incoming.body) : {}) as AzureWebhookPayload;

  if (payload.eventType !== 'git.push') {
    return { type: 'unknown', deliveryId: payload.id, raw: payload };
  }

  const refName = payload.resource?.refUpdates?.[0]?.name;
  const type = refName?.startsWith('refs/tags/') ? 'tag_push' : 'push';
  const commits = payload.resource?.commits?.map((commit) => ({
    sha: commit.commitId ?? '',
    message: commit.comment,
  }));
  const repository = payload.resource?.repository;
  const repo = repository ? `${repository.project?.name}/${repository.name}` : undefined;

  return { type, repo, ref: refName, commits, deliveryId: payload.id, raw: payload };
}
