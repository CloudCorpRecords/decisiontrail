/**
 * decisiontrail core: a local decision-memory store.
 *
 * Clean-room rebuild of the local surface of "elen" (10 of its 12 tools;
 * the two connected-mode beta tools are omitted — see BUILD-REPORT.md).
 * Decisions live in one JSON document behind an injectable Store, and
 * every timestamp comes from an injectable clock, so the whole core is
 * testable against temp directories with no network.
 *
 * All ranking / grouping / threshold behaviour is a labelled
 * reconstruction from the original's pinned one-line tool semantics;
 * each choice is documented in BUILD-REPORT.md.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CompetencyDomain,
  ContextGroup,
  DecisionPointer,
  DecisionRecord,
  DecisionTrailDeps,
  DuplicateCandidate,
  StaleCandidate,
  Store,
  StoreDocument,
} from "./types.js";
import { ValidationError } from "./types.js";

export { ValidationError } from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_LIMIT = 5;
export const DUPLICATE_JACCARD_THRESHOLD = 0.6;
export const STALE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default store path: DECISIONTRAIL_DB or ~/.decisiontrail/decisions.json */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DECISIONTRAIL_DB;
  if (override && override.trim()) return override;
  return join(homedir(), ".decisiontrail", "decisions.json");
}

/**
 * File-backed store: one JSON document, missing file starts empty,
 * writes are atomic (write to a sibling temp file, then rename).
 */
export class FileStore implements Store {
  constructor(public readonly path: string) {}

