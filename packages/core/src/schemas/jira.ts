import { z } from 'zod';

// Jira Cloud answers, read leniently: a field Atlassian adds is ignored, a
// field that is missing or the wrong shape falls back to nothing instead of
// failing the whole epic (the same rule as GitHub's `catch(undefined)`).
// Shapes follow Atlassian's REST v3 documentation for `POST
// /rest/api/3/search/jql`.
const text = z.string().optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);

const StatusSchema = z.looseObject({
  name: text,
  statusCategory: z.looseObject({ key: text }).optional().catch(undefined),
});

const ParentSchema = z.looseObject({ key: text });

export const JiraFieldsSchema = z.looseObject({
  summary: text,
  // Atlassian Document Format (an object) on v3, nothing on an empty description.
  description: z.unknown().optional(),
  created: text,
  resolutiondate: text,
  labels: z.array(z.string()).optional().catch(undefined),
  assignee: z.looseObject({ displayName: text }).nullable().optional().catch(undefined),
  status: StatusSchema.optional().catch(undefined),
  resolution: z.looseObject({ name: text }).nullable().optional().catch(undefined),
  parent: ParentSchema.nullable().optional().catch(undefined),
});

export const JiraIssueSchema = z.looseObject({ key: z.string(), fields: JiraFieldsSchema.optional().catch(undefined) });

export const JiraSearchSchema = z.looseObject({
  issues: z.array(JiraIssueSchema),
  isLast: flag,
  nextPageToken: text,
});

// What `send` hands to `parse`. Phase A is one search. Phase B is one search for
// the epics themselves and, per epic, every page of its children that was read
// (`complete` is false when the page cap cut it short).
export const JiraPhaseASchema = JiraSearchSchema;

export const JiraPhaseBSchema = z.object({
  epics: JiraSearchSchema,
  children: z.record(z.string(), z.object({ issues: z.array(JiraIssueSchema), complete: z.boolean() })),
});

export type JiraIssue = z.infer<typeof JiraIssueSchema>;
export type JiraSearch = z.infer<typeof JiraSearchSchema>;
export type JiraPhaseB = z.infer<typeof JiraPhaseBSchema>;
