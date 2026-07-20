# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`repo-sdk` — a unified, normalized, **zero-runtime-dependency**, edge-compatible TypeScript SDK over GitHub, GitLab, Bitbucket Cloud, Azure DevOps, and Gitea REST APIs (discovery, commits, tags, branches, ref resolution, archive/clone-URL, webhooks), plus a `git-http` provider for generic git smart-HTTP remotes (ref discovery + clone URLs only; the `repo` param is the remote URL). It does **no git pack transfer or object parsing** — the only wire-protocol surface is the smart-HTTP `info/refs` advertisement the `git-http` provider reads. ESM-only, Node ≥ 20, built on raw `fetch` and Web Crypto so it runs on Cloudflare Workers and other Web-standard runtimes.

## Commands

```bash
npm test                                  # unit + provider contract tests (vitest run)
npx vitest run test/providers/github.test.ts        # single file
npx vitest run test/providers/github.test.ts -t 'name'  # single test by name
npm run test:live                         # live provider tests (env-gated, see below)
npm run typecheck
npm run lint                              # note: docs/.astro generated files produce many pre-existing errors; lint changed files directly instead
npm run build                             # tsdown → dist/
npm run docs:dev / docs:build / docs:check
```

Live tests (`test/live/*.live.test.ts`, separate `vitest.live.config.ts`) skip themselves unless `REPO_SDK_LIVE_<PROVIDER>_*` env vars are set (e.g. `REPO_SDK_LIVE_GITHUB_TOKEN` + `REPO_SDK_LIVE_GITHUB_REPO`).

**Gotcha:** `docs:build` runs Blume into `dist/` (clobbering the package build output) and then copies it to `.blume-dist`. Don't assume `dist/` holds the package build after a docs build.

## Architecture: thin adapter, fat client

- **Entry points** map 1:1 to package subpath exports: `src/index.ts` (core), `src/{github,gitlab,bitbucket,azure-devops,gitea,git-http,testing}.ts` are re-export barrels over `src/providers/<name>/`.
- **Fat client** (`src/client.ts`, `createClient`): input validation, capability gating, `listAll` async generators, bounded rate-limit retry (honors `Retry-After`), `AbortSignal` threading. **Thin adapters**: each provider implements the `RepoProvider` interface (`src/types.ts`) over the shared `HttpClient` (`src/http.ts`) with per-provider `authHeaders`/`mapError`/`secrets` hooks.
- **Capability gating over silent degradation**: providers declare `RepoCapabilities`; anything a provider can't do throws `RepoError` with `code: 'unsupported'` — never silently drop an option. Follow this when adding features.
- **Error model**: every failure is a `RepoError` (`src/errors.ts`) with a fixed code taxonomy; token values are redacted from messages via each provider's `secrets` hook. Exception by design: `getCloneUrl` returns credential-bearing URLs.
- **Normalized models** (`src/types.ts`) always carry `raw: unknown` as the provider-payload escape hatch.
- **Pagination**: opaque base64url cursors are provider-tagged envelopes (`src/pagination.ts`) with a same-origin guard (`assertSameOriginUrl`) so a forged cursor can't redirect an authenticated request — keep this guard on any new cursor-following endpoint.
- **Webhooks**: `verifyWebhook` / `parseWebhookEvent` are standalone per-subpath exports (no client needed). Verification schemes differ per provider (GitHub/Bitbucket HMAC-SHA256, GitLab shared token, Azure Basic auth or the `webhookSecretHeader` factory option); all comparisons constant-time via `src/webhooks/verify.ts`. Push payloads normalize deletion pushes (all-zero SHA) to `headCommitSha: undefined` (`src/webhooks/parse.ts`).
- **GitHub App auth** (`src/providers/github/app-auth.ts`) hand-rolls RS256 JWT signing and PKCS#1→PKCS#8 wrapping with Web Crypto — the most intricate code in the repo; touch carefully.

## Constraints

- **Zero runtime dependencies** and **no `node:*` imports** in `src/` — Web Crypto, `btoa`/`atob`, `TextEncoder`, Web streams only. This is the package's core promise; don't add a dependency to solve a problem.
- Plain vitest with the `createFetchStub` helper (`test/helpers/fetch-stub.ts`) for provider contract tests; `repo-sdk/testing` exposes an in-memory provider (page size 2 to force cursor pagination in consumer tests).
- Releases via release-please: **Conventional Commit messages determine the changelog and version** (`feat:`/`fix:`/`docs:`/etc.).
- The Blume docs site lives in `docs/` (guides, authentication, reference) — user-facing behavior changes should update the matching page; the reference section includes a per-provider capability matrix that must stay in sync with `RepoCapabilities`.
- **Docs drift checklist** — these spots hardcode API facts and have gone stale before; sweep them whenever the corresponding code changes:
  - New provider: the inline `ProviderName` unions written out in prose/TypeTables (`grep -r "azure-devops'" docs/` finds them), the subpath-exports table in `docs/installation.mdx`, the factory-import block in `docs/concepts/client-and-providers.mdx`, an `docs/authentication/<name>.mdx` page (must include a Scopes section), and this file's provider lists.
  - New client namespace or method: the namespace overview in `docs/concepts/client-and-providers.mdx`, the capability-gating list in `docs/concepts/capabilities.mdx` if gated, and the in-memory provider docs in `docs/testing.mdx` (seed TypeTable + `provider.state` shape).
  - New `RepoCapabilities` field: the TypeTable in `docs/concepts/capabilities.mdx` and `docs/reference/capability-matrix.mdx`. Capability-gated facts live ONLY in the capability matrix — don't re-add per-capability rows to `docs/reference/provider-support.mdx` (that page covers what flags can't express).
