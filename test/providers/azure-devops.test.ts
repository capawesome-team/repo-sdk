import { describe, expect, it } from 'vitest';
import {
  azureDevOps,
  commitWebUrl,
  listOrganizations,
  parseWebhookEvent,
  verifyWebhook,
} from '../../src/azure-devops.ts';
import { RepoError } from '../../src/errors.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const PAT = 'azdo-pat-token';
const ORG = 'contoso';

function setup(handler: StubHandler, baseUrl?: string) {
  const stub = createFetchStub(handler);
  const provider = azureDevOps({
    organization: ORG,
    auth: { pat: PAT },
    fetch: stub.fetch,
    baseUrl,
  });
  return { provider, stub };
}

async function expectRepoError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable('expected RepoError');
  } catch (error) {
    expect(error).toBeInstanceOf(RepoError);
    expect((error as RepoError).code).toBe(code);
  }
}

const repoPayload = {
  id: 'repo-guid-1',
  name: 'repo-sdk',
  project: { id: 'project-guid-1', name: 'core', visibility: 'private' },
  defaultBranch: 'refs/heads/main',
  remoteUrl: 'https://dev.azure.com/contoso/core/_git/repo-sdk',
  sshUrl: 'git@ssh.dev.azure.com:v3/contoso/core/repo-sdk',
  webUrl: 'https://dev.azure.com/contoso/core/_git/repo-sdk',
};

describe('authentication', () => {
  it('encodes a PAT as Basic auth with an empty username', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }));
    await provider.getRepository({ repo: 'core/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe(`Basic ${btoa(':' + PAT)}`);
  });

  it('uses a Bearer token from a tokenProvider', async () => {
    const stub = createFetchStub(() => ({ json: repoPayload }));
    const provider = azureDevOps({
      organization: ORG,
      auth: { tokenProvider: () => Promise.resolve('entra-token') },
      fetch: stub.fetch,
    });
    await provider.getRepository({ repo: 'core/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer entra-token');
  });

  it('uses an OAuth access token as a Bearer token', async () => {
    const stub = createFetchStub(() => ({ json: repoPayload }));
    const provider = azureDevOps({
      organization: ORG,
      auth: { accessToken: 'oauth-access-token' },
      fetch: stub.fetch,
    });
    await provider.getRepository({ repo: 'core/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer oauth-access-token');
  });
});

describe('api-version', () => {
  it('is present on every request', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/refs')) return { json: { count: 0, value: [] } };
      if (url.pathname.endsWith('/commits')) return { json: { count: 0, value: [] } };
      return { json: repoPayload };
    });
    await provider.getRepository({ repo: 'core/repo-sdk' });
    await provider.listCommits({ repo: 'core/repo-sdk' });
    await provider.listTags({ repo: 'core/repo-sdk' });
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      expect(new URL(request.url).searchParams.get('api-version')).toBe('7.1');
    }
  });
});

describe('repo parsing', () => {
  it('splits project/repository and encodes both segments', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }));
    await provider.getRepository({ repo: 'my project/my repo' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/contoso/my%20project/_apis/git/repositories/my%20repo',
    );
  });

  it('splits only at the first slash', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }));
    await provider.getRepository({ repo: 'proj/group/repo' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/contoso/proj/_apis/git/repositories/group%2Frepo',
    );
  });

  it('raises a validation error when the repo has no slash', async () => {
    const { provider } = setup(() => ({ json: repoPayload }));
    await expectRepoError(provider.getRepository({ repo: 'norepo' }), 'validation');
  });
});

