---
paths:
  - 'src/**'
  - 'docs/**'
  - 'blog/**'
  - 'pages/**'
  - 'README.md'
---

# Docs drift checklist

Single-home rule: every capability-gated fact lives in exactly ONE page —
`docs/reference/capability-matrix.mdx`. `docs/reference/provider-support.mdx` covers only what the flags
cannot express (auth methods, `baseUrl`/self-hosting, the `repo` string shape, namespace discovery, where
commit filters run, pagination shape) and must never grow a per-capability row. Concept pages under
`docs/concepts/` teach the unified model code-first and LINK to reference — they never carry a twin of a
reference table. `docs/guides/webhooks-receiving.mdx` holds the docs' only full webhook handler and the
only `detectWebhookProvider` dispatch example; other pages excerpt and link. `README.md` and
`pages/index.astro` are overview surfaces, deliberately coarse: they may name a handful of representative
capability differences but must link to the matrix instead of reproducing it. Provider quirks the SDK
fully absorbs (wire formats, header names, endpoint spellings, encodings) belong in code comments only,
never in `docs/`.

When changing any of the following, update the single home in the same PR:

- A provider's `CAPABILITIES` const → its column in `docs/reference/capability-matrix.mdx`, plus that
  provider's `<AccordionItem>` in `docs/reference/provider-support.mdx` only when the change is something
  a flag cannot express. If it is one of the four flags summarized on the landing page (repo search, tag
  dates, release webhooks, tar.gz), also `capabilityRows` in `pages/index.astro`.
- A new `RepoCapabilities` field → the `TypeTable` in `docs/concepts/capabilities.mdx` AND a new row in
  `docs/reference/capability-matrix.mdx`. Both, always — and nowhere else.
- A new provider → `docs/authentication/<name>.mdx` (must include a Scopes section) and
  `docs/authentication/meta.ts`; the subpath-exports table in `docs/installation.mdx`; the factory
  `<CodeGroup>` tabs in `docs/quickstart.mdx` and `docs/concepts/client-and-providers.mdx`; new columns in
  both `docs/reference/` matrices; the inline `ProviderName` unions written out in prose and TypeTables
  (`grep -rn "azure-devops'" docs/ blog/ pages/` finds them); the README "Providers" table; the hero swap
  comment and the "Which git providers" FAQ in `pages/index.astro`; and the provider lists in `CLAUDE.md`.
- A new subpath export that is not the factory (`commitWebUrl`, `listOrganizations`,
  `listInstallationRequests`, …) → the exports column in `docs/installation.mdx`. This table has drifted
  before: the `repo-sdk/github` row still omits `listInstallationRequests` and `listUserInstallations`.
- A new `RepoClient` namespace or method → the namespace overview in
  `docs/concepts/client-and-providers.mdx`, the "API at a glance" table in `README.md`, the
  capability-gating list in `docs/concepts/capabilities.mdx` if gated, and `docs/testing.mdx` (seed
  `TypeTable` + `provider.state` shape) if the in-memory provider needs seed data to back it.
- The `RepoErrorCode` union, `codeFromStatus`, `RepoError` fields, or a provider's `mapError` →
  `docs/reference/error-codes.mdx` + the code list in the README "Errors" section. Touch
  `docs/concepts/errors.mdx` only if the short overview story itself changes.
- Webhook event mapping in `src/providers/*/webhooks.ts`, or `ParsedWebhookEvent` fields →
  `docs/guides/webhooks-receiving.mdx` + the `webhookEvents`/`webhookVerification` rows in the capability
  matrix + `blog/verify-*.mdx`. Handler `switch`es drift too — `grep -rn "tag_push" docs/ blog/ pages/
README.md`.
- `detectWebhookProvider`'s header signals → the dispatch example and closing paragraph of
  `docs/guides/webhooks-receiving.mdx`, the single home for how detection works.
- Provider factory options → `docs/authentication/<name>.mdx` + the code tabs in `docs/quickstart.mdx` +
  the hero code in `pages/index.astro` + the "Notes" column of the README "Providers" table.
- `refs.resolve` precedence or `SearchRefsParams` semantics → `docs/guides/resolving-refs.mdx` and
  `docs/guides/searching-refs.mdx` + the `refs.resolve` snippet in the README quickstart. The
  tag-shadows-branch rule is stated in both the guide and the README — keep the wording aligned.
- `RetryOptions` defaults or the pagination cursor envelope → `docs/concepts/pagination.mdx` + the
  paragraph under the README "API at a glance" table (10-second retry budget, same-origin cursor guard).
- The in-memory provider's seed shape (`src/providers/testing/index.ts`) → the seed `TypeTable` in
  `docs/testing.mdx` + the README "Testing" snippet.
- The `engines.node` floor in `package.json` → README "Runtime support" and "Development" prerequisites,
  `docs/installation.mdx`, the edge-runtime FAQ in `pages/index.astro`, and `CLAUDE.md`.

Blog posts embed runnable samples and capability claims and are never regenerated. After any rename or
signature change, `grep -rn "repo-sdk/\|client\.\|capabilities\." blog/` and fix what is stale.
