import * as vscode from 'vscode';
import { DEFAULT_HOST } from '@epic-pulse/core';
import { errorLabel, type Accounts } from '../details.js';
import { enterpriseHostOf, grantOf, SCOPES, sessionRequests, type Grant, type Provider, type SessionRequest } from '../grant.js';
import { configureMessage, ENTERPRISE_URI_SETTING, signInStep } from '../sign-in.js';

export const PROVIDERS: ReadonlySet<string> = new Set<Provider>(['github', 'github-enterprise']);

export interface Auth {
  // For one poll only; see Grant.
  readonly grant: Grant;
  readonly accounts: Accounts;
}

function enterpriseHost(): string | undefined {
  return enterpriseHostOf(vscode.workspace.getConfiguration('github-enterprise').get<unknown>('uri'));
}

// The call itself is described by sessionRequests (grant.ts), where it is
// tested: silent, so no prompt and no badge on the Accounts menu.
async function sessionToken(request: SessionRequest, log: vscode.LogOutputChannel): Promise<string | undefined> {
  try {
    return (await vscode.authentication.getSession(request.provider, request.scopes, request.options))?.accessToken;
  } catch (error) {
    log.warn(`${request.provider} sign-in could not be read: ${errorLabel(error)}`);
    return undefined;
  }
}

export async function readAuth(log: vscode.LogOutputChannel): Promise<Auth> {
  const host = enterpriseHost();
  const found = await Promise.all(sessionRequests(host).map(async (request) => [request.provider, await sessionToken(request, log)] as const));
  const grant = grantOf(Object.fromEntries(found), host);
  const enterprise = host !== undefined && Object.hasOwn(grant, host) ? host : null;
  return { grant, accounts: { github: Object.hasOwn(grant, DEFAULT_HOST), enterprise } };
}

async function pickProvider(providers: readonly Provider[], host: string | undefined): Promise<Provider | undefined> {
  if (providers.length === 1 || host === undefined) return providers[0];
  const items = [
    { label: 'GitHub.com', provider: 'github' as const },
    { label: `GitHub Enterprise (${host})`, provider: 'github-enterprise' as const },
  ];
  return (await vscode.window.showQuickPick(items, { title: 'Sign in to GitHub for Epic Pulse' }))?.provider;
}

// True once a sign-in exists. A dismissed prompt is not a failure: it is
// logged, and nothing else happens. A repository on a host no sign-in serves
// gets the setting that would serve it, and no sign-in (see sign-in.ts).
export async function signIn(log: vscode.LogOutputChannel, signedOut: ReadonlySet<string>): Promise<boolean> {
  const host = enterpriseHost();
  const step = signInStep(signedOut, host);
  if (step.kind === 'configure') {
    void vscode.window.showWarningMessage(configureMessage(step));
    await vscode.commands.executeCommand('workbench.action.openSettings', ENTERPRISE_URI_SETTING);
    return false;
  }
  const provider = await pickProvider(step.providers, host);
  if (provider === undefined) return false;
  try {
    await vscode.authentication.getSession(provider, SCOPES, { createIfNone: true });
    return true;
  } catch (error) {
    log.info(`${provider} sign-in not completed: ${errorLabel(error)}`);
    return false;
  }
}