describe('listNamespaces', () => {
  it('round-trips the continuation-token cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('continuationToken')) {
        return { json: { count: 1, value: [{ id: 'p2', name: 'proj2', visibility: 'private' }] } };
      }
      return {
        json: { count: 1, value: [{ id: 'p1', name: 'proj1', visibility: 'public' }] },
        headers: { 'x-ms-continuationtoken': 'ct-123' },
      };
    });

    const first = await provider.listNamespaces({ limit: 1 });
    expect(first.data[0]).toMatchObject({
      id: 'p1',
      slug: 'proj1',
      name: 'proj1',
      kind: 'project',
    });
    expect(first.cursor).toBeDefined();
    expect(new URL(stub.requests[0]!.url).searchParams.get('$top')).toBe('1');

    const second = await provider.listNamespaces({ cursor: first.cursor });
    expect(second.data[0]?.slug).toBe('proj2');
    expect(second.cursor).toBeUndefined();
    expect(new URL(stub.requests[1]!.url).searchParams.get('continuationToken')).toBe('ct-123');
  });
});

describe('listRepositories', () => {
  it('queries org-wide when no namespace is given and returns no cursor', async () => {
    const { provider, stub } = setup(() => ({ json: { count: 1, value: [repoPayload] } }));
    const page = await provider.listRepositories({});
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/contoso/_apis/git/repositories');
    expect(page.cursor).toBeUndefined();
    expect(page.data[0]).toMatchObject({
      id: 'repo-guid-1',
      path: 'core/repo-sdk',
      namespace: 'core',
      defaultBranch: 'main',
      private: true,
      urls: {
        web: repoPayload.webUrl,
        cloneHttp: repoPayload.remoteUrl,
        cloneSsh: repoPayload.sshUrl,
      },
    });
  });

  it('scopes to the project path when a namespace is given', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        count: 1,
        value: [{ ...repoPayload, project: { id: 'pg', name: 'core', visibility: 'public' } }],
      },
    }));
    const page = await provider.listRepositories({ namespace: 'core' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/contoso/core/_apis/git/repositories');
    expect(page.data[0]?.private).toBe(false);
  });

  it('leaves defaultBranch undefined on empty repositories', async () => {
    const { provider } = setup(() => ({
      json: {
        count: 1,
        value: [{ ...repoPayload, defaultBranch: undefined }],
      },
    }));
    const page = await provider.listRepositories({});
    expect(page.data[0]?.defaultBranch).toBeUndefined();
  });

  it('honors limit client-side since the endpoint is unpaginated', async () => {
    const { provider } = setup(() => ({
      json: {
        count: 3,
        value: [
          { ...repoPayload, id: 'r1', name: 'a' },
          { ...repoPayload, id: 'r2', name: 'b' },
          { ...repoPayload, id: 'r3', name: 'c' },
        ],
      },
    }));
    const page = await provider.listRepositories({ limit: 2 });
    expect(page.data.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(page.cursor).toBeUndefined();
  });
});

