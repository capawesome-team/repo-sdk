import { defineConfig } from 'blume';

export default defineConfig({
  title: 'repo-sdk',
  description:
    'Unified TypeScript SDK for git providers — GitHub, GitLab, Bitbucket, Azure DevOps.',
  // Mount every generated docs route under /docs; the landing page owns /.
  basePath: '/docs',
  logo: {
    image: '/logo.svg',
    text: 'repo-sdk',
  },
  theme: {
    // Neutral indigo accent, applied to both light and dark modes.
    accent: '#4f46e5',
    radius: 'md',
    mode: 'system',
  },
  // Source repository — powers "Edit this page" links and the header repo link.
  github: {
    owner: 'capawesome-team',
    repo: 'repo-sdk',
    branch: 'main',
  },
  navigation: {
    // Show the GitHub link in the header (requires `github` above).
    repo: true,
    // A single Docs tab. (basePath rewrites nav paths, so a "/" Home tab would
    // resolve to "/docs" — the brand wordmark already links back to "/".)
    tabs: [{ label: 'Docs', path: '/docs', icon: 'book-open' }],
  },
  deployment: {
    // Static output (default). Placeholder site URL — the real deploy is separate.
    site: 'https://repo-sdk.dev',
  },
});
