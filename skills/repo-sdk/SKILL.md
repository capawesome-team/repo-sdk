---
name: repo-sdk
description: Build code that talks to GitHub, GitLab, Bitbucket Cloud, and Azure DevOps through one unified TypeScript API with `repo-sdk`. Use when working in a project that depends on `repo-sdk`, when calling `createClient`, importing provider factories (`repo-sdk/github`, `repo-sdk/gitlab`, `repo-sdk/bitbucket`, `repo-sdk/azure-devops`), listing namespaces/repos/commits/tags, resolving refs, paginating with `list`/`listAll`, downloading archives or clone URLs, or handling `RepoError` and the provider capability matrix. For webhooks, auth, or testing see the `repo-sdk-webhooks`, `repo-sdk-auth`, and `repo-sdk-testing` skills.
---

# repo-sdk

`repo-sdk` is one normalized TypeScript API over **GitHub, GitLab, Bitbucket Cloud, and Azure DevOps**. Write your discovery, commit, tag, download, and webhook logic once instead of four times. Zero runtime dependencies (raw `fetch` + Web Crypto), edge-compatible (Node ≥ 20, Cloudflare Workers, Web-standard runtimes).

## Install & imports

```bash
npm install repo-sdk
```

The client lives at the package root; each provider factory is a subpath. Import only what you use.

```ts
import { createClient, RepoError } from 'repo-sdk';
import { github } from 'repo-sdk/github';
import { gitlab } from 'repo-sdk/gitlab';
import { bitbucket } from 'repo-sdk/bitbucket';
import { azureDevOps } from 'repo-sdk/azure-devops';
```

## Create a client

`createClient` takes a `provider` (from a factory) and returns a `RepoClient`. Swapping providers is the only change — the rest of your code stays the same.

```ts
const client = createClient({
  provider: github({ auth: { token: process.env.GITHUB_TOKEN! } }),
});

// Provider factories + their auth (see the `repo-sdk-auth` skill for depth):
github({ auth: { token } }); // or GitHub App
gitlab({ auth: { token } }); // + baseUrl for self-managed
bitbucket({ auth: { email, apiToken } }); // or { accessToken }
azureDevOps({ organization: 'my-org', auth: { pat } }); // or { tokenProvider }
```

## The `repo` string

Every repo-targeting call takes a `repo` string in the provider's native path form:

| Provider     | `repo` format                              |
| ------------ | ------------------------------------------ |
| GitHub       | `owner/name`                               |
| GitLab       | `group/subgroup/project` **or** numeric id |
| Bitbucket    | `workspace/repo_slug`                      |
| Azure DevOps | `project/repository` (org set on factory)  |

## Client namespaces

`client` exposes `providerName`, `capabilities`, and five namespaces:

```ts
// namespaces — orgs / groups / workspaces / projects the token can see
const { data: namespaces } = await client.namespaces.list();

// repos
const repo = await client.repos.get({ repo: 'capawesome-team/repo-sdk' });
repo.defaultBranch; // normalized
repo.raw; // untouched provider payload (escape hatch)
const { data: repos } = await client.repos.list({ namespace: 'capawesome-team' });

// commits — resolve a ref (branch/tag/SHA) to one commit, or list a history
const head = await client.commits.get({ repo: 'capawesome-team/repo-sdk', ref: 'main' });
console.log(head.sha, head.message);
const { data: commits } = await client.commits.list({
  repo: 'capawesome-team/repo-sdk',
  ref: 'main',
  limit: 20,
});

// tags
const { data: tags } = await client.tags.list({ repo: 'capawesome-team/repo-sdk' });

// webhooks — see the `repo-sdk-webhooks` skill
```

Every result is normalized (`Namespace`, `Repository`, `Commit`, `Tag`, `Webhook`) and carries `raw` for provider-specific fields.

## Pagination: `list` vs `listAll`

`list` returns one page as `{ data, cursor }`; pass the opaque `cursor` back for the next page. `listAll` is an async iterator that follows cursors for you.

