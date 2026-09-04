# repo-sdk

[![npm version](https://img.shields.io/npm/v/repo-sdk)](https://www.npmjs.com/package/repo-sdk)
[![npm downloads](https://img.shields.io/npm/dm/repo-sdk)](https://www.npmjs.com/package/repo-sdk)
[![license](https://img.shields.io/npm/l/repo-sdk)](https://github.com/capawesome-team/repo-sdk/blob/main/LICENSE)

A unified, normalized, zero-dependency, edge-compatible TypeScript SDK over [GitHub](https://github.com), [GitLab](https://gitlab.com), [Bitbucket Cloud](https://bitbucket.org), [Azure DevOps](https://azure.microsoft.com/products/devops), and [Gitea](https://about.gitea.com) — plus generic git smart-HTTP remotes. Write your repository, commit, branch, tag, ref-resolution, download and webhook logic once against one normalized API — built on raw `fetch` and Web Crypto, so it runs on Node, Cloudflare Workers, and other Web-standard runtimes.

## Features

- **One API, eight namespaces** — users, namespaces, repos, commits, branches, tags, refs, and webhooks behind a single interface.
- **Capability gating** — providers differ. The client reports what the active provider supports and throws `unsupported` instead of silently dropping an option.
- **Ref resolution that follows git** — `refs.resolve` accepts a branch, a tag, a fully-qualified `refs/…`, `HEAD`, or an abbreviated SHA and returns one normalized match, with tags shadowing branches exactly like `git rev-parse`.
- **Webhook verify & parse** — standalone per-provider helpers that take a Web-standard `Request`. No client, no credentials. `detectWebhookProvider` routes a shared endpoint to the right pair.
- **Zero dependencies** — `fetch` and Web Crypto only. No `node:*` imports, so it runs on Cloudflare Workers without `nodejs_compat` — including RS256 JWT signing for GitHub App auth.
- **Tree-shakable and typed** — each provider ships on its own subpath, so unused providers never reach your bundle. Every model is normalized (IDs as strings, dates as `Date`, refs fully qualified) and keeps the untouched provider payload on `raw`.

## Installation

```bash
npm install repo-sdk
```

## Quickstart

Create a client from the package root and a provider factory from its subpath.

```ts
import { createClient } from 'repo-sdk';
import { github } from 'repo-sdk/github';

const client = createClient({
  provider: github({ auth: { token: process.env.GITHUB_TOKEN! } }),
});
```

Resolve a ref — a branch, tag, SHA, or `HEAD` — to a single commit, and page through history.

```ts
const head = await client.commits.get({ repo: 'capawesome-team/repo-sdk', ref: 'main' });
console.log(head.sha, head.message);

const { data: commits, cursor } = await client.commits.list({
  repo: 'capawesome-team/repo-sdk',
  ref: 'main',
  limit: 20,
});
```

Find out what a user-supplied ref actually is before you act on it.

```ts
const match = await client.refs.resolve({ repo: 'capawesome-team/repo-sdk', ref: 'v1.0.0' });
match.type; // 'branch' | 'tag' | 'commit'
match.ref; // 'refs/tags/v1.0.0'
match.sha; // peeled to the commit SHA for annotated tags
```

Download the code at that ref, as a stream or as a credential-bearing clone URL for the `git` CLI.

```ts
const archive = await client.repos.downloadArchive({
  repo: 'capawesome-team/repo-sdk',
  ref: match.sha,
  format: 'tar.gz',
});
await new Response(archive.stream).arrayBuffer();

const { url } = await client.repos.getCloneUrl({ repo: 'capawesome-team/repo-sdk' });
```

Verify and handle the webhook. The helpers take the `Request` itself — no client, no credentials.

```ts
import { parseWebhookEvent, verifyWebhook } from 'repo-sdk/github';

export async function POST(request: Request): Promise<Response> {
  if (!(await verifyWebhook({ request, secret: process.env.WEBHOOK_SECRET! }))) {
    return new Response('invalid signature', { status: 401 });
  }

  const event = await parseWebhookEvent(request);

  switch (event.type) {
    case 'push':
      // event.headCommitSha is undefined when the push deleted the ref.
      break;
    case 'tag_push':
      // event.ref is always fully qualified — refs/tags/v1.0.0.
      break;
    case 'release':
      break;
  }

  return new Response(null, { status: 204 });
}
```

## API at a glance

| Namespace    | Methods                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| `users`      | `me`                                                                                   |
| `namespaces` | `list` · `listAll`                                                                     |
| `repos`      | `list` · `listAll` · `get` · `downloadArchive` · `getCloneCredentials` · `getCloneUrl` |
| `commits`    | `list` · `listAll` · `get`                                                             |
| `branches`   | `list` · `listAll` · `get`                                                             |
| `tags`       | `list` · `listAll` · `get`                                                             |
| `refs`       | `resolve` · `search`                                                                   |
| `webhooks`   | `create` · `list` · `get` · `update` · `delete`                                        |

Every list returns an opaque cursor and has a `listAll` async generator that walks the pages for you. Cursors are provider-tagged and origin-checked, so a forged one cannot redirect an authenticated request. Every method accepts a `signal` for cancellation. Rate-limited requests are retried once when the provider's `Retry-After` fits the budget (10 seconds by default, configurable via `retry`).

Webhook payload helpers — `verifyWebhook` and `parseWebhookEvent` — are exported from the provider subpaths and take no credential beyond the shared secret, so they run in a handler with no client at all. `detectWebhookProvider` from the core entry identifies the sender when one endpoint serves several providers.

## Providers

| Provider     | Import                  | Notes                                                            |
| ------------ | ----------------------- | ---------------------------------------------------------------- |
| GitHub       | `repo-sdk/github`       | Personal access token or GitHub App installation auth.           |
| GitLab       | `repo-sdk/gitlab`       | Personal, group, project, or OAuth token.                        |
| Bitbucket    | `repo-sdk/bitbucket`    | Bitbucket Cloud. Atlassian API token or access token.            |
| Azure DevOps | `repo-sdk/azure-devops` | Organization-scoped. PAT or Entra ID token.                      |
| Gitea        | `repo-sdk/gitea`        | Gitea ≥ 1.20 and Forgejo.                                        |
| Generic git  | `repo-sdk/git-http`     | Any git smart-HTTP remote. Ref discovery and clone URLs only.    |
| Testing      | `repo-sdk/testing`      | Seedable in-memory provider for your test suite. No credentials. |

Every factory accepts an injectable `fetch`, and every token can be a static string or a `tokenProvider` that mints one per request and is re-invoked once on a 401. Self-hosted deployments — GitHub Enterprise Server, GitLab self-managed, Azure DevOps Server, and Gitea/Forgejo — are supported via `baseUrl`. Providers do not support the same feature set — `client.capabilities` tells you what the active one can do, and the full breakdown lives in the [capability matrix](https://repo-sdk.dev/docs/reference/capability-matrix).

## Testing

`repo-sdk/testing` ships a seedable in-memory provider you hand to `createClient` like any other — no account, no tokens, no `fetch` stubs, no throwaway repositories.

```ts
import { createClient } from 'repo-sdk';
import { createInMemoryProvider } from 'repo-sdk/testing';

const client = createClient({
  provider: createInMemoryProvider({
    repositories: { 'acme/app': { name: 'app', namespace: 'acme', defaultBranch: 'main' } },
    branches: { 'acme/app': [{ name: 'main', sha: 'c1' }] },
    commits: { 'acme/app': [{ sha: 'c1', message: 'Initial commit' }] },
  }),
});
```

It reports every capability enabled by default, and a second options argument simulates a specific provider's identity and capability gaps — so code that branches on `client.capabilities` is testable. Its page size is deliberately small, so your cursor pagination gets exercised, and `provider.state` exposes the data as plain maps for assertions.

## Errors

Every failure is a `RepoError` with a closed `code` union: `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `validation`, `unsupported`, `provider_error`, `network_error`.

```ts
import { RepoError } from 'repo-sdk';

try {
  await client.repos.downloadArchive({ repo: 'acme/app', ref: 'main', format: 'tar.gz' });
} catch (error) {
  if (error instanceof RepoError && error.code === 'unsupported') {
    // Azure DevOps serves zip only — fall back instead of failing the job.
  }
}
```

Errors also carry `provider`, `status`, `retryAfter` and `retryable`; `cause` is the underlying JS `Error`. Token values are redacted from every message, so a leaked stack trace cannot leak a credential. The deliberate exceptions are `repos.getCloneUrl`, which returns a URL with the credential embedded because that is what `git clone` needs, and `repos.getCloneCredentials`, which returns that credential next to a credential-free URL for a git credential helper — treat both as secrets.

## Runtime support

Node.js ≥ 20, Cloudflare Workers (without `nodejs_compat`), Deno, Bun, Vercel Edge, and any other runtime with `fetch`, Web Crypto and `TextEncoder`. ESM only.

## Documentation

Full documentation lives at **[repo-sdk.dev](https://repo-sdk.dev)** ([docs](https://repo-sdk.dev/docs)):

- [Quickstart](https://repo-sdk.dev/docs/quickstart)
- [Concepts](https://repo-sdk.dev/docs/concepts/client-and-providers) — clients, repositories and namespaces, capabilities, pagination, errors
- [Authentication](https://repo-sdk.dev/docs/authentication) — tokens, GitHub Apps, Entra ID, and the scopes each provider needs
- [Guides](https://repo-sdk.dev/docs/guides/resolving-refs) — resolving refs, commits, branches, tags, downloading code, managing and receiving webhooks
- [Testing](https://repo-sdk.dev/docs/testing)
- [Capability matrix](https://repo-sdk.dev/docs/reference/capability-matrix)
- [Provider support](https://repo-sdk.dev/docs/reference/provider-support)
- [Error codes](https://repo-sdk.dev/docs/reference/error-codes)

## Development

**Prerequisites:** Node >= 20.

```bash
npm install
```

| Script               | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| `npm run build`      | Build with tsdown                                               |
| `npm test`           | Run the unit + provider contract test suite                     |
| `npm run test:watch` | Run tests in watch mode                                         |
| `npm run test:live`  | Gated live provider tests (env vars documented in CONTRIBUTING) |
| `npm run typecheck`  | Type-check without emitting                                     |
| `npm run lint`       | Lint the codebase                                               |
| `npm run fmt`        | Format with prettier                                            |

Docs site:

- `npm run docs:dev` — run the docs dev server
- `npm run docs:build` — build the static site to `.blume-dist/`

Releases are automated with [release-please](https://github.com/googleapis/release-please), driven by [Conventional Commits](https://www.conventionalcommits.org/). While pre-`1.0.0`, breaking changes bump the minor version and features bump the patch version. Merging the release pull request publishes to npm. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## About

repo-sdk is developed and maintained by [Genz IT Solutions GmbH](http://genz-its.de/). It powers [Capawesome](https://capawesome.io/), a cloud platform for mobile apps.

## License

[MIT](./LICENSE)
