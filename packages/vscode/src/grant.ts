import { DEFAULT_HOST, HostSchema } from '@epic-pulse/core';
import { z } from 'zod';

// What VS Code's GitHub sign-ins handed over for one poll: each token under
// the one host it belongs to. It lives as long as that poll and goes nowhere
// but core's refresh, which offers a host its own entry and nothing to any
// other: no result, log line or label the extension builds has a field for a
// token.
export type Grant = Readonly<Record<string, string>>;

// How a refresh got its token, as a label. `session`: a VS Code sign-in
// covers a host the registry names, and that host gets its token. `none`: no
// sign-in does, so core falls back to GH_TOKEN and `gh auth token` exactly as
// the CLI does.
export type TokenUse = 'session' | 'none';

export type Provider = 'github' | 'github-enterprise';

// GitHub has no read-only scope that reaches private repositories, so reading
// their issues takes `repo`. Epic Pulse sends GraphQL queries only.
export const SCOPES: readonly string[] = ['repo'];

// One `vscode.authentication.getSession` call, as data.
export interface SessionRequest {
  readonly provider: Provider;
  readonly scopes: readonly string[];
  readonly options: { readonly createIfNone: false; readonly silent: true };
}

// Silent: no prompt, and no badge on the Accounts menu. Someone whose `gh` is
// signed in never needs this sign-in, and the tree offers it when it is due.
// The Enterprise sign-in serves only the server `github-enterprise.uri`
// names, so without one it is not asked at all.
export function sessionRequests(enterpriseHost: string | undefined): readonly SessionRequest[] {
  const providers: readonly Provider[] = enterpriseHost === undefined ? ['github'] : ['github', 'github-enterprise'];
  return providers.map((provider) => ({ provider, scopes: SCOPES, options: { createIfNone: false, silent: true } }));
}

// Each provider's access token, where it had a session.
export type SessionTokens = Partial<Readonly<Record<Provider, string>>>;

// The GitHub sign-in's token belongs to github.com and the Enterprise one's to
// the configured server. Core offers each to that host only, so this pairing
// is the whole boundary between a sign-in and every other host.
export function grantOf(sessions: SessionTokens, enterpriseHost: string | undefined): Grant {
  const github = sessions.github === undefined ? [] : [[DEFAULT_HOST, sessions.github] as const];
  const enterprise = sessions['github-enterprise'];
  const ghes = enterprise === undefined || enterpriseHost === undefined ? [] : [[enterpriseHost, enterprise] as const];
  return Object.fromEntries([...github, ...ghes]);
}

// `constructor` is a valid host name and a key every object inherits, so a
// host counts only through the grant's own entries.
export function tokenUse(grant: Grant, hosts: ReadonlySet<string>): TokenUse {
  return [...hosts].some((host) => Object.hasOwn(grant, host)) ? 'session' : 'none';
}

const EnterpriseUriSchema = z.url({ protocol: /^https?$/ }).max(2048);

// VS Code's GitHub Enterprise sign-in serves the one server named in the
// `github-enterprise.uri` setting; this is that server's host, as refs spell
// it. github.com is not an enterprise host whatever the setting says.
export function enterpriseHostOf(uri: unknown): string | undefined {
  const parsed = EnterpriseUriSchema.safeParse(uri);
  if (!parsed.success) return undefined;
  const host = HostSchema.safeParse(new URL(parsed.data).host.toLowerCase());
  return host.success && host.data !== DEFAULT_HOST ? host.data : undefined;
}
