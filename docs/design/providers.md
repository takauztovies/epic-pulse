# Design: GitLab and Jira Cloud behind a provider seam

Status: the provider interface (step 1) is merged. Jira Cloud is implemented and ships experimental in 0.3.5 (unverified
fixtures, acknowledged in `fixtures/jira/unverified-ack.json`; see "Jira: what was built" at the end). GitLab is not started. Today every part of
epic-pulse that talks to an issue tracker assumed GitHub; this adds GitLab (work-item epics) and Jira
Cloud (status categories), each as its own release.

## What is GitHub-specific today

| Area | Where (packages/core/src) | Provider-owned? |
| --- | --- | --- |
| Token lookup (`GH_TOKEN`, `gh auth token`, hosts) | github.ts | yes |
| Resolve an issue to its parent epic (Phase A) | queries.ts, schemas/graphql.ts, resolve.ts | yes |
| Fetch an epic with its children (Phase B) and derive each status | queries.ts, status.ts (`deriveStatus`, PR linkage) | yes |
| Session binding: `gh issue …`, closing keywords, branch names | extract-commands.ts, extract.ts | partly |
| Registry, pins, snapshot persistence, view, render, lock, budget | registry.ts, pins.ts, snapshot.ts, view.ts, render.ts, refresh*.ts | shared |

The shared half is most of the program. Only token, resolve and fetch need an interface; they plug in
at `refresh-batch.ts` (`send`, `answered`) and `tokensFor` in refresh.ts.

```ts
interface Provider {
  readonly kind: 'github' | 'gitlab' | 'jira';
  token(host: string, env: NodeJS.ProcessEnv): Promise<Result<string, ErrorCode>>;
  resolveEpics(refs: readonly IssueRef[], ctx: FetchContext): Promise<Result<Resolutions, ErrorCode>>;
  fetchEpics(refs: readonly IssueRef[], ctx: FetchContext): Promise<Result<EpicEntries, ErrorCode>>;
}
```

## Decision 1: the reference type (needs your call)

`IssueRef` is `{host, owner, repo, number}`, lowercase-only, numeric, and persisted in session files,
`pins.json` and the snapshot (`v: 1`). Jira keys (`PROJ-123`) are not numbers or lowercase; GitLab
paths nest (`group/sub/project`) and use `!` for merge requests.

- **A. Discriminated union with a default (recommended).** Add `kind`; a ref without one parses as
  `github`, so every file already on disk stays valid and no migration runs. GitHub's `refKey` stays
  `host/owner/repo#N`; others get a prefix (`gitlab:host/group/sub/project#iid`, `jira:site/PROJ-123`).
  Cost: every consumer of the ref helpers (listed below) switches to the union.
- **B. Encode everything as owner/repo/number.** Jira `PROJ-123` becomes owner `proj`, number 123.
  Small change, but it lowercases keys and invents a fake repo; it breaks the first time two projects
  share a number. Not recommended.
- **C. Bump the snapshot to v2 and migrate.** Cleanest model, but every user's registry is rewritten
  and a downgrade corrupts it.

Consumers to update under A: core `view`, `refresh-plan`, `resolve`, `refresh-apply`, `extract`,
`extract-commands`, `extract-paths`, `checklist`, `registry`, `pins`; cli `track`, `doctor`; vscode
`track`, `sessions`, `sign-in`, `grant`, and the `#N` display in `render`, tree, status bar and overview.

## Decision 2: how a repository picks its provider

- GitLab: by the remote's host. `gitlab.com` is known; a self-managed host is declared in
  `.epic-pulse.json` (`"providers": {"git.example.com": "gitlab"}`).
- Jira has no git host. It is declared in `.epic-pulse.json`
  (`"jira": {"site": "example.atlassian.net", "projects": ["PROJ"]}`); issue keys matching those
  projects are Jira refs wherever they appear (branch names, commit messages, `track PROJ-123`).

## GitLab (release 1)

- Epic = a parent work item; children via the work-item hierarchy (GraphQL `workItem` /
  `hierarchyWidget`), including sub-epics.
- Status: closed → done (dropped when closed as not planned/duplicate, where GitLab records it);
  open with an open merge request closing it → in review (ready) or in progress (draft); assignee →
  in progress; else todo. The same precedence as GitHub, with merge requests for pull requests.
