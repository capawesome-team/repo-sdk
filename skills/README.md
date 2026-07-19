# repo-sdk agent skills

Installable [agent skills](https://agentskills.io) for [`repo-sdk`](https://www.npmjs.com/package/repo-sdk) — one unified TypeScript API over GitHub, GitLab, Bitbucket Cloud, and Azure DevOps. They give a coding agent accurate, high-signal context for building and testing repo-sdk integrations, so it uses the real API instead of guessing.

## Skills

| Skill               | What it covers                                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo-sdk`          | Core usage: `createClient`, provider factories, the client namespaces (`namespaces`/`repos`/`commits`/`tags`/`webhooks`), `list` vs `listAll` pagination, downloads, `RepoError`, and the capability model. |
| `repo-sdk-webhooks` | Registering & managing hooks (`client.webhooks.*`), normalized events and per-provider support, plus the standalone `verifyWebhook` / `parseWebhookEvent` receivers and per-provider verification.          |
| `repo-sdk-auth`     | Provider authentication: GitHub token vs App, GitLab tokens, Bitbucket API token vs access token, Azure DevOps PAT vs Entra `tokenProvider`, self-hosted base URLs, and `listOrganizations`.                |
| `repo-sdk-testing`  | Testing integrations with the in-memory provider from `repo-sdk/testing` (`createInMemoryProvider`).                                                                                                        |

## Install

Install all skills into your agent (e.g. Claude Code) with the [`skills`](https://www.npmjs.com/package/skills) CLI:

```bash
npx skills add capawesome-team/repo-sdk
```

Install a single skill with `--skill`:

```bash
npx skills add capawesome-team/repo-sdk --skill repo-sdk
```

## How they work

Each skill is a folder under `skills/` containing a `SKILL.md` (YAML frontmatter + Markdown body). Your agent loads a skill when its trigger-rich `description` matches the task at hand, then follows the body.

Skills run with your agent's full permissions — review a skill's contents before installing it.