  load(): StoreDocument {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { next_id: 1, records: [] };
      }
      throw err;
    }
    if (!raw.trim()) return { next_id: 1, records: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Decision store at ${this.path} is not valid JSON`);
    }
    const doc = parsed as Partial<StoreDocument>;
    if (!Array.isArray(doc.records) || typeof doc.next_id !== "number") {
      throw new Error(`Decision store at ${this.path} has an unexpected shape`);
    }
    return { next_id: doc.next_id, records: doc.records as DecisionRecord[] };
  }

  save(doc: StoreDocument): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    renameSync(tmp, this.path);
  }
}

/** In-memory store for tests and embedding. */
export class MemoryStore implements Store {
  private doc: StoreDocument = { next_id: 1, records: [] };
  constructor(public readonly path: string = ":memory:") {}
  load(): StoreDocument {
    return JSON.parse(JSON.stringify(this.doc)) as StoreDocument;
  }
  save(doc: StoreDocument): void {
    this.doc = JSON.parse(JSON.stringify(doc)) as StoreDocument;
  }
}

// ---------------------------------------------------------------------------
// Argument validation (the core validates itself; no schema library)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireArgsObject(args: unknown, tool: string): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) {
    throw new ValidationError(`${tool}: arguments must be an object`);
  }
  return args;
}

function reqString(args: Record<string, unknown>, field: string, tool: string): string {
  const v = args[field];
  if (v === undefined || v === null) {
    throw new ValidationError(`${tool}: missing required argument "${field}"`);
  }
  if (typeof v !== "string") {
    throw new ValidationError(`${tool}: argument "${field}" must be a string`);
  }
  if (!v.trim()) {
    throw new ValidationError(`${tool}: argument "${field}" must not be empty`);
  }
  return v;
}

function optString(args: Record<string, unknown>, field: string, tool: string): string | undefined {
  const v = args[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new ValidationError(`${tool}: argument "${field}" must be a string`);
  }
  return v;
}

function stringArray(v: unknown, field: string, tool: string): string[] {
  if (!Array.isArray(v)) {
    throw new ValidationError(`${tool}: argument "${field}" must be an array of strings`);
  }
  for (const item of v) {
    if (typeof item !== "string") {
      throw new ValidationError(`${tool}: argument "${field}" must be an array of strings`);
    }
  }
  return [...(v as string[])];
}

function reqStringArray(args: Record<string, unknown>, field: string, tool: string): string[] {
  const v = args[field];
  if (v === undefined || v === null) {
    throw new ValidationError(`${tool}: missing required argument "${field}"`);
  }
  return stringArray(v, field, tool);
}

function optStringArray(args: Record<string, unknown>, field: string, tool: string): string[] {
  const v = args[field];
  if (v === undefined || v === null) return [];
  return stringArray(v, field, tool);
}

function optLimit(args: Record<string, unknown>, tool: string): number {
  const v = args.limit;
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new ValidationError(`${tool}: argument "limit" must be a positive integer`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Tokenisation and ranking (labelled reconstruction)
// ---------------------------------------------------------------------------

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok) out.add(tok);
  }
  return out;
}

function recordTokens(r: DecisionRecord): Set<string> {
  const out = tokenize(r.text);
  for (const c of r.constraints) for (const t of tokenize(c)) out.add(t);
  return out;
}

function overlapScore(queryTokens: Set<string>, r: DecisionRecord): number {
  const rt = recordTokens(r);
  let score = 0;
  for (const t of queryTokens) if (rt.has(t)) score += 1;
  return score;
}

/** Score desc; ties broken by recency (newest first, then highest id). */
function rank(records: DecisionRecord[], query: string, limit: number): DecisionRecord[] {
  const q = tokenize(query);
  return records
    .map((r) => ({ r, score: overlapScore(q, r) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const byTime = Date.parse(b.r.created_at) - Date.parse(a.r.created_at);
      if (byTime !== 0) return byTime;
      return numericId(b.r.id) - numericId(a.r.id);
    })
    .slice(0, limit)
    .map((x) => x.r);
}

function numericId(id: string): number {
  const m = /^d-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function pointer(r: DecisionRecord): DecisionPointer {
  return {
    id: r.id,
    text: r.text.slice(0, 120),
    domain: r.domain,
    validated: r.validated,
    status: r.status,
  };
}

function domainOf(args: Record<string, unknown>, tool: string): string {
  const d = optString(args, "domain", tool);
  return d && d.trim() ? d : "general";
}

// ---------------------------------------------------------------------------
// The store facade
// ---------------------------------------------------------------------------

export class DecisionTrail {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly agent: string;
  private readonly project: string;

  constructor(deps: DecisionTrailDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.agent = deps.agent ?? "local";
    this.project = deps.project ?? "local";
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DecisionTrail {
    const path = defaultDbPath(env);
    return new DecisionTrail({
      store: new FileStore(path),
      agent: env.DECISIONTRAIL_AGENT || "local",
      project: env.DECISIONTRAIL_PROJECT || "local",
    });
  }

  private createRecord(
    doc: StoreDocument,
    fields: Omit<DecisionRecord, "id" | "created_at" | "status" | "supersedes" | "superseded_by">,
  ): DecisionRecord {
    const record: DecisionRecord = {
      ...fields,
      id: `d-${doc.next_id}`,
      status: "active",
      supersedes: null,
      superseded_by: null,
      created_at: this.now().toISOString(),
    };
    doc.next_id += 1;
    doc.records.push(record);
    return record;
  }

  private findOrThrow(doc: StoreDocument, id: string, tool: string): DecisionRecord {
    const found = doc.records.find((r) => r.id === id);
    if (!found) throw new Error(`${tool}: unknown decision id "${id}"`);
    return found;
  }

  /** elen_commit — a new (unvalidated) decision with plain-text constraints. */
  commit(rawArgs: unknown): DecisionRecord {
    const tool = "elen_commit";
    const args = requireArgsObject(rawArgs, tool);
    const text = reqString(args, "text", tool);
    const constraints = optStringArray(args, "constraints", tool);
    const domain = domainOf(args, tool);
    const doc = this.store.load();
    const record = this.createRecord(doc, {
      text,
      constraints,
      domain,
      evidence: [],
      answer: null,
      validated: false,
    });
    this.store.save(doc);
    return record;
  }

  /** elen_log_decision — a validated record from constraints/evidence/answer. */
  logDecision(rawArgs: unknown): DecisionRecord {
    const tool = "elen_log_decision";
    const args = requireArgsObject(rawArgs, tool);
    const constraints = reqStringArray(args, "constraints", tool);
    const evidence = reqStringArray(args, "evidence", tool);
    const answer = reqString(args, "answer", tool);
    const textOpt = optString(args, "text", tool);
    const domain = domainOf(args, tool);
    const doc = this.store.load();
    const record = this.createRecord(doc, {
      text: textOpt && textOpt.trim() ? textOpt : answer,
      constraints,
      domain,
      evidence,
      answer,
      validated: true,
    });
    this.store.save(doc);
    return record;
  }

  /** elen_expand — the full record for an id. */
  expand(rawArgs: unknown): DecisionRecord {
    const tool = "elen_expand";
    const args = requireArgsObject(rawArgs, tool);
    const id = reqString(args, "id", tool);
    const doc = this.store.load();
    return this.findOrThrow(doc, id, tool);
  }

  /** elen_suggest — short pointers over all records. */
  suggest(rawArgs: unknown): DecisionPointer[] {
    const tool = "elen_suggest";
    const args = requireArgsObject(rawArgs, tool);
    const query = reqString(args, "query", tool);
    const limit = optLimit(args, tool);
    const doc = this.store.load();
    return rank(doc.records, query, limit).map(pointer);
  }

  /** elen_search_precedents — full records, validated only. */
  searchPrecedents(rawArgs: unknown): DecisionRecord[] {
    const tool = "elen_search_precedents";
    const args = requireArgsObject(rawArgs, tool);
    const query = reqString(args, "query", tool);
    const limit = optLimit(args, tool);
    const doc = this.store.load();
    return rank(
      doc.records.filter((r) => r.validated),
      query,
      limit,
    );
  }

  /** elen_supersede — create a successor; mark the old record superseded. */
  supersede(rawArgs: unknown): DecisionRecord {
    const tool = "elen_supersede";
    const args = requireArgsObject(rawArgs, tool);
    const id = reqString(args, "id", tool);
    const text = reqString(args, "text", tool);
    const constraints = optStringArray(args, "constraints", tool);
    const domainOpt = optString(args, "domain", tool);
    const doc = this.store.load();
    const old = this.findOrThrow(doc, id, tool);
    const successor = this.createRecord(doc, {
      text,
      constraints,
      domain: domainOpt && domainOpt.trim() ? domainOpt : old.domain,
      evidence: [],
      answer: null,
      validated: false,
    });
    successor.supersedes = old.id;
    old.status = "superseded";
    old.superseded_by = successor.id;
    this.store.save(doc);
    return successor;
  }

  /** elen_get_context — active threads grouped by domain. */
  getContext(rawArgs: unknown): { domains: ContextGroup[]; totals: { total: number; active: number; validated: number } } {
    const tool = "elen_get_context";
    requireArgsObject(rawArgs, tool);
    const doc = this.store.load();
    const byDomain = new Map<string, DecisionRecord[]>();
    for (const r of doc.records) {
      if (r.status !== "active") continue;
      const list = byDomain.get(r.domain) ?? [];
      list.push(r);
      byDomain.set(r.domain, list);
    }
    const domains: ContextGroup[] = [...byDomain.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([domain, list]) => {
        const latest = [...list].sort((a, b) => {
          const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
          return byTime !== 0 ? byTime : numericId(b.id) - numericId(a.id);
        })[0];
        return {
          domain,
          active: list.length,
          validated: list.filter((r) => r.validated).length,
          latest_text: latest.text,
        };
      });
    const activeRecords = doc.records.filter((r) => r.status === "active");
    return {
      domains,
      totals: {
        total: doc.records.length,
        active: activeRecords.length,
        validated: activeRecords.filter((r) => r.validated).length,
      },
    };
  }

  /** elen_status — namespace identity plus counts. */
  status(rawArgs: unknown): {
    agent: string;
    project: string;
    database_path: string;
    counts: { total: number; active: number; superseded: number; validated: number };
  } {
    const tool = "elen_status";
    requireArgsObject(rawArgs, tool);
    const doc = this.store.load();
    return {
      agent: this.agent,
      project: this.project,
      database_path: this.store.path,
      counts: {
        total: doc.records.length,
        active: doc.records.filter((r) => r.status === "active").length,
        superseded: doc.records.filter((r) => r.status === "superseded").length,
        validated: doc.records.filter((r) => r.validated).length,
      },
    };
  }

  /** elen_get_competency — counts and coverage from validated history only. */
  getCompetency(rawArgs: unknown): {
    validated_total: number;
    by_domain: Record<string, CompetencyDomain>;
    coverage: number;
  } {
    const tool = "elen_get_competency";
    requireArgsObject(rawArgs, tool);
    const doc = this.store.load();
    const validated = doc.records.filter((r) => r.validated);
    const by_domain: Record<string, CompetencyDomain> = {};
    for (const r of validated) {
      const entry = by_domain[r.domain] ?? { validated: 0, active: 0 };
      entry.validated += 1;
      if (r.status === "active") entry.active += 1;
      by_domain[r.domain] = entry;
    }
    return {
      validated_total: validated.length,
      by_domain,
      coverage: doc.records.length === 0 ? 0 : validated.length / doc.records.length,
    };
  }

  /** elen_consolidate — duplicate/stale candidates; mutates nothing. */
  consolidate(rawArgs: unknown): {
    duplicates: DuplicateCandidate[];
    clusters: string[][];
    stale: StaleCandidate[];
  } {
    const tool = "elen_consolidate";
    requireArgsObject(rawArgs, tool);
    const doc = this.store.load();
    const active = doc.records.filter((r) => r.status === "active");

    const duplicates: DuplicateCandidate[] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        if (a.domain !== b.domain) continue;
        const ta = recordTokens(a);
        const tb = recordTokens(b);
        const union = new Set([...ta, ...tb]);
        if (union.size === 0) continue;
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter += 1;
        const similarity = inter / union.size;
        if (similarity >= DUPLICATE_JACCARD_THRESHOLD) {
          duplicates.push({
            first: a.id,
            second: b.id,
            domain: a.domain,
            similarity: Math.round(similarity * 1000) / 1000,
          });
        }
      }
    }

    // Clusters: connected components of the duplicate graph (size >= 2).
    const adjacency = new Map<string, Set<string>>();
    for (const d of duplicates) {
      for (const [x, y] of [
        [d.first, d.second],
        [d.second, d.first],
      ] as const) {
        const s = adjacency.get(x) ?? new Set<string>();
        s.add(y);
        adjacency.set(x, s);
      }
    }
    const seen = new Set<string>();
    const clusters: string[][] = [];
    for (const start of adjacency.keys()) {
      if (seen.has(start)) continue;
      const component: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const cur = stack.pop() as string;
        component.push(cur);
        for (const next of adjacency.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      if (component.length >= 2) {
        clusters.push(component.sort((x, y) => numericId(x) - numericId(y)));
      }
    }
    clusters.sort((a, b) => numericId(a[0]) - numericId(b[0]));

    const nowMs = this.now().getTime();
    const stale: StaleCandidate[] = active
      .filter((r) => nowMs - Date.parse(r.created_at) > STALE_DAYS * DAY_MS)
      .map((r) => ({
        id: r.id,
        text: r.text.slice(0, 120),
        domain: r.domain,
        created_at: r.created_at,
        age_days: Math.floor((nowMs - Date.parse(r.created_at)) / DAY_MS),
      }));

    return { duplicates, clusters, stale };
  }

  /** Shared dispatch for the CLI and MCP layers. Returns JSON-able data. */
  dispatch(name: string, args: unknown): unknown {
    switch (name) {
      case "elen_commit":
        return this.commit(args);
      case "elen_log_decision":
        return this.logDecision(args);
      case "elen_expand":
        return this.expand(args);
      case "elen_suggest":
        return this.suggest(args);
      case "elen_search_precedents":
        return this.searchPrecedents(args);
      case "elen_supersede":
        return this.supersede(args);
      case "elen_get_context":
        return this.getContext(args);
      case "elen_status":
        return this.status(args);
      case "elen_get_competency":
        return this.getCompetency(args);
      case "elen_consolidate":
        return this.consolidate(args);
      default:
        throw new ValidationError(`unknown tool "${name}"`);
    }
  }
}

export const TOOL_NAMES = [
  "elen_commit",
  "elen_log_decision",
  "elen_expand",
  "elen_suggest",
  "elen_search_precedents",
  "elen_supersede",
  "elen_get_context",
  "elen_status",
  "elen_get_competency",
  "elen_consolidate",
] as const;
