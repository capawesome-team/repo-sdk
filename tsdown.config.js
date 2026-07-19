import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/github.ts',
    'src/gitlab.ts',
    'src/bitbucket.ts',
    'src/azure-devops.ts',
    'src/gitea.ts',
    'src/testing.ts',
  ],
  format: 'esm',
  platform: 'neutral',
  dts: true,
});
