import { defineConfig } from 'blume';

export default defineConfig({
  title: 'repo-sdk',
  description:
    'Unified TypeScript SDK for git providers — GitHub, GitLab, Bitbucket, Azure DevOps, Gitea.',
  logo: {
    image: '/logo.svg',
    text: 'repo-sdk',
  },
  theme: {
    // Monochrome accent using Blume's own neutral palette values:
    // near-black in light mode, near-white in dark mode.
    accent: { light: 'oklch(0.145 0 0)', dark: 'oklch(0.96 0 0)' },
    radius: 'md',
    mode: 'system',
  },
  // Source repository — powers "Edit this page" links and the header repo link.
  github: {
    owner: 'capawesome-team',
    repo: 'repo-sdk',
    branch: 'main',
  },
  content: {
    sources: [
      // One source rooted at the repo: docs/ → /docs, blog/ → /blog — the
      // landing page owns /. (Separate roots per folder would break the docs
      // collection's entry ids.)
      {
        type: 'filesystem',
        root: '.',
        include: ['docs/**/*.{md,mdx}', 'blog/**/*.{md,mdx}'],
      },
      // GitHub releases become the /changelog timeline (needs GITHUB_TOKEN at build time).
      {
        type: 'github-releases',
        prefix: 'changelog',
        owner: 'capawesome-team',
        repo: 'repo-sdk',
      },
    ],
  },
  navigation: {
    // Show the GitHub link in the header (requires `github` above).
    repo: true,
    tabs: [
      { label: 'Docs', path: '/docs', icon: 'book-open' },
      { label: 'Blog', path: '/blog', icon: 'newspaper' },
      { label: 'Changelog', path: '/changelog', icon: 'history' },
    ],
  },
  // Derive per-page "Last updated" dates from git history; also emits
  // <lastmod> in sitemap.xml for crawl optimization. Needs full git history
  // at build time (fetch-depth: 0 in CI) to be accurate.
  lastModified: true,
  seo: {
    rss: {
      enabled: true,
      types: ['blog', 'changelog'],
    },
  },
  deployment: {
    // Static output (default). Placeholder site URL — the real deploy is separate.
    site: 'https://repo-sdk.dev',
  },
});