```ts
const { data, cursor } = await client.repos.list({ namespace: 'capawesome-team' });
if (cursor) {
  await client.repos.list({ namespace: 'capawesome-team', cursor });
}

for await (const repo of client.repos.listAll({ namespace: 'capawesome-team' })) {
  console.log(repo.path);
}
```

## Repository download

```ts
// Archive as a stream
const archive = await client.repos.downloadArchive({
  repo: 'capawesome-team/repo-sdk',
  ref: 'v1.0.0',
  format: 'zip', // 'zip' | 'tar.gz'
});
// archive: { stream: ReadableStream<Uint8Array>, contentType?, filename? }

// Authenticated clone URL — treat as a SECRET, never log it
const clone = await client.repos.getCloneUrl({ repo: 'capawesome-team/repo-sdk' });
// clone: { url, headers?, expiresAt? }
```

`getCloneUrl` embeds credentials in `url`. `expiresAt` is set when the embedded token expires (e.g. GitHub App, ~1h). For Azure DevOps + Entra auth the credential is returned in `headers` (pass via `git -c http.extraheader`) instead of the URL.

## Errors: `RepoError`

Every failure throws a `RepoError`. Secrets are redacted from messages; rate-limit info is surfaced.

```ts
try {
  await client.repos.get({ repo: 'capawesome-team/repo-sdk' });
} catch (error) {
  if (error instanceof RepoError) {
    error.code; // 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited'
    // | 'validation' | 'unsupported' | 'provider_error' | 'network_error'
    error.provider; // 'github' | 'gitlab' | 'bitbucket' | 'azure-devops'
    error.status; // HTTP status, when available
    error.retryable; // whether retrying may succeed (rate_limited, network_error, 5xx)
    error.retryAfter; // seconds, when the provider sent Retry-After
  }
}
```

The client auto-performs one bounded retry on `rate_limited` when `Retry-After` is small. Tune it:

```ts
createClient({ provider, retry: { rateLimit: true, maxRetryAfterSeconds: 10 } });
```

## Capabilities: why some ops throw `unsupported`

Providers differ. Each exposes a `capabilities` object (also `client.capabilities`). Instead of silently dropping an unsupported option, the client throws `RepoError` with `code: 'unsupported'`.

```ts
client.capabilities.repoSearch; // boolean — repos.list({ query })
client.capabilities.ownedRepoFilter; // boolean — repos.list({ owned })
client.capabilities.tagDates; // boolean — Tag.date populated
client.capabilities.webhookEvents; // ('push' | 'tag_push' | 'release')[]
client.capabilities.webhookVerification; // 'hmac-sha256' | 'shared-token' | 'basic-auth'
client.capabilities.archiveFormats; // ('zip' | 'tar.gz')[]
```

| Capability             | GitHub           | GitLab           | Bitbucket   | Azure DevOps |
| ---------------------- | ---------------- | ---------------- | ----------- | ------------ |
| Tag dates              | ✗                | ✓                | ✓           | ✗            |
| Repo search (`query`)  | ✓                | ✓                | ✓           | ✗            |
| Owned filter (`owned`) | ✓                | ✓                | ✓           | ✗            |
| Webhook events         | push/tag/release | push/tag/release | push/tag    | push/tag     |
| Archive formats        | zip, tar.gz      | zip, tar.gz      | zip, tar.gz | zip          |

Guard optional features before calling, or catch the `unsupported` error:

```ts
if (client.capabilities.repoSearch) {
  await client.repos.list({ query: 'sdk', namespace: 'capawesome-team' });
}
```

## Full documentation

This is a high-level overview. For the complete, authoritative API, read the project docs and `README.md` in the installed package, or the docs site linked from the repository. The public types (`createClient`, `RepoClient`, `RepoError`, `Repository`, `Commit`, `Tag`, `Namespace`, `Webhook`, `RepoCapabilities`, `RepoProvider`, …) are all exported from `repo-sdk`.
