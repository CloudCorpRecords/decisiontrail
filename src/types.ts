/**
 * decisiontrail types.
 *
 * A decision record is the single unit of the local store. The shape is a
 * labelled reconstruction (see BUILD-REPORT.md): the original tool's
 * public spec pins the one-line semantics of each tool but publishes no
 * record schema, so the fields below are the minimal set those semantics
 * require.
 */

export type DecisionStatus = "active" | "superseded";

export interface DecisionRecord {
  id: string;
  text: string;
  constraints: string[];
  /** Domain the decision belongs to; "general" when none was given. */
  domain: string;
  evidence: string[];
  /** The recorded answer for validated records; null for plain commits. */
  answer: string | null;
  validated: boolean;
  status: DecisionStatus;
  /** Id of the record this one replaces, or null. */
  supersedes: string | null;
  /** Id of the record that replaced this one, or null. */
  superseded_by: string | null;
  /** ISO 8601 creation instant, from the injectable clock. */
  created_at: string;
}

export interface StoreDocument {
  next_id: number;
  records: DecisionRecord[];
}

/** Injectable persistence: the core is pure over this interface. */
export interface Store {
  load(): StoreDocument;
  save(doc: StoreDocument): void;
  /** Human-facing path/name of the store, reported by elen_status. */
  path: string;
}

export interface DecisionTrailDeps {
  store: Store;
  /** Injectable clock; defaults to the system clock. */
  now?: () => Date;
  agent?: string;
  project?: string;
}

export interface DecisionPointer {
  id: string;
  /** First 120 characters of the record text. */
  text: string;
  domain: string;
  validated: boolean;
  status: DecisionStatus;
}

export interface ContextGroup {
  domain: string;
  active: number;
  validated: number;
  latest_text: string;
}

export interface CompetencyDomain {
  validated: number;
  active: number;
}

export interface DuplicateCandidate {
  first: string;
  second: string;
  domain: string;
  similarity: number;
}

export interface StaleCandidate {
  id: string;
  text: string;
  domain: string;
  created_at: string;
  age_days: number;
}

/** Raised for missing/wrongly-typed arguments; the MCP layer maps it to
 *  McpError InvalidParams and the CLI maps it to exit code 2. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