describe('getCommit', () => {
  const commitPayload = {
    commitId: 'a'.repeat(40),
    comment: 'initial',
    author: { name: 'Robin', email: 'robin@example.com', date: '2026-01-15T10:00:00Z' },
    committer: { name: 'Robin', email: 'robin@example.com', date: '2026-01-15T10:00:00Z' },
    parents: ['b'.repeat(40)],
    remoteUrl: 'https://dev.azure.com/contoso/core/_git/repo-sdk/commit/aaa',
  };

  it('fetches a 40-hex SHA directly', async () => {
    const sha = 'a'.repeat(40);
    const { provider, stub } = setup(() => ({ json: commitPayload }));
    const commit = await provider.getCommit({ repo: 'core/repo-sdk', ref: sha });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      `/contoso/core/_apis/git/repositories/repo-sdk/commits/${sha}`,
    );
    expect(commit).toMatchObject({ sha, message: 'initial', parents: ['b'.repeat(40)] });
    expect(commit.author.date).toBeInstanceOf(Date);
    expect(commit.url).toBe(commitPayload.remoteUrl);
  });

  it('resolves a branch ref through itemVersion', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('searchCriteria.itemVersion.versionType')).toBe('branch');
      return { json: { count: 1, value: [commitPayload] } };
    });
    const commit = await provider.getCommit({ repo: 'core/repo-sdk', ref: 'main' });
    expect(commit.sha).toBe('a'.repeat(40));
    expect(new URL(stub.requests[0]!.url).searchParams.get('searchCriteria.$top')).toBe('1');
  });

  it('retries as a tag when the branch lookup returns empty', async () => {
    const { provider, stub } = setup((request) => {
      const type = new URL(request.url).searchParams.get('searchCriteria.itemVersion.versionType');
      if (type === 'branch') return { json: { count: 0, value: [] } };
      return { json: { count: 1, value: [commitPayload] } };
    });
    const commit = await provider.getCommit({ repo: 'core/repo-sdk', ref: 'v1.0.0' });
    expect(commit.sha).toBe('a'.repeat(40));
    expect(stub.requests).toHaveLength(2);
    expect(
      new URL(stub.requests[1]!.url).searchParams.get('searchCriteria.itemVersion.versionType'),
    ).toBe('tag');
  });

  it('throws not_found when neither branch nor tag resolves', async () => {
    const { provider } = setup(() => ({ json: { count: 0, value: [] } }));
    await expectRepoError(provider.getCommit({ repo: 'core/repo-sdk', ref: 'ghost' }), 'not_found');
  });

  it('rethrows a non-not_found error from the ref lookup instead of masking it', async () => {
    const { provider, stub } = setup(() => ({ status: 401, json: { message: 'expired token' } }));
    await expectRepoError(
      provider.getCommit({ repo: 'core/repo-sdk', ref: 'main' }),
      'unauthorized',
    );
    // Must fail fast on the branch attempt; never fall through to a tag lookup.
    expect(stub.requests).toHaveLength(1);
  });

  it('falls through from an empty branch to a matching tag', async () => {
    const { provider, stub } = setup((request) => {
      const type = new URL(request.url).searchParams.get('searchCriteria.itemVersion.versionType');
      if (type === 'branch') return { json: { count: 0, value: [] } };
      return { json: { count: 1, value: [commitPayload] } };
    });
    const commit = await provider.getCommit({ repo: 'core/repo-sdk', ref: 'v2.0.0' });
    expect(commit.sha).toBe('a'.repeat(40));
    expect(stub.requests).toHaveLength(2);
  });
});

describe('listCommits', () => {
  const commitPayload = {
    commitId: 'c'.repeat(40),
    comment: 'msg',
    author: { name: 'A', email: 'a@x.com', date: '2026-01-15T10:00:00Z' },
    committer: { name: 'A', email: 'a@x.com', date: '2026-01-15T10:00:00Z' },
    parents: [],
  };

  it('passes $top and paginates via a $skip cursor', async () => {
    const { provider, stub } = setup(() => ({
      json: { count: 2, value: [commitPayload, { ...commitPayload, commitId: 'd'.repeat(40) }] },
    }));
    const page = await provider.listCommits({ repo: 'core/repo-sdk', ref: 'main', limit: 2 });
    const url = new URL(stub.requests[0]!.url);
    expect(url.searchParams.get('searchCriteria.$top')).toBe('2');
    expect(url.searchParams.get('searchCriteria.itemVersion.version')).toBe('main');
    expect(url.searchParams.get('searchCriteria.itemVersion.versionType')).toBe('branch');
    expect(page.cursor).toBeDefined();

    await provider.listCommits({ repo: 'core/repo-sdk', limit: 2, cursor: page.cursor });
    expect(new URL(stub.requests[1]!.url).searchParams.get('searchCriteria.$skip')).toBe('2');
  });

  it('omits the cursor when fewer than $top rows are returned', async () => {
    const { provider } = setup(() => ({ json: { count: 1, value: [commitPayload] } }));
    const page = await provider.listCommits({ repo: 'core/repo-sdk', limit: 2 });
    expect(page.cursor).toBeUndefined();
  });
});

