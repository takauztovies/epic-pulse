import { classifyGraphqlErrors, classifyHttp } from './gql-errors.js';
import type { RawResponse } from './github.js';
import type { Failure } from './queries.js';
import { fail, ok, type Result } from './result.js';
import { BoardDataSchema, type BoardError, type BoardItemNode } from './schemas/board.js';
import { GqlEnvelopeSchema } from './schemas/graphql.js';
import { IssueNumberSchema } from './schemas/common.js';

// The board query is its own document, sent only when a project block is
// configured, and never mixed into the Phase A or Phase B documents
// (queries.ts): a token without read:project would fail them whole. It is
// read-only like them. The project number is the only interpolated value and
// goes through IssueNumberSchema first; owner, field and cursor are variables.
// `repositoryOwner ... on ProjectV2Owner` serves a user's board and an
// organisation's alike. A page of 100 items with no nested connection costs
// GitHub one point (measured live), which is what the ledger is charged.
export const BOARD_PAGE_SIZE = 100;

export function boardDocument(number: number, pageSize: number = BOARD_PAGE_SIZE): string {
  return `query Board($owner: String!, $field: String!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: ${IssueNumberSchema.parse(number)}) {
        items(first: ${IssueNumberSchema.parse(pageSize)}, after: $after) {
          nodes {
            content { ... on Issue { number repository { nameWithOwner } } }
            fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}`;
}

// An issue on the board and the name of its option; null when the item has no
// value in the field (or the field is not a single select).
export interface BoardItem {
  readonly key: string;
  readonly option: string | null;
}

// `next`: the cursor of the following page, null on the last one.
export interface BoardPage {
  readonly items: readonly BoardItem[];
  readonly next: string | null;
}

// How a board item names its issue in BoardSchema's `items`: `owner/repo#N`,
// lowercased like every ref.
export function boardKey(nameWithOwner: string, number: number): string {
  return `${nameWithOwner.toLowerCase()}#${number}`;
}

// Pull requests and draft issues are on boards too; only issues count.
function itemOf(node: BoardItemNode | null): readonly BoardItem[] {
  const content = node?.content;
  if (!content?.repository || content.number === undefined) return [];
  return [{ key: boardKey(content.repository.nameWithOwner, content.number), option: node?.fieldValueByName?.name ?? null }];
}

// HTTP status, the envelope, GraphQL errors, then the shape. A project that
// does not exist, or an owner without one, is not_found.
export function parseBoardPage(res: RawResponse): Result<BoardPage, Failure> {
  const http = classifyHttp(res);
  if (http) return fail({ code: http, detail: `HTTP ${res.status}` });
  const envelope = GqlEnvelopeSchema.safeParse(res.body);
  if (!envelope.success) return fail({ code: 'invalid_response', detail: 'not_graphql_envelope' });
  const fatal = classifyGraphqlErrors(envelope.data.errors).fatal;
  if (fatal) return fail({ code: fatal, detail: null });
  const data = BoardDataSchema.safeParse(envelope.data.data);
  if (!data.success) return fail({ code: 'invalid_response', detail: 'board_shape' });
  const items = data.data.repositoryOwner?.projectV2?.items;
  if (!items) return fail({ code: 'not_found', detail: null });
  return ok({ items: items.nodes.flatMap(itemOf), next: items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null });
}

// INSUFFICIENT_SCOPES and FORBIDDEN both arrive as `forbidden`
// (gql-errors.ts): for a board that means the token lacks read:project.
export function boardErrorOf(failure: Failure): BoardError {
  return failure.code === 'forbidden' ? 'scope' : failure.code;
}
