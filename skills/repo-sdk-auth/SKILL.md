---
name: repo-sdk-auth
description: Configure provider authentication for `repo-sdk` — GitHub token vs GitHub App (appId/privateKey/installationId), GitLab tokens, Bitbucket API token vs access token, Azure DevOps PAT vs Entra tokenProvider — plus self-hosted base URLs (GHES, self-managed GitLab, Azure DevOps Server) and `listOrganizations`. Use when setting up or debugging credentials for `github`/`gitlab`/`bitbucket`/`azureDevOps` factories, choosing an auth shape, handling expired tokens, or pointing the SDK at a self-hosted instance.
---

# repo-sdk provider auth

Each provider factory takes an `auth` object. The SDK **consumes tokens only** — it never refreshes or stores them. An expired/invalid credential surfaces as `RepoError` with `code: 'unauthorized'`; it's the caller's job to refresh and retry. Every factory also accepts an injectable `fetch` for testing.

## GitHub — `repo-sdk/github`

```ts
import { github } from 'repo-sdk/github';

// Token: classic / fine-grained PAT or OAuth token
github({ auth: { token: process.env.GITHUB_TOKEN! } });

// GitHub App: mints & refreshes installation tokens internally
github({
  auth: {
    appId: process.env.GITHUB_APP_ID!, // string | number
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!, // PEM
    installationId: process.env.GITHUB_INSTALLATION_ID, // optional — see below
  },
});

// GitHub Enterprise Server
github({ auth: { token }, baseUrl: 'https://ghe.example.com/api/v3' });
```

**GitHub App specifics:**

- `privateKey` accepts both **PKCS#8** (`BEGIN PRIVATE KEY`) and **PKCS#1** (`BEGIN RSA PRIVATE KEY`) PEMs — PKCS#1 is wrapped automatically.
- `installationId` is optional. Omit it for a **single-installation** app and the SDK auto-detects it. If the app is installed in **zero** places it throws `unauthorized`; in **multiple** places it throws `validation` ("pass installationId to select one").
- Under App auth, user-scoped resolution isn't available: `owned`/search-by-self and `/user`-based namespace listing throw `unsupported`. Installation-accessible repositories are used instead.
- Clone URLs / archive redirects use short-lived tokens; `getCloneUrl(...)` returns `expiresAt` (~1h).

## GitLab — `repo-sdk/gitlab`

```ts
import { gitlab } from 'repo-sdk/gitlab';

// gitlab.com — PAT, project/group access token, or OAuth token (all sent as Bearer)
gitlab({ auth: { token: process.env.GITLAB_TOKEN! } });

// Self-managed — pass the FULL base URL including /api/v4 (used verbatim)
gitlab({ auth: { token }, baseUrl: 'https://gitlab.example.com/api/v4' });
```

## Bitbucket Cloud — `repo-sdk/bitbucket`

```ts
import { bitbucket } from 'repo-sdk/bitbucket';

// Atlassian API token (recommended) — sent as HTTP Basic auth
bitbucket({
  auth: { email: process.env.BITBUCKET_EMAIL!, apiToken: process.env.BITBUCKET_API_TOKEN! },
});

// Workspace/repo access token or OAuth token — sent as Bearer
bitbucket({ auth: { accessToken: process.env.BITBUCKET_ACCESS_TOKEN! } });
```

Bitbucket Cloud only — there is **no `baseUrl`**. Caveat: **archive downloads require the API token (`email` + `apiToken`) auth**; with an `accessToken`, `repos.downloadArchive` throws `unsupported`.

## Azure DevOps — `repo-sdk/azure-devops`

`organization` is **required** on the factory. Auth is a PAT or an Entra callback.

```ts
import { azureDevOps, listOrganizations } from 'repo-sdk/azure-devops';

// Personal Access Token (encoded into HTTP Basic auth internally)
azureDevOps({ organization: 'my-org', auth: { pat: process.env.AZURE_PAT! } });

// Entra ID — supply a callback that mints short-lived bearer tokens
azureDevOps({
  organization: 'my-org',
  auth: { tokenProvider: async () => getEntraToken() },
});

// Azure DevOps Server — pass the collection base URL
azureDevOps({
  organization: 'DefaultCollection',
  auth: { pat },
  baseUrl: 'https://azure.example.com/tfs',
});

// Organizations live outside the org-pinned provider — list them standalone
const orgs = await listOrganizations({ pat: process.env.AZURE_PAT! });
// or: listOrganizations({ tokenProvider })  ->  { id, name, url }[]
```

With Entra `tokenProvider`, refresh happens in your callback; the SDK just calls it per request. For clone access under Entra, `getCloneUrl` returns the credential in `headers` (not embedded in `url`).

## Self-hosted base URLs at a glance

| Provider      | Self-hosted `baseUrl`                                            |
| ------------- | ---------------------------------------------------------------- |
| GitHub (GHES) | `https://ghe.example.com/api/v3`                                 |
| GitLab        | `https://gitlab.example.com/api/v4`                              |
| Azure Server  | `https://azure.example.com/tfs` (+ collection as `organization`) |
| Bitbucket     | n/a — Cloud only                                                 |

## Expired credentials

The SDK does not manage credential lifecycles. On an expired token you get:

```ts
try {
  await client.repos.list();
} catch (error) {
  if (error instanceof RepoError && error.code === 'unauthorized') {
    // refresh the token (or re-mint via your Entra tokenProvider), then retry
  }
}
```
