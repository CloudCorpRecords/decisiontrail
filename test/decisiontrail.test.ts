/**
 * decisiontrail tests: real local behaviour against temp directories.
 * No network. The clock is injected so ranking, staleness and
 * timestamps are deterministic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionTrail,
  FileStore,
  ValidationError,
} from "../src/decisiontrail.js";

function makeTrail(startIso = "2026-10-27T12:00:00.000Z") {
  const dir = mkdtempSync(join(tmpdir(), "decisiontrail-test-"));
  const dbPath = join(dir, "nested", "decisions.json");
  let nowMs = Date.parse(startIso);
  const trail = new DecisionTrail({
    store: new FileStore(dbPath),
    now: () => new Date(nowMs),
    agent: "test-agent",
    project: "test-project",
  });
  return {
    trail,
    dbPath,
    advanceDays(days: number) {
      nowMs += days * 24 * 60 * 60 * 1000;
    },
    setNow(iso: string) {
      nowMs = Date.parse(iso);
    },
  };
}

describe("commit and expand", () => {
  it("round-trips a committed decision through expand and the file on disk", () => {
    const { trail, dbPath } = makeTrail();
    const rec = trail.commit({
      text: "Use Postgres for the billing store",
      constraints: ["must survive a single-node outage", "no managed-only features"],
      domain: "storage",
    });
    assert.equal(rec.id, "d-1");
    assert.equal(rec.validated, false);
    assert.equal(rec.status, "active");
    assert.equal(rec.supersedes, null);
    assert.equal(rec.superseded_by, null);
    assert.equal(rec.created_at, "2026-10-27T12:00:00.000Z");
    assert.deepEqual(rec.evidence, []);
    assert.equal(rec.answer, null);

    const expanded = trail.expand({ id: "d-1" });
    assert.deepEqual(expanded, rec);

    // Persisted as one JSON document; a fresh instance reads it back.
    assert.ok(existsSync(dbPath));
    const onDisk = JSON.parse(readFileSync(dbPath, "utf8"));
    assert.equal(onDisk.records.length, 1);
    const fresh = new DecisionTrail({ store: new FileStore(dbPath) });
    assert.equal(fresh.expand({ id: "d-1" }).text, "Use Postgres for the billing store");
  });

  it("defaults the domain to general and constraints/evidence to empty", () => {
    const { trail } = makeTrail();
    const rec = trail.commit({ text: "Keep it simple" });
    assert.equal(rec.domain, "general");
    assert.deepEqual(rec.constraints, []);
  });

  it("starts empty when the store file is missing", () => {
    const { trail } = makeTrail();
    const status = trail.status({});
    assert.equal(status.counts.total, 0);
    assert.deepEqual(trail.suggest({ query: "anything" }), []);
  });
});

describe("log_decision", () => {
  it("creates a validated record from constraints, evidence and answer", () => {
    const { trail } = makeTrail();
    const rec = trail.logDecision({
      constraints: ["latency under 100ms"],
      evidence: ["benchmark run 42", "load test report"],
      answer: "Adopt the in-process cache",
      domain: "performance",
    });
    assert.equal(rec.validated, true);
    assert.equal(rec.answer, "Adopt the in-process cache");
    assert.equal(rec.text, "Adopt the in-process cache"); // falls back to answer
    assert.deepEqual(rec.evidence, ["benchmark run 42", "load test report"]);

    const withText = trail.logDecision({
      constraints: ["c"],
      evidence: ["e"],
      answer: "the answer",
      text: "a summary",
    });
    assert.equal(withText.text, "a summary");
    assert.equal(withText.id, "d-2");
  });
});

describe("suggest and search_precedents", () => {
  function seeded() {
    const ctx = makeTrail();
    const { trail } = ctx;
    trail.commit({
      text: "Use Redis for session storage",
      constraints: ["sessions must expire quickly"],
      domain: "storage",
    }); // d-1, unvalidated
    ctx.advanceDays(1);
    trail.logDecision({
      constraints: ["durable sessions"],
      evidence: ["incident review"],
      answer: "Use Postgres for session storage",
      text: "Postgres session storage decision",
      domain: "storage",
    }); // d-2, validated
    ctx.advanceDays(1);
    trail.commit({ text: "Redis cache for session tokens", domain: "storage" }); // d-3
    return ctx;
  }

  it("suggest returns ranked pointers over all records, newest first on ties", () => {
    const { trail } = seeded();
    const pointers = trail.suggest({ query: "redis session storage" });
    // d-1 matches all 3 query tokens and leads; d-2 and d-3 match 2 each
    // and the tie is broken by recency, so the newer d-3 comes first.
    assert.deepEqual(
      pointers.map((p) => p.id),
      ["d-1", "d-3", "d-2"],
    );
    assert.equal(pointers[0].text, "Use Redis for session storage");
    assert.equal(pointers[0].validated, false);
    assert.equal(pointers[0].status, "active");
    assert.equal(pointers[0].domain, "storage");
    // Pointers are short: no constraints/evidence fields.
    assert.deepEqual(Object.keys(pointers[0]).sort(), [
      "domain",
      "id",
      "status",
      "text",
      "validated",
    ]);
  });

  it("suggest truncates pointer text at 120 chars", () => {
    const { trail } = makeTrail();
    const long = "cache ".repeat(40).trim(); // 239 chars, token "cache"
    trail.commit({ text: long });
    const pointers = trail.suggest({ query: "cache" });
    assert.equal(pointers.length, 1);
    assert.equal(pointers[0].text.length, 120);
    assert.equal(pointers[0].text, long.slice(0, 120));
  });

  it("suggest honours limit", () => {
    const { trail } = seeded();
    assert.equal(trail.suggest({ query: "redis session storage", limit: 2 }).length, 2);
    assert.equal(trail.suggest({ query: "redis session storage", limit: 1 }).length, 1);
  });

  it("suggest returns nothing when no token overlaps", () => {
    const { trail } = seeded();
    assert.deepEqual(trail.suggest({ query: "kubernetes ingress" }), []);
  });

  it("search_precedents returns full records, validated only", () => {
    const { trail } = seeded();
    const hits = trail.searchPrecedents({ query: "session storage" });
    assert.deepEqual(
      hits.map((h) => h.id),
      ["d-2"],
    );
    assert.equal(hits[0].validated, true);
    assert.deepEqual(hits[0].evidence, ["incident review"]);
    assert.equal(hits[0].answer, "Use Postgres for session storage");
  });
});

describe("supersede", () => {
  it("links both ways and marks the old record superseded", () => {
    const { trail } = makeTrail();
    trail.commit({ text: "Ship weekly", constraints: ["fridays only"], domain: "process" });
    const successor = trail.supersede({
      id: "d-1",
      text: "Ship daily",
      constraints: ["automated rollback required"],
    });
    assert.equal(successor.id, "d-2");
    assert.equal(successor.supersedes, "d-1");
    assert.equal(successor.domain, "process"); // inherits the old domain
    assert.equal(successor.status, "active");

    const old = trail.expand({ id: "d-1" });
    assert.equal(old.status, "superseded");
    assert.equal(old.superseded_by, "d-2");

    const status = trail.status({});
    assert.equal(status.counts.active, 1);
    assert.equal(status.counts.superseded, 1);
  });
});

describe("get_context", () => {
  it("groups active records by domain with validated counts and latest text", () => {
    const ctx = makeTrail();
    const { trail } = ctx;
    trail.commit({ text: "first storage call", domain: "storage" });
    ctx.advanceDays(1);
    trail.logDecision({
      constraints: ["c"],
      evidence: ["e"],
      answer: "second storage call",
      domain: "storage",
    });
    trail.commit({ text: "a ui call", domain: "ui" });
    trail.commit({ text: "no domain here" });
    trail.supersede({ id: "d-3", text: "a ui call revised" }); // d-3 no longer active

    const context = trail.getContext({});
    const byDomain = Object.fromEntries(context.domains.map((g) => [g.domain, g]));
    assert.equal(byDomain.storage.active, 2);
    assert.equal(byDomain.storage.validated, 1);
    assert.equal(byDomain.storage.latest_text, "second storage call");
    assert.equal(byDomain.ui.active, 1);
    assert.equal(byDomain.ui.latest_text, "a ui call revised");
    assert.equal(byDomain.general.active, 1);
    assert.equal(context.totals.total, 5);
    assert.equal(context.totals.active, 4);
  });
});

describe("status and competency", () => {
  it("status reports agent, project, path and counts", () => {
    const { trail, dbPath } = makeTrail();
    trail.commit({ text: "one" });
    trail.logDecision({ constraints: ["c"], evidence: ["e"], answer: "two" });
    trail.supersede({ id: "d-1", text: "one revised" });
    const status = trail.status({});
    assert.equal(status.agent, "test-agent");
    assert.equal(status.project, "test-project");
    assert.equal(status.database_path, dbPath);
    assert.deepEqual(status.counts, { total: 3, active: 2, superseded: 1, validated: 1 });
  });

  it("competency is counts and coverage from validated records only", () => {
    const { trail } = makeTrail();
    trail.commit({ text: "unvalidated storage", domain: "storage" });
    trail.logDecision({ constraints: ["c"], evidence: ["e"], answer: "v1", domain: "storage" });
    trail.logDecision({ constraints: ["c"], evidence: ["e"], answer: "v2", domain: "ui" });
    trail.commit({ text: "unvalidated ui", domain: "ui" });
    const comp = trail.getCompetency({});
    assert.equal(comp.validated_total, 2);
    assert.equal(comp.coverage, 0.5);
    assert.deepEqual(comp.by_domain, {
      storage: { validated: 1, active: 1 },
      ui: { validated: 1, active: 1 },
    });
  });

  it("competency coverage is 0 on an empty store", () => {
    const { trail } = makeTrail();
    assert.deepEqual(trail.getCompetency({}), {
      validated_total: 0,
      by_domain: {},
      coverage: 0,
    });
  });
});

describe("consolidate", () => {
  it("flags same-domain near-duplicates at Jaccard >= 0.6 and mutates nothing", () => {
    const { trail, dbPath } = makeTrail();
    trail.commit({
      text: "use redis for session cache storage",
      constraints: ["fast expiry"],
      domain: "storage",
    });
    trail.commit({
      text: "use redis for session cache storage",
      constraints: ["fast expiry"],
      domain: "storage",
    });
    trail.commit({ text: "completely different topic about hiring", domain: "storage" });
    trail.commit({
      text: "use redis for session cache storage",
      constraints: ["fast expiry"],
      domain: "other-domain", // same text, different domain: not a pair
    });
    const before = readFileSync(dbPath, "utf8");
    const result = trail.consolidate({});
    assert.equal(result.duplicates.length, 1);
    assert.deepEqual([result.duplicates[0].first, result.duplicates[0].second], ["d-1", "d-2"]);
    assert.equal(result.duplicates[0].similarity, 1);
    assert.deepEqual(result.clusters, [["d-1", "d-2"]]);
    assert.equal(readFileSync(dbPath, "utf8"), before); // no mutation
    assert.equal(trail.status({}).counts.total, 4);
  });

  it("flags stale active records older than 90 days, not superseded or fresh ones", () => {
    const ctx = makeTrail("2026-01-01T00:00:00.000Z");
    const { trail } = ctx;
    trail.commit({ text: "an old decision" }); // d-1
    trail.commit({ text: "an old decision to replace" }); // d-2
    trail.supersede({ id: "d-2", text: "replacement" }); // d-2 superseded, d-3 active but also old
    ctx.setNow("2026-05-01T00:00:00.000Z"); // 120 days later
    trail.commit({ text: "a fresh decision" }); // d-4
    const result = trail.consolidate({});
    assert.deepEqual(
      result.stale.map((s) => s.id),
      ["d-1", "d-3"],
    );
    assert.equal(result.stale[0].age_days, 120);
  });

  it("returns empty candidates on an empty store", () => {
    const { trail } = makeTrail();
    assert.deepEqual(trail.consolidate({}), { duplicates: [], clusters: [], stale: [] });
  });
});

describe("errors", () => {
  it("unknown decision ids produce an honest error naming the id", () => {
    const { trail } = makeTrail();
    trail.commit({ text: "something" });
    assert.throws(() => trail.expand({ id: "d-99" }), /unknown decision id "d-99"/);
    assert.throws(
      () => trail.supersede({ id: "nope", text: "replacement" }),
      /unknown decision id "nope"/,
    );
  });

  it("missing required arguments are ValidationErrors", () => {
    const { trail } = makeTrail();
    assert.throws(() => trail.commit({}), ValidationError);
    assert.throws(() => trail.commit({}), /missing required argument "text"/);
    assert.throws(() => trail.logDecision({ constraints: ["c"] }), /missing required argument "evidence"/);
    assert.throws(() => trail.expand({}), /missing required argument "id"/);
    assert.throws(() => trail.suggest({}), /missing required argument "query"/);
    assert.throws(() => trail.supersede({ id: "d-1" }), /missing required argument "text"/);
  });

  it("wrongly-typed arguments are ValidationErrors", () => {
    const { trail } = makeTrail();
    assert.throws(() => trail.commit({ text: 42 }), /argument "text" must be a string/);
    assert.throws(
      () => trail.commit({ text: "x", constraints: "not-an-array" }),
      /argument "constraints" must be an array of strings/,
    );
    assert.throws(
      () => trail.commit({ text: "x", constraints: ["ok", 7] }),
      /argument "constraints" must be an array of strings/,
    );
    assert.throws(
      () => trail.logDecision({ constraints: ["c"], evidence: ["e"], answer: 1 }),
      ValidationError,
    );
    assert.throws(() => trail.suggest({ query: "q", limit: 0 }), /argument "limit" must be a positive integer/);
    assert.throws(() => trail.suggest({ query: "q", limit: 2.5 }), ValidationError);
    assert.throws(() => trail.suggest({ query: "q", limit: "3" }), ValidationError);
    assert.throws(() => trail.dispatch("elen_commit", "nope"), ValidationError);
    assert.throws(() => trail.dispatch("elen_nope", {}), /unknown tool "elen_nope"/);
  });
});

describe("persistence across instances", () => {
  it("ids keep increasing across store reloads", () => {
    const { trail, dbPath } = makeTrail();
    trail.commit({ text: "first" });
    const fresh = new DecisionTrail({ store: new FileStore(dbPath) });
    const second = fresh.commit({ text: "second" });
    assert.equal(second.id, "d-2");
  });
});