describe('listTags', () => {
  it('prefers peeledObjectId and marks annotated tags', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        count: 2,
        value: [
          { name: 'refs/tags/v1.0.0', objectId: 'tagobj', peeledObjectId: 'commitsha' },
          { name: 'refs/tags/v0.9.0', objectId: 'lightsha' },
        ],
      },
    }));
    const page = await provider.listTags({ repo: 'core/repo-sdk' });
    const url = new URL(stub.requests[0]!.url);
    expect(url.searchParams.get('filter')).toBe('tags/');
    expect(url.searchParams.get('peelTags')).toBe('true');
    expect(page.data[0]).toMatchObject({ name: 'v1.0.0', sha: 'commitsha', isAnnotated: true });
    expect(page.data[1]).toMatchObject({ name: 'v0.9.0', sha: 'lightsha', isAnnotated: false });
  });
});

describe('downloadArchive', () => {
  it('sends the expected query params and Accept header', async () => {
    const { provider, stub } = setup(() => ({
      body: 'ZIPDATA',
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename=repo-sdk.zip',
      },
    }));
    const archive = await provider.downloadArchive({ repo: 'core/repo-sdk', ref: 'main' });
    const request = stub.requests[0]!;
    const url = new URL(request.url);
    expect(url.pathname).toBe('/contoso/core/_apis/git/repositories/repo-sdk/items');
    expect(url.searchParams.get('path')).toBe('/');
    expect(url.searchParams.get('versionDescriptor.version')).toBe('main');
    expect(url.searchParams.get('versionDescriptor.versionType')).toBe('branch');
    expect(url.searchParams.get('resolveLfs')).toBe('true');
    expect(url.searchParams.get('$format')).toBe('zip');
    expect(url.searchParams.get('download')).toBe('true');
    expect(request.headers.accept).toBe('application/zip');
    expect(archive.contentType).toBe('application/zip');
    expect(archive.filename).toBe('repo-sdk.zip');
    expect(await new Response(archive.stream).text()).toBe('ZIPDATA');
  });

  it('retries as a tag after a not_found on the branch attempt', async () => {
    const { provider, stub } = setup((request) => {
      const type = new URL(request.url).searchParams.get('versionDescriptor.versionType');
      if (type === 'branch') return { status: 404, json: { message: 'nf' } };
      return { body: 'ZIP', headers: { 'content-type': 'application/zip' } };
    });
    const archive = await provider.downloadArchive({ repo: 'core/repo-sdk', ref: 'v1.0.0' });
    expect(await new Response(archive.stream).text()).toBe('ZIP');
    expect(new URL(stub.requests[1]!.url).searchParams.get('versionDescriptor.versionType')).toBe(
      'tag',
    );
  });
});

describe('getCloneUrl', () => {
  it('embeds the PAT for the default host', async () => {
    const { provider } = setup(() => ({ json: {} }));
    const clone = await provider.getCloneUrl({ repo: 'core/repo-sdk' });
    expect(clone.url).toBe(`https://pat:${PAT}@dev.azure.com/contoso/core/_git/repo-sdk`);
    expect(clone.headers).toBeUndefined();
    expect(clone.expiresAt).toBeUndefined();
  });

  it('embeds an OAuth access token with the oauth2 username', async () => {
    const stub = createFetchStub(() => ({ json: {} }));
    const provider = azureDevOps({
      organization: ORG,
      auth: { accessToken: 'oauth-access-token' },
      fetch: stub.fetch,
    });
    const clone = await provider.getCloneUrl({ repo: 'core/repo-sdk' });
    expect(clone.url).toBe(
      'https://oauth2:oauth-access-token@dev.azure.com/contoso/core/_git/repo-sdk',
    );
    expect(clone.headers).toBeUndefined();
  });

  it('returns Entra tokens via headers instead of embedding them', async () => {
    const stub = createFetchStub(() => ({ json: {} }));
    const provider = azureDevOps({
      organization: ORG,
      auth: { tokenProvider: () => Promise.resolve('entra-token') },
      fetch: stub.fetch,
    });
    const clone = await provider.getCloneUrl({ repo: 'core/repo-sdk' });
    expect(clone.url).toBe('https://dev.azure.com/contoso/core/_git/repo-sdk');
    expect(clone.headers).toEqual({ Authorization: 'Bearer entra-token' });
  });
});

