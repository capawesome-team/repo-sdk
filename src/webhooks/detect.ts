import type { ProviderName } from '../types.ts';

/** Like `IncomingWebhookRequest`, but the body is optional — headers alone identify most providers. */
export interface DetectWebhookProviderInput {
  headers: Record<string, string>;
  body?: string;
}

// Gitea deliveries carry x-github-event alongside x-gitea-event for
// compatibility, so gitea must be checked first.
const HEADER_SIGNALS: [header: string, provider: ProviderName][] = [
  ['x-gitea-event', 'gitea'],
  ['x-github-event', 'github'],
  ['x-gitlab-event', 'gitlab'],
  ['x-event-key', 'bitbucket'],
];

/**
 * Identifies which provider sent a webhook delivery, for routing a single
 * endpoint to the right per-provider `verifyWebhook`/`parseWebhookEvent`.
 * Detection is routing only — it is not authentication; always verify the
 * delivery with the detected provider's `verifyWebhook` afterwards.
 *
 * Azure DevOps service hooks carry no identifying header, so when no header
 * matches, the JSON body is checked for Azure's `eventType` field (reading
 * the body of a `Request` is why this function is async).
 */
export async function detectWebhookProvider(
  input: Request | DetectWebhookProviderInput,
): Promise<ProviderName | undefined> {
  const header = (name: string): string | null | undefined =>
    input instanceof Request
      ? input.headers.get(name)
      : Object.entries(input.headers).find(([key]) => key.toLowerCase() === name)?.[1];

  for (const [name, provider] of HEADER_SIGNALS) {
    if (header(name) != null) return provider;
  }

  const body = input instanceof Request ? await input.clone().text() : input.body;
  if (!body) return undefined;
  try {
    const payload = JSON.parse(body) as { eventType?: unknown };
    if (typeof payload === 'object' && payload !== null && typeof payload.eventType === 'string') {
      return 'azure-devops';
    }
  } catch {
    // Not JSON — no provider identified.
  }
  return undefined;
}
