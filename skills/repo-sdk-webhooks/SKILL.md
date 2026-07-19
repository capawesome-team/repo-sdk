---
name: repo-sdk-webhooks
description: Register, manage, verify, and parse repository webhooks across GitHub, GitLab, Bitbucket Cloud, and Azure DevOps with `repo-sdk`. Use when creating/listing/updating/deleting webhooks via `client.webhooks`, wiring an incoming webhook route handler (Next.js, Hono, Cloudflare Workers), or calling the standalone `verifyWebhook` / `parseWebhookEvent` exports — and when you need the per-provider event support (no `release` on Bitbucket/Azure) and verification differences (HMAC vs shared-token vs basic-auth).
---

# repo-sdk webhooks

Two independent halves: **managing** hooks on a repo (needs a `client`) and **receiving** deliveries (standalone, no client). Normalized events are `push`, `tag_push`, `release`.

## Registering & managing hooks

`client.webhooks` mirrors the provider's hook management API.

```ts
import { createClient } from 'repo-sdk';
import { github } from 'repo-sdk/github';

const client = createClient({ provider: github({ auth: { token: process.env.GITHUB_TOKEN! } }) });

const hook = await client.webhooks.create({
  repo: 'capawesome-team/repo-sdk',
  url: 'https://example.com/hooks/repo',
  secret: process.env.WEBHOOK_SECRET, // used for verification later; store it safely
  events: ['push', 'tag_push', 'release'],
  active: true, // optional
});

await client.webhooks.list({ repo: 'capawesome-team/repo-sdk' }); // { data, cursor }
await client.webhooks.get({ repo: 'capawesome-team/repo-sdk', id: hook.id });
await client.webhooks.update({ repo: 'capawesome-team/repo-sdk', id: hook.id, active: false });
await client.webhooks.delete({ repo: 'capawesome-team/repo-sdk', id: hook.id });
```

### Per-provider event support & quirks

| Event      | GitHub | GitLab | Bitbucket | Azure DevOps |
| ---------- | ------ | ------ | --------- | ------------ |
| `push`     | ✓      | ✓      | ✓         | ✓            |
| `tag_push` | ✓      | ✓      | ✓         | ✓            |
| `release`  | ✓      | ✓      | ✗         | ✗            |

Requesting an unsupported event throws `RepoError` with `code: 'unsupported'`. Also:

- **Bitbucket / Azure DevOps** have no `release` event.
- **Azure DevOps** delivers branch and tag pushes through a single `git.push` subscription and cannot filter to a subset — you must request **both** `['push', 'tag_push']` together; a subset throws.
- **GitLab** project hooks have no inactive flag (hooks are always active; GitLab only auto-disables after repeated delivery failures). Passing `active: false` to `create`/`update` throws rather than silently ignoring it.

## Receiving webhooks

`verifyWebhook` and `parseWebhookEvent` are standalone exports on each provider subpath — **no client needed**. They accept a Web-standard `Request` (or a `{ headers, body }` pair), so they drop into fetch-style handlers.

```ts
import { verifyWebhook, parseWebhookEvent } from 'repo-sdk/github';
// or repo-sdk/gitlab | repo-sdk/bitbucket | repo-sdk/azure-devops

export async function POST(request: Request): Promise<Response> {
  const valid = await verifyWebhook({ request, secret: process.env.WEBHOOK_SECRET! });
  if (!valid) return new Response('invalid signature', { status: 401 });

  const event = await parseWebhookEvent(request);
  // event: { type, repo?, ref?, commits?, deliveryId?, raw }
  // type: 'push' | 'tag_push' | 'release' | 'ping' | 'unknown'
  if (event.type === 'push') {
    console.log(`push to ${event.repo} @ ${event.ref}`, event.commits);
  }
  return new Response('ok');
}
```

`verifyWebhook` returns `Promise<boolean>`. It takes either `{ request, secret }` or `{ headers, body, secret }` — `secret` is always required. `parseWebhookEvent` takes the `Request`/`{ headers, body }` alone (no secret).

### Verification differs per provider

`verifyWebhook` handles the difference transparently — you always pass the same shared `secret` you registered the hook with:

| Provider     | Method       | How it verifies                                                |
| ------------ | ------------ | -------------------------------------------------------------- |
| GitHub       | HMAC-SHA256  | `X-Hub-Signature-256` over the raw body                        |
| GitLab       | shared token | `X-Gitlab-Token` compared to the configured secret             |
| Bitbucket    | HMAC-SHA256  | `X-Hub-Signature` (no `-256` suffix) over the raw body         |
| Azure DevOps | basic auth   | `Authorization` Basic header (hook registered with the secret) |

## Secret handling

- Pass the **same** secret to `webhooks.create` and to `verifyWebhook`. Keep it in an env var / secret store, never in source.
- HMAC providers (GitHub, Bitbucket) sign the **raw request body** — verify before parsing, and don't re-serialize the body in between (pass the original `Request`).
- Always verify before acting on an event, and reject with `401` on failure.