describe('webhooks', () => {
  const subscription = {
    id: 'sub-1',
    eventType: 'git.push',
    status: 'enabled',
    publisherInputs: { projectId: 'project-guid-1', repository: 'repo-guid-1' },
    consumerInputs: { url: 'https://example.com/hook' },
  };

  it('resolves the repo GUID and builds the service-hook body', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/git/repositories/repo-sdk')) return { json: repoPayload };
      return { json: subscription };
    });
    const webhook = await provider.createWebhook({
      repo: 'core/repo-sdk',
      url: 'https://example.com/hook',
      events: ['push', 'tag_push'],
      secret: 'shh',
    });
    const create = stub.requests.find((r) => r.method === 'POST')!;
    const body = JSON.parse(create.body!);
    expect(body.publisherId).toBe('tfs');
    expect(body.eventType).toBe('git.push');
    expect(body.consumerId).toBe('webHooks');
    expect(body.consumerActionId).toBe('httpRequest');
    expect(body.publisherInputs).toEqual({
      projectId: 'project-guid-1',
      repository: 'repo-guid-1',
    });
    expect(body.consumerInputs).toMatchObject({
      url: 'https://example.com/hook',
      basicAuthUsername: 'repo-sdk',
      basicAuthPassword: 'shh',
    });
    expect(webhook).toMatchObject({ id: 'sub-1', events: ['push', 'tag_push'], active: true });
  });

  it('registers the secret in a custom header when webhookSecretHeader is set', async () => {
    const stub = createFetchStub((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/git/repositories/repo-sdk')) return { json: repoPayload };
      return { json: subscription };
    });
    const provider = azureDevOps({
      organization: ORG,
      auth: { pat: PAT },
      fetch: stub.fetch,
      webhookSecretHeader: 'X-Capawesome-Secret',
    });
    await provider.createWebhook({
      repo: 'core/repo-sdk',
      url: 'https://example.com/hook',
      events: ['push', 'tag_push'],
      secret: 'shh',
    });
    const body = JSON.parse(stub.requests.find((r) => r.method === 'POST')!.body!);
    expect(body.consumerInputs).toEqual({
      url: 'https://example.com/hook',
      httpHeaders: 'X-Capawesome-Secret:shh',
    });
  });

  it('rejects a strict event subset that Azure cannot deliver on its own', async () => {
    const { provider, stub } = setup(() => ({ json: subscription }));
    await expectRepoError(
      provider.createWebhook({
        repo: 'core/repo-sdk',
        url: 'https://example.com/hook',
        events: ['tag_push'],
      }),
      'unsupported',
    );
    // Validation happens before any network call.
    expect(stub.requests).toHaveLength(0);
  });

  it('registers a disabled subscription when active is false', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/git/repositories/repo-sdk')) return { json: repoPayload };
      return { json: { ...subscription, status: 'disabledByUser' } };
    });
    const webhook = await provider.createWebhook({
      repo: 'core/repo-sdk',
      url: 'https://example.com/hook',
      events: ['push', 'tag_push'],
      active: false,
    });
    const create = stub.requests.find((r) => r.method === 'POST')!;
    expect(JSON.parse(create.body!).status).toBe('disabledByUser');
    expect(webhook.active).toBe(false);
  });

  it('filters the subscription list client-side by repo GUID', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/git/repositories/repo-sdk')) return { json: repoPayload };
      return {
        json: {
          count: 2,
          value: [
            subscription,
            {
              ...subscription,
              id: 'sub-other',
              publisherInputs: { projectId: 'x', repository: 'other-guid' },
            },
          ],
        },
      };
    });
    const page = await provider.listWebhooks({ repo: 'core/repo-sdk' });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.id).toBe('sub-1');
    expect(page.cursor).toBeUndefined();
  });

  it('maps active=false to disabledByUser on update', async () => {
    const { provider, stub } = setup((request) => {
      if (request.method === 'PUT') {
        return { json: { ...subscription, status: 'disabledByUser' } };
      }
      return { json: subscription };
    });
    const webhook = await provider.updateWebhook({
      repo: 'core/repo-sdk',
      id: 'sub-1',
      active: false,
    });
    const put = stub.requests.find((r) => r.method === 'PUT')!;
    expect(JSON.parse(put.body!).status).toBe('disabledByUser');
    expect(webhook.active).toBe(false);
  });

  it('refuses to update a basic-auth hook without re-supplying the secret', async () => {
    const authedSub = {
      ...subscription,
      consumerInputs: { url: 'https://example.com/hook', basicAuthUsername: 'repo-sdk' },
    };
    const { provider, stub } = setup(() => ({ json: authedSub }));
    await expectRepoError(
      provider.updateWebhook({ repo: 'core/repo-sdk', id: 'sub-1', url: 'https://new/hook' }),
      'validation',
    );
    // The subscription is read, but no PUT is attempted.
    expect(stub.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('re-applies the secret on update so Azure does not wipe it', async () => {
    const authedSub = {
      ...subscription,
      consumerInputs: { url: 'https://example.com/hook', basicAuthUsername: 'repo-sdk' },
    };
    const { provider, stub } = setup((request) => {
      if (request.method === 'PUT') return { json: authedSub };
      return { json: authedSub };
    });
    await provider.updateWebhook({ repo: 'core/repo-sdk', id: 'sub-1', secret: 'rotated' });
    const put = stub.requests.find((r) => r.method === 'PUT')!;
    const body = JSON.parse(put.body!);
    expect(body.consumerInputs.basicAuthUsername).toBe('repo-sdk');
    expect(body.consumerInputs.basicAuthPassword).toBe('rotated');
  });

  it('updates a hook with no basic auth without requiring a secret', async () => {
    const { provider, stub } = setup((request) => {
      if (request.method === 'PUT') return { json: subscription };
      return { json: subscription };
    });
    await provider.updateWebhook({ repo: 'core/repo-sdk', id: 'sub-1', url: 'https://new/hook' });
    const put = stub.requests.find((r) => r.method === 'PUT')!;
    expect(JSON.parse(put.body!).consumerInputs.url).toBe('https://new/hook');
  });

  it('deletes a subscription', async () => {
    const { provider, stub } = setup(() => ({ status: 204 }));
    await provider.deleteWebhook({ repo: 'core/repo-sdk', id: 'sub-1' });
    expect(stub.requests[0]!.method).toBe('DELETE');
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/contoso/_apis/hooks/subscriptions/sub-1',
    );
  });
});

