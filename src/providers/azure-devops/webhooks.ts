import type { IncomingWebhookRequest, ParsedWebhookEvent } from '../../types.ts';
import { headShaOrUndefined } from '../../webhooks/parse.ts';
import {
  timingSafeEqual,
  toIncomingWebhook,
  type VerifyWebhookParams as BaseVerifyWebhookParams,
} from '../../webhooks/verify.ts';
import { BASIC_AUTH_USERNAME } from './auth.ts';

/**
 * Azure-only extension: `header` names the custom HTTP header carrying the secret
 * for hooks registered with the provider's `webhookSecretHeader` option.
 */
export type VerifyWebhookParams = BaseVerifyWebhookParams & { header?: string };

interface AzureWebhookPayload {
  id?: string;
  subscriptionId?: string;
  eventType?: string;
  resource?: {
    commits?: { commitId?: string; comment?: string }[];
    refUpdates?: { name?: string; newObjectId?: string }[];
    repository?: { name?: string; project?: { name?: string } };
  };
}

/**
 * Azure DevOps service hooks carry no HMAC signature. By default the SDK
 * registers hooks with HTTP Basic auth (username `repo-sdk`, password = secret),
 * so verification is a constant-time comparison of the incoming `Authorization`
 * header. For hooks registered with a `webhookSecretHeader`, pass the same
 * header name as `header` and the secret is compared against that header instead.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  if (!params.secret) return false;
  const incoming = await toIncomingWebhook('request' in params ? params.request : params);
  if (params.header) {
    const value = incoming.headers[params.header.toLowerCase()];
    if (!value) return false;
    return timingSafeEqual(value, params.secret);
  }
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
    return {
      type: 'unknown',
      deliveryId: payload.id,
      webhookId: payload.subscriptionId,
      raw: payload,
    };
  }

  const refUpdate = payload.resource?.refUpdates?.[0];
  const type = refUpdate?.name?.startsWith('refs/tags/') ? 'tag_push' : 'push';
  const commits = payload.resource?.commits?.map((commit) => ({
    sha: commit.commitId ?? '',
    message: commit.comment,
  }));
  const repository = payload.resource?.repository;
  const repo = repository ? `${repository.project?.name}/${repository.name}` : undefined;

  return {
    type,
    repo,
    ref: refUpdate?.name,
    commits,
    headCommitSha: headShaOrUndefined(refUpdate?.newObjectId),
    deliveryId: payload.id,
    webhookId: payload.subscriptionId,
    raw: payload,
  };
}
