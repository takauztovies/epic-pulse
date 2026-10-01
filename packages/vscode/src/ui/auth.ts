import * as vscode from 'vscode';
import { errorLabel, type Accounts } from '../details.js';
import { enterpriseHostOf, type Grant } from '../grant.js';

// GitHub has no read-only scope that reaches private repositories, so reading
// their issues takes `repo`. Epic Pulse sends GraphQL queries only.
const SCOPES: readonly string[] = ['repo'];

type Provider = 'github' | 'github-enterprise';
export const PROVIDERS: ReadonlySet<string> = new Set<Provider>(['github', 'github-enterprise']);

export interface Auth {
  // For one poll only; see Grant.
  readonly grant: Grant;
  readonly accounts: Accounts;
}

function enterpriseHost(): string | undefined {
  return enterpriseHostOf(vscode.workspace.getConfiguration('github-enterprise').get<unknown>('uri'));
}

// Silent: no prompt, and no badge on the Accounts menu. Someone whose `gh` is
// signed in never needs this sign-in, and the tree offers it when it is due.
async function session(provider: Provider, log: vscode.LogOutputChannel): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(provider, SCOPES, { createIfNone: false, silent: true });
  } catch (error) {
    log.warn(`${provider} sign-in could not be read: ${errorLabel(error)}`);
    return undefined;
  }
}

export async function readAuth(log: vscode.LogOutputChannel): Promise<Auth> {
  const host = enterpriseHost();
  const [github, enterprise] = await Promise.all([
    session('github', log),
    host === undefined ? undefined : session('github-enterprise', log),
  ]);
  const ghes = host !== undefined && enterprise !== undefined ? { host, token: enterprise.accessToken } : undefined;
  return {
    grant: { ...(github ? { github: github.accessToken } : {}), ...(ghes ? { enterprise: ghes } : {}) },
    accounts: { github: github !== undefined, enterprise: ghes?.host ?? null },
  };
}

async function pickProvider(host: string | undefined): Promise<Provider | undefined> {
  if (host === undefined) return 'github';
  const items = [
    { label: 'GitHub.com', provider: 'github' as const },
    { label: `GitHub Enterprise (${host})`, provider: 'github-enterprise' as const },
  ];
  return (await vscode.window.showQuickPick(items, { title: 'Sign in to GitHub for Epic Pulse' }))?.provider;
}

// True once a sign-in exists. A dismissed prompt is not a failure: it is
// logged, and nothing else happens.
export async function signIn(log: vscode.LogOutputChannel): Promise<boolean> {
  const provider = await pickProvider(enterpriseHost());
  if (provider === undefined) return false;
  try {
    await vscode.authentication.getSession(provider, SCOPES, { createIfNone: true });
    return true;
  } catch (error) {
    log.info(`${provider} sign-in not completed: ${errorLabel(error)}`);
    return false;
  }
}