describe('error mapping', () => {
  it('maps a 203 HTML response to unauthorized', async () => {
    const { provider } = setup(() => ({
      status: 203,
      headers: { 'content-type': 'text/html' },
      body: '<html>sign in</html>',
    }));
    await expectRepoError(provider.getRepository({ repo: 'core/repo-sdk' }), 'unauthorized');
  });

  it('surfaces the body message on errors', async () => {
    const { provider } = setup(() => ({ status: 404, json: { message: 'TF401019' } }));
    try {
      await provider.getRepository({ repo: 'core/repo-sdk' });
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect((error as RepoError).message).toBe('TF401019');
    }
  });
});

describe('verifyWebhook', () => {
  it('accepts the matching Basic auth header and rejects mismatches', async () => {
    const secret = 'topsecret';
    const header = `Basic ${btoa(`repo-sdk:${secret}`)}`;
    expect(await verifyWebhook({ headers: { authorization: header }, body: '{}', secret })).toBe(
      true,
    );
    expect(
      await verifyWebhook({
        headers: { authorization: `Basic ${btoa('repo-sdk:wrong')}` },
        body: '{}',
        secret,
      }),
    ).toBe(false);
    expect(await verifyWebhook({ headers: {}, body: '{}', secret })).toBe(false);
    expect(
      await verifyWebhook({ headers: { authorization: header }, body: '{}', secret: '' }),
    ).toBe(false);
  });

  it('compares the named custom header when header is set', async () => {
    const secret = 'topsecret';
    const params = { body: '{}', secret, header: 'X-Capawesome-Secret' };
    expect(await verifyWebhook({ ...params, headers: { 'x-capawesome-secret': secret } })).toBe(
      true,
    );
    expect(await verifyWebhook({ ...params, headers: { 'x-capawesome-secret': 'wrong' } })).toBe(
      false,
    );
    expect(await verifyWebhook({ ...params, headers: {} })).toBe(false);
    // With header set, a valid Basic auth header alone must not pass.
    expect(
      await verifyWebhook({
        ...params,
        headers: { authorization: `Basic ${btoa(`repo-sdk:${secret}`)}` },
      }),
    ).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('distinguishes branch and tag pushes', async () => {
    const push = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'notif-1',
        subscriptionId: 'sub-1',
        eventType: 'git.push',
        resource: {
          refUpdates: [{ name: 'refs/heads/main', newObjectId: 'headsha' }],
          commits: [{ commitId: 'sha1', comment: 'msg' }],
          repository: { name: 'repo-sdk', project: { name: 'core' } },
        },
      }),
    });
    expect(push).toMatchObject({
      type: 'push',
      repo: 'core/repo-sdk',
      ref: 'refs/heads/main',
      headCommitSha: 'headsha',
      deliveryId: 'notif-1',
      webhookId: 'sub-1',
    });
    expect(push.commits).toEqual([{ sha: 'sha1', message: 'msg' }]);

    const deletion = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        eventType: 'git.push',
        resource: { refUpdates: [{ name: 'refs/heads/gone', newObjectId: '0'.repeat(40) }] },
      }),
    });
    expect(deletion.headCommitSha).toBeUndefined();

    const tagPush = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        eventType: 'git.push',
        resource: { refUpdates: [{ name: 'refs/tags/v1.0.0' }] },
      }),
    });
    expect(tagPush.type).toBe('tag_push');
    expect(tagPush.ref).toBe('refs/tags/v1.0.0');

    const other = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ eventType: 'git.pullrequest.created' }),
    });
    expect(other.type).toBe('unknown');
  });
});

