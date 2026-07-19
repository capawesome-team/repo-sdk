# repo-sdk

[![npm version](https://img.shields.io/npm/v/repo-sdk)](https://www.npmjs.com/package/repo-sdk)
[![npm downloads](https://img.shields.io/npm/dm/repo-sdk)](https://www.npmjs.com/package/repo-sdk)
[![license](https://img.shields.io/npm/l/repo-sdk)](https://github.com/capawesome-team/repo-sdk/blob/main/LICENSE)

A unified, normalized, zero-dependency, edge-compatible TypeScript SDK over GitHub, GitLab, Bitbucket Cloud, Azure DevOps, and Gitea. Write your discovery, commit, tag, download, and webhook logic once against one normalized API — built on raw `fetch` and Web Crypto, so it runs on Node, Cloudflare Workers, and other Web-standard runtimes.

## Installation

```bash
npm install repo-sdk
```

## Quickstart

```ts
import { createClient } from 'repo-sdk';
import { github } from 'repo-sdk/github';

const client = createClient({
  provider: github({ auth: { token: process.env.GITHUB_TOKEN! } }),
});

// Resolve a ref (branch, tag, or SHA) to a single commit.
const head = await client.commits.get({ repo: 'capawesome-team/repo-sdk', ref: 'main' });
console.log(head.sha, head.message);

// List commits on a branch.
const { data: commits } = await client.commits.list({
  repo: 'capawesome-team/repo-sdk',
  ref: 'main',
  limit: 20,
});
```

Switching providers means swapping the `provider` — the rest of your code stays the same.

## Documentation

Full documentation lives at **[repo-sdk.dev](https://repo-sdk.dev)** ([docs](https://repo-sdk.dev/docs)):

- [Quickstart](https://repo-sdk.dev/docs/quickstart)
- [Authentication](https://repo-sdk.dev/docs/authentication)
- [Guides](https://repo-sdk.dev/docs/guides)
- [API Reference](https://repo-sdk.dev/docs/reference)

## Providers

| Provider     | Import                  | Notes                              |
| ------------ | ----------------------- | ---------------------------------- |
| GitHub       | `repo-sdk/github`       | Token and GitHub App auth          |
| GitLab       | `repo-sdk/gitlab`       | PAT, group/project, or OAuth token |
| Bitbucket    | `repo-sdk/bitbucket`    | Bitbucket Cloud                    |
| Azure DevOps | `repo-sdk/azure-devops` | PAT or Entra ID                    |
| Gitea        | `repo-sdk/gitea`        | Gitea ≥ 1.20 and Forgejo           |

Self-hosted deployments — GitHub Enterprise Server, GitLab self-managed, Azure DevOps Server, and Gitea/Forgejo instances — are supported via `baseUrl`.

## Development

**Prerequisites:** Node >= 20.

```bash
npm install
```

| Script               | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| `npm run build`      | Build with tsdown                                               |
| `npm test`           | Run the unit + contract test suite                              |
| `npm run test:watch` | Run tests in watch mode                                         |
| `npm run test:live`  | Gated live provider tests (env vars documented in CONTRIBUTING) |
| `npm run typecheck`  | Type-check without emitting                                     |
| `npm run lint`       | Lint the codebase                                               |
| `npm run format`     | Format with prettier                                            |

Docs site:

- `npm run docs:dev` — run the docs dev server
- `npm run docs:build` — build the static site to `.blume-dist/`

Releases are automated with [release-please](https://github.com/googleapis/release-please), driven by [Conventional Commits](https://www.conventionalcommits.org/). While pre-`1.0.0`, breaking changes bump the minor version and features bump the patch version. Merging the release pull request publishes to npm. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## About

repo-sdk is developed and maintained by [Genz IT Solutions GmbH](http://genz-its.de/). It powers [Capawesome](https://capawesome.io/), a cloud platform for mobile apps.

## License

[MIT](./LICENSE)
