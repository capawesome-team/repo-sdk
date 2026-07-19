import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { isRecord } from '../shared.ts';
import { API_VERSION, authHeader, authSecrets, type AzureDevOpsAuth } from './auth.ts';

const VSSPS_BASE_URL = 'https://app.vssps.visualstudio.com';

export interface Organization {
  id: string;
  name: string;
  url: string;
}

interface AzureProfile {
  id: string;
}

interface AzureAccount {
  accountId: string;
  accountName: string;
  accountUri: string;
}

interface AzureAccountList {
  count: number;
  value: AzureAccount[];
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
  return { message };
}

/**
 * Lists the organizations (accounts) the authenticated identity belongs to.
 * Organizations live on the `app.vssps.visualstudio.com` host — outside the
 * org-pinned provider — so this ships as a standalone helper.
 */
export async function listOrganizations(
  options: AzureDevOpsAuth,
  init?: { fetch?: typeof fetch },
): Promise<Organization[]> {
  const http = new HttpClient({
    provider: 'azure-devops',
    baseUrl: VSSPS_BASE_URL,
    fetchImpl: init?.fetch ?? fetch,
    authHeaders: async () => ({ Authorization: await authHeader(options) }),
    mapError,
    secrets: () => authSecrets(options),
  });

  const { data: profile } = await http.json<AzureProfile>('/_apis/profile/profiles/me', {
    query: { 'api-version': API_VERSION },
  });
  const { data: accounts } = await http.json<AzureAccountList>('/_apis/accounts', {
    query: { memberId: profile.id, 'api-version': API_VERSION },
  });
  return accounts.value.map((account) => ({
    id: account.accountId,
    name: account.accountName,
    url: account.accountUri,
  }));
}