describe('listOrganizations', () => {
  it('resolves memberId then lists accounts', async () => {
    const stub = createFetchStub((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/_apis/profile/profiles/me') return { json: { id: 'member-1' } };
      if (url.pathname === '/_apis/accounts') {
        return {
          json: {
            count: 1,
            value: [
              {
                accountId: 'acct-1',
                accountName: 'contoso',
                accountUri: 'https://dev.azure.com/contoso',
              },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    });
    const orgs = await listOrganizations({ pat: PAT }, { fetch: stub.fetch });
    expect(orgs).toEqual([{ id: 'acct-1', name: 'contoso', url: 'https://dev.azure.com/contoso' }]);
    expect(stub.requests[0]!.url).toContain('app.vssps.visualstudio.com');
    expect(new URL(stub.requests[1]!.url).searchParams.get('memberId')).toBe('member-1');
    for (const request of stub.requests) {
      expect(new URL(request.url).searchParams.get('api-version')).toBe('7.1');
    }
  });
});

describe('commitWebUrl', () => {
  it('builds the commit web URL from the repository web URL', () => {
    expect(commitWebUrl('https://dev.azure.com/contoso/core/_git/repo-sdk', 'abc123')).toBe(
      'https://dev.azure.com/contoso/core/_git/repo-sdk/commit/abc123',
    );
  });
});
