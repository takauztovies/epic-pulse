import { DEFAULT_HOST, HostSchema } from '@epic-pulse/core';
import { z } from 'zod';

// What VS Code's GitHub sign-ins handed over for one poll. It lives as long as
// that poll and goes nowhere but the environment of its refresh: no result,
// log line or label the extension builds has a field for a token.
export interface Grant {
  readonly github?: string;
  readonly enterprise?: { readonly host: string; readonly token: string };
}

// How a refresh got its token, as a label. `session`: from VS Code's sign-in.
// `withheld`: a sign-in exists, but the registry also names a host it does not
// belong to. `none`: no sign-in covers the repository, so core falls back to
// GH_TOKEN and `gh auth token` exactly as the CLI does.
export type TokenUse = 'session' | 'withheld' | 'none';

export interface RefreshEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly use: TokenUse;
}

function ownedHosts(grant: Grant): ReadonlySet<string> {
  return new Set([...(grant.github ? [DEFAULT_HOST] : []), ...(grant.enterprise ? [grant.enterprise.host] : [])]);
}

// Core offers GH_ENTERPRISE_TOKEN to every host that is not github.com, and
// passes its environment, GH_TOKEN included, to `gh auth token` for any host it
// has no variable for; gh hands GH_TOKEN on for *.ghe.com. So a VS Code token
// enters the environment only when every host the registry names is one a
// sign-in belongs to, and then only the tokens for hosts actually named. The
// refresh reads the registry again under its lock: a binding to a new host that
// lands between the two reads is the gap this can not close from outside core.
export function refreshEnv(base: NodeJS.ProcessEnv, grant: Grant, hosts: ReadonlySet<string>): RefreshEnv {
  const owned = ownedHosts(grant);
  const covered = [...hosts].filter((host) => owned.has(host));
  if (covered.length === 0) return { env: base, use: 'none' };
  if (covered.length < hosts.size) return { env: base, use: 'withheld' };
  const github = grant.github !== undefined && hosts.has(DEFAULT_HOST) ? { GH_TOKEN: grant.github } : {};
  const { enterprise } = grant;
  const ghes = enterprise !== undefined && hosts.has(enterprise.host) ? { GH_ENTERPRISE_TOKEN: enterprise.token } : {};
  return { env: { ...base, ...github, ...ghes }, use: 'session' };
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
