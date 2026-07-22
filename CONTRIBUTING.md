# Contributing

Thanks for your interest in contributing to repo-sdk.

## Getting started

```bash
npm install
```

## Development

```bash
npm test           # run the unit + contract test suite
npm run test:watch # run tests in watch mode
npm run lint       # lint the codebase
npm run typecheck  # type-check without emitting
npm run build      # build with tsdown
npm run fmt     # format with prettier
```

## Test layout

- **Unit tests** — offline, against mocked `fetch` fixtures captured from real provider responses.
- **Contract tests** — the shared provider contract suite run against every provider (mocked) and the
  in-memory provider from `repo-sdk/testing`.
- **Live tests** — gated smoke tests that hit real provider accounts. They are skipped unless the
  matching environment variables are set.

### Live tests

Live tests run only when their credentials are present:

```bash
npm run test:live
```

Provide the variables for whichever providers you want to exercise (all prefixed `REPO_SDK_LIVE_`):

| Provider     | Environment variables                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| GitHub       | `REPO_SDK_LIVE_GITHUB_TOKEN`, `REPO_SDK_LIVE_GITHUB_REPO`                                            |
| GitLab       | `REPO_SDK_LIVE_GITLAB_TOKEN`, `REPO_SDK_LIVE_GITLAB_REPO`                                            |
| Bitbucket    | `REPO_SDK_LIVE_BITBUCKET_EMAIL`, `REPO_SDK_LIVE_BITBUCKET_API_TOKEN`, `REPO_SDK_LIVE_BITBUCKET_REPO` |
| Azure DevOps | `REPO_SDK_LIVE_AZURE_ORG`, `REPO_SDK_LIVE_AZURE_PAT`, `REPO_SDK_LIVE_AZURE_REPO`                     |
| Gitea        | `REPO_SDK_LIVE_GITEA_TOKEN`, `REPO_SDK_LIVE_GITEA_REPO`, `REPO_SDK_LIVE_GITEA_BASE_URL` (optional)   |

Only the providers whose variables are set will run; the rest are skipped.

## Submitting changes

Releases are automated with [release-please](https://github.com/googleapis/release-please), driven by
[Conventional Commits](https://www.conventionalcommits.org/). Write commit messages (and PR titles)
accordingly:

- `feat: …` — a new feature
- `fix: …` — a bug fix
- `feat!: …` / `fix!: …` or a `BREAKING CHANGE:` footer — a breaking change
- `docs:`, `refactor:`, `test:`, `chore:` — no release on their own

While the package is pre-`1.0.0`, breaking changes bump the minor version and features bump the patch
version, so the API can move quickly without a `1.0.0` commitment. On merge to `main`, release-please
opens (or updates) a release pull request that bumps the version and updates `CHANGELOG.md`; merging
that pull request tags the release and publishes to npm.
