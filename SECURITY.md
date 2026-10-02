# Security policy

## Reporting a vulnerability

Please report it privately through GitHub:
[open a security advisory](https://github.com/takauztovies/epic-pulse/security/advisories/new) for
`takauztovies/epic-pulse`. Do not open a public issue, and please give a fix the chance to ship
before you disclose it.

Helpful in a report: the version (`npm view epic-pulse version`, or the plugin's
`plugin/.claude-plugin/plugin.json`), your operating system, what an attacker controls, and the
smallest steps that show the problem.

## Supported versions

Fixes go into the latest release only. Update the plugin, the npm package or the extension to the
newest version before reporting.

## What epic-pulse is meant to guarantee

These are the properties a report would most usefully break:

- **The token stays in memory.** It is never written to a file, a log or an error message.
- **A token goes only to a host you trust.** `GH_TOKEN`, `GITHUB_TOKEN` and `gh`'s github.com login
  are sent to `api.github.com` only, whatever a repository's remote or a command names. The
  Enterprise variables `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`, which `gh` ties to no
  host, go only to the host `GH_HOST` names or one listed in `EPIC_PULSE_HOSTS`. Any other host gets
  nothing but the login made for it with `gh auth login --hostname`, or no token at all.
- **Read-only.** epic-pulse sends nothing but GraphQL queries, and only to the GraphQL endpoint of the
  host an issue lives on. It never sends a mutation.
- **An offline hook.** The Claude Code hook makes no network call and stores only issue references
  and timestamps: no command text, no file paths, no file contents.
- **A hostile repository stays contained.** A repository's `.epic-pulse.json`, its git remotes and its
  branch names are untrusted input. They can not make epic-pulse run code, write outside its own
  directories, hang a hook with a slow regular expression, or send a token to a host you did not name
  or log in to.
- **Session ids can not name a path.** Only a UUID-shaped session id becomes a file name.
- **Your settings are not overwritten.** `epic-pulse statusline install` changes only `statusLine`,
  backs the file up first, and refuses to replace a status line that is not its own.

The README lists every file epic-pulse writes and what each one holds; a file that is not on that list,
or holds more than it says, is a bug worth reporting.

## Verifying a release

Every release is built by `.github/workflows/release.yml` from a tag on `main`. The npm package carries
npm provenance, and the release assets carry GitHub build-provenance attestations:

```
gh attestation verify epic-pulse-<version>.vsix --repo takauztovies/epic-pulse
gh attestation verify epic-pulse-<version>.tgz --repo takauztovies/epic-pulse
```

The Claude Code plugin runs `plugin/dist/epic-pulse.mjs` exactly as it is committed on `main`. Only a
release branch may change that file, and CI checks that it is the bundle its sources build.
