import type { IncomingWebhookRequest, ParsedWebhookEvent } from '../../types.ts';
import {
  toIncomingWebhook,
  verifyHmacSignature,
  type VerifyWebhookParams,
} from '../../webhooks/verify.ts';

export type { VerifyWebhookParams } from '../../webhooks/verify.ts';

interface BitbucketRefState {
  type?: string;
  name?: string;
}

interface BitbucketChange {
  new?: BitbucketRefState | null;
  old?: BitbucketRefState | null;
  commits?: { hash?: string; message?: string }[];
}

interface BitbucketWebhookPayload {
  push?: { changes?: BitbucketChange[] };
  repository?: { full_name?: string };
}

export function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  return verifyHmacSignature(params, { header: 'x-hub-signature' });
}

export async function parseWebhookEvent(
  input: Request | IncomingWebhookRequest,
): Promise<ParsedWebhookEvent> {
  const incoming = await toIncomingWebhook(input);
  const eventKey = incoming.headers['x-event-key'];
  const payload = (incoming.body ? JSON.parse(incoming.body) : {}) as BitbucketWebhookPayload;

  let type: ParsedWebhookEvent['type'] = 'unknown';
  let ref: string | undefined;
  let commits: { sha: string; message?: string }[] | undefined;

  if (eventKey === 'repo:push') {
    const changes = payload.push?.changes ?? [];
    const firstRef = changes[0] ? (changes[0].new ?? changes[0].old) : undefined;
    // A push with no resolvable change is still fundamentally a push (not a tag_push);
    // otherwise classify from the first change's ref type — a delivery's changes are homogeneous.
    type = firstRef?.type === 'tag' ? 'tag_push' : 'push';

    if (firstRef?.name) {
      ref = firstRef.type === 'tag' ? `refs/tags/${firstRef.name}` : `refs/heads/${firstRef.name}`;
    }
    commits = changes[0]?.commits?.map((commit) => ({
      sha: commit.hash ?? '',
      message: commit.message,
    }));
  }

  return {
    type,
    repo: payload.repository?.full_name,
    ref,
    commits,
    deliveryId: incoming.headers['x-hook-uuid'] ?? incoming.headers['x-request-uuid'],
    raw: payload,
  };
}
