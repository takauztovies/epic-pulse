import { DEFAULT_HOST } from '@epic-pulse/core';
import type { Provider } from './grant.js';

// What the Sign in action does. VS Code's GitHub sign-in serves github.com,
// and its GitHub Enterprise one serves the single server `github-enterprise.uri`
// names. A repository on any other host stays signed out after a github.com
// sign-in, which is what the action used to offer it, so such a repository
// gets the setting that would serve it instead.
export type SignInStep =
  | { readonly kind: 'sign-in'; readonly providers: readonly Provider[] }
  | ConfigureStep;

export interface ConfigureStep {
  readonly kind: 'configure';
  readonly host: string;
  readonly configured: string | undefined;
}

export const ENTERPRISE_URI_SETTING = 'github-enterprise.uri';

// `signedOut`: the hosts of the repositories the view offers a sign-in for.
// With none known (the command run from the palette) every sign-in is offered.
// When the configured server is one of them it signs in first; a host it can
// not serve is named on the next click.
export function signInStep(signedOut: ReadonlySet<string>, enterpriseHost: string | undefined): SignInStep {
  const enterprise = enterpriseHost !== undefined && signedOut.has(enterpriseHost);
  const unserved = [...signedOut].filter((host) => host !== DEFAULT_HOST && host !== enterpriseHost).sort();
  if (unserved[0] !== undefined && !enterprise) return { kind: 'configure', host: unserved[0], configured: enterpriseHost };
  if (signedOut.size === 0) return { kind: 'sign-in', providers: enterpriseHost === undefined ? ['github'] : ['github', 'github-enterprise'] };
  const github: readonly Provider[] = signedOut.has(DEFAULT_HOST) ? ['github'] : [];
  return { kind: 'sign-in', providers: [...github, ...(enterprise ? (['github-enterprise'] as const) : [])] };
}

// Hosts are those of refs, checked against HostSchema, so they are safe to
// show and to put into a URL.
export function configureMessage(step: Omit<ConfigureStep, 'kind'>): string {
  const fix = `Set it to https://${step.host} and sign in again, or run \`gh auth login --hostname ${step.host}\`.`;
  if (step.configured === undefined) {
    return `Epic Pulse: this repository is on ${step.host}, and VS Code signs in to a GitHub Enterprise server only once \`${ENTERPRISE_URI_SETTING}\` names it. ${fix}`;
  }
  const point = fix.replace('Set it to', 'Point it at');
  return `Epic Pulse: this repository is on ${step.host}, but \`${ENTERPRISE_URI_SETTING}\` names ${step.configured}, the one GitHub Enterprise server VS Code signs in to. ${point}`;
}