- Auth: `GITLAB_TOKEN` (scope `read_api`), then `glab auth token`-style lookup. Read-only queries only.
- Binding: branch names and closing keywords (`Closes #4`) already parse; add `glab issue …`.

## Jira Cloud (release 2)

- Epic = an issue of type Epic; children via JQL `parent = KEY` (and the legacy epic link).
- Status by **status category**: To Do → todo, In Progress → in progress, Done → done. A status named
  in `.epic-pulse.json` (`"jira": {"statusMap": {"In Review": "in_review", "Won't Do": "dropped"}}`)
  overrides the category. Resolution `Won't Do`/`Duplicate` can map to dropped the same way.
- Auth: `JIRA_EMAIL` + `JIRA_API_TOKEN` over HTTPS to the configured site. Read-only.
- Binding: keys in branch names and commit messages, and `epic-pulse track PROJ-123`.

## Tests and fixtures

CLAUDE.md forbids mocks, so each provider needs recorded real responses
(`scripts/record-fixtures.mjs`, which must become provider-aware). That needs a public demo project
owned by the maintainer for each: a GitLab group with a few epics and issues (GitLab.com's GraphQL can
be read without a token for public data), and a Jira Cloud site with a demo project and an API token.
Nothing from any other project may enter the repository.

## Rollout

1. Provider interface; GitHub moved behind it with **no behaviour change** (all existing tests green).
2. Ref union with the GitHub default (Decision 1A); persisted data untouched.
3. GitLab provider, fixtures, docs, release.
4. Jira provider, fixtures, docs, release.

## Risks

- Ref union touches ~25 files: mitigated by step 2 being a pure refactor with a no-op default.
- GitLab epics need Premium/Ultimate; free-tier groups have none. The provider reports `unsupported`
  with a clear message, as the GitHub one does for hosts without sub-issues.
- Budget constants are GitHub-priced (points per hour); each provider owns its own pacing.

## Jira: what was built, and how it differs from the plan above

- **Reference type.** Decision 1 chose a default-`github` kind (option A), done in its lightest form: a
  Jira reference has the same four fields (`host` is the site, `owner` and `repo` are both the lowercased
  project key, `number` the issue number) plus `kind: 'jira'`, which is stored only for Jira, so no
  existing file changes. `refKey`, `repoKey`, `issueUrl` and `displayKey` tell them apart; epics and
  issues expose `key` (`#12` or `PROJ-12`) for display. No migration.
- **Provider choice.** By the reference's kind, not by host (Jira has no git host). The repository
  declares the site and projects in the `jira` block of `.epic-pulse.json`; the hook binds keys only for
  those projects.
- **Credentials.** Only to a site listed in the user's own `JIRA_SITE`. The plan did not say this; it
  matters because an Atlassian API token works on every site its account reaches and the repository's
  config is untrusted.
- **Status.** Jira's status category, then the repository's `statusMap`, then dropped resolutions
  (Won't Do, Duplicate, ...). Pull requests are not read for Jira.
- **Known limits.** A sub-task resolves to its parent story, not that story's epic. An expired token can
  answer with an empty result, which reads as "no epic".

### Producing the real fixtures

CLAUDE.md forbids test doubles, so the Jira parsing is tested against recorded responses. The ones in
`fixtures/jira/` were first written by hand from Atlassian's documentation and are flagged
`"unverified": true`; `release.mjs --check` refuses to release while any carries the flag. To replace them:

1. Create a free Jira Cloud site with a **personal** account that holds nothing else (an API token
   reaches every site its account can), and a project, for example `EPD`.
2. In it, an Epic `EPD-1` ("Demo epic: sample onboarding flow") with six children: one Done, one
   closed with resolution Won't Do, one In Progress (assigned), one in a review-style status (add
   "In Review" to the workflow), one To Do (assigned) and one Backlog. Make `EPD-4` the In Progress one.
3. Create an API token with an expiry, then:
   `JIRA_SITE=yoursite.atlassian.net JIRA_EMAIL=... JIRA_API_TOKEN=... pnpm record-fixtures jira`.
   The recorder scrubs account ids, addresses and avatar links and refuses a recording that still holds
   any, then writes `fixtures/jira/*.json` without the flag.
4. Set `HOST` (and the project) in `packages/core/test/jira.test.ts` to the site's, and run the suite.
   Differences between the real answers and the hand-written ones are the bugs this step exists to find.
