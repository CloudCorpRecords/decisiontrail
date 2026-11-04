# decisiontrail — Build Report

MCP Rebuild 100, batch 27. Clean-room rebuild of `com.learningnodes/elen`
v0.3.1 (npm `@learningnodes/elen-mcp`, "Elen"), built from the spec in
`specs-batch27/decisiontrail.md` and the fixture
`harness/fixtures/elen-tools-original.json` only. Local build only —
nothing pushed or published.

Identity: repo `decisiontrail`, npm `@reneturcios/decisiontrail`,
MCP name `io.github.CloudCorpRecords/decisiontrail`, version `0.1.0`.

## Labelled subset — 10 of 12 tools

Built (all local): `elen_commit`, `elen_log_decision`, `elen_expand`,
`elen_suggest`, `elen_search_precedents`, `elen_supersede`,
`elen_get_context`, `elen_status`, `elen_get_competency`,
`elen_consolidate`. Tool names keep the original `elen_` prefix.

**Omitted: `elen_incoming` and `elen_team_search`.** The original
README marks both "Connected mode, beta": they read a hosted workspace
and need `elen login` and an API key. They are not part of the local
surface and are omitted, as the spec directs.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `decisiontrail: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Local decision memory for coding agents:
  record decisions with limits, search precedents, supersede." =
  **100 chars** (≤100 ✓, verified programmatically); npm entry carries
  `version: 0.1.0`; OCI entry `ghcr.io/cloudcorprecords/decisiontrail:0.1.0`
  carries **no** `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT
  `node /app/dist/cli.js`, CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/decisiontrail"`
- `tsconfig.json` (byte-identical to the fleet template), `.gitignore`,
  `LICENSE` (MIT, Copyright (c) 2026 Rene Turcios), `README.md` (fresh
  text), `CHANGELOG.md` (single 0.1.0 entry, 2026-10-27)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/decisiontrail.ts` (core logic, `VERSION = "0.1.0"`)
- `test/decisiontrail.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (fleet workflows; image name and smoke-test server name adapted)

Plus this report and `parity-out/` (harness output).

## Implementation notes

- **Low-level Server API, no McpServer/zod in the serving path:**
  `src/mcp.ts` uses the SDK's low-level `Server` with explicit schema
  literals copied exactly from the fixture (names, descriptions,
  properties, required sets). The high-level helper's zod-to-JSON-Schema
  conversion would inject `$schema` / `additionalProperties` keys that
  are not in the spec and would break exact parity. (`zod` remains a
  declared dependency for fleet-template consistency; nothing imports
  it.) The core validates arguments itself: a missing required argument
  or a wrongly-typed one raises `ValidationError`, which the MCP layer
  maps to `McpError` **InvalidParams** (JSON-RPC -32602, verified on
  the wire) and the CLI maps to exit 2. An unknown decision id is an
  honest domain error naming the id (MCP `isError` result; CLI exit 1).
- **Pure core over injectable dependencies:** `DecisionTrail` takes a
  `Store` (load/save + path) and a `now()` clock. `FileStore` is the
  production store; tests also run against `FileStore` on temp dirs.
- **CLI:** `decisiontrail mcp` (stdio server), `decisiontrail --version`,
  and `decisiontrail <tool> '<json>'` for each of the 10 tools,
  printing the JSON result. Exit codes: 0 success, 1 domain error,
  2 usage/validation error.

## Reconstruction decisions (ALL labelled, per the spec)

The original publishes one-line semantics per tool and no argument
tables; everything below is the spec's labelled reconstruction,
followed exactly, plus the small judgement calls itemised at the end.

1. **Storage engine — JSON, not SQLite.** The original keeps decisions
   in a local SQLite file (default `~/.elen/decisions.db`). The factory
   set has no SQLite dependency, so the rebuild stores one JSON
   document at `DECISIONTRAIL_DB` (env override) or
   `~/.decisiontrail/decisions.json`. A missing file starts empty;
   writes are atomic (sibling temp file + rename). Storage is an
   internal detail; the tool surface is what is rebuilt.
2. **Document shape:** `{next_id, records[]}` — `next_id` persists the
   sequential id counter across reloads.
3. **Record shape:** `{id, text, constraints[], domain, evidence[],
   answer, validated, status: active|superseded, supersedes,
   superseded_by, created_at}`. IDs are sequential `d-1, d-2, …` in
   creation order. `created_at` is an ISO 8601 instant from the
   injectable clock.
4. **Arguments** (per tool, exactly as the spec lists them):
   `elen_commit {text (req), constraints?, domain?}`;
   `elen_log_decision {constraints (req), evidence (req), answer (req),
   text?, domain?}`; `elen_expand {id (req)}`;
   `elen_suggest {query (req), limit?}`;
   `elen_search_precedents {query (req), limit?}`;
   `elen_supersede {id (req), text (req), constraints?, domain?}`;
   the remaining four tools take no arguments.
5. **Ranking (suggest/search):** case-insensitive token overlap between
   the query and a record's text + constraints (tokens are maximal
   `[a-z0-9]+` runs, lowercased; score = matched distinct query
   tokens). Ties broken by recency (newest `created_at` first, then
   highest id). Records with zero overlap are omitted. Default limit 5.
6. **Suggest vs search distinction:** `elen_suggest` considers **all**
   records and returns short pointers `{id, text (first 120 chars),
   domain, validated, status}`; `elen_search_precedents` considers
   **validated records only** and returns full records.
7. **Supersede linking:** the successor is a new record with
   `supersedes` set to the old id; the old record's status becomes
   `superseded` and its `superseded_by` points at the successor.
8. **Context grouping:** active records grouped by domain (missing
   domain → `"general"`), each group `{domain, active, validated,
   latest_text}` plus totals.
9. **Status:** `{agent, project, database_path, counts {total, active,
   superseded, validated}}`; agent/project from `DECISIONTRAIL_AGENT` /
   `DECISIONTRAIL_PROJECT`, default `"local"`.
10. **Competency — counts and coverage only, no invented scoring:**
    derived from validated records only: `{validated_total, by_domain
    {domain: {validated, active}}, coverage}`, where coverage is the
    validated share of all records (0 when empty).
11. **Consolidate thresholds:** duplicates = pairs of **active**
    records in the **same domain** whose Jaccard similarity over
    text + constraints tokens is **≥ 0.6**; stale = **active** records
    created **more than 90 days** before now (injectable clock).
    Consolidate returns candidates only and **mutates nothing**
    (verified: store file byte-identical across a call).
12. **Unknown id** (expand/supersede) → honest error naming the id.
13. **Results are JSON text** in both the CLI and MCP surfaces.

### Judgement calls inside the labelled reconstruction (flagged, not hidden)

- `elen_log_decision` with no `text`: the record's `text` falls back to
  its `answer` (a record needs a text for search/context to show).
- Domain default: a record created without a domain is stored with
  domain `"general"` (the same label `elen_get_context` groups under).
- Supersede successor: created like a commit (`validated: false`,
  `evidence: []`, `answer: null`); when no domain is given it inherits
  the superseded record's domain.
- `elen_get_context` result shape: `{domains: [...], totals: {total,
  active, validated}}`, groups sorted by domain name; `latest_text` is
  the newest active record's full text; totals' `validated` counts
  validated records among the active set.
- `elen_get_competency` `by_domain`: built from validated records
  only, so a domain with no validated records does not appear;
  `active` counts that domain's validated records still active.
- `elen_consolidate` result shape: `{duplicates: [{first, second,
  domain, similarity}], clusters, stale: [{id, text (120 chars),
  domain, created_at, age_days}]}`. `similarity` is the Jaccard value
  rounded to 3 decimals. `clusters` are the connected components
  (size ≥ 2) of the duplicate-pair graph — the spec's pinned semantics
  say consolidate "suggests clusters and duplicate or stale
  candidates" but only define the duplicate/stale tests, so clusters
  are derived from the duplicate pairs rather than a second,
  invented clustering rule.
- Token matching is exact (no stemming): `session` does not match
  `sessions`. This follows the spec's "token overlap" wording
  literally.
- `limit`, when given, must be a positive integer; anything else is a
  validation error rather than being silently coerced.
- Empty-string values for required string arguments are validation
  errors.

### Ambiguities in the source spec

None were invented around: every behaviour the spec pins is
implemented as written, and every behaviour it leaves open is listed
above as a labelled reconstruction or a flagged judgement call. The
one genuinely underdetermined area is the *result shapes* of
`elen_get_context` / `elen_consolidate` beyond the fields the spec
names; the shapes chosen keep exactly the named fields and add only
the totals/cluster structure flagged above.

## Verification (exact outputs)

### 1. Typecheck and build
```
$ ./node_modules/.bin/tsc --noEmit ; echo exit=$?
exit=0
$ npm run build   # tsc -> dist/
exit=0
$ node dist/cli.js --version
0.1.0
```

### 2. Tests
```
$ npm test   # tsx --test test/*.test.ts
ℹ tests 21
ℹ pass 21
ℹ fail 0
```
Covers: commit→expand round trip (including reload from the JSON file
on disk and id continuity across instances), `elen_log_decision`
validated flag + text fallback, suggest pointer shape/ranking
(score, then recency tiebreak)/120-char truncation/limit,
search validated-only with full records, supersede links both ways +
old record status, get_context grouping, status counts,
competency coverage (incl. empty store = 0), consolidate
duplicate + stale detection with the store file proven unmutated,
unknown-id errors naming the id, and argument validation
(missing required, wrong types, bad limits, non-object args,
unknown tool dispatch). All against temp directories; no network.
(One test was fixed during the run: an early draft expected the
wrong winner of a suggest limit check — two same-score records at
the same instant tie-break to the higher id; the test now checks
truncation and limit separately. Behaviour was per spec throughout.)

### 3. CLI and MCP smoke (temp DECISIONTRAIL_DB)
CLI: commit → `d-1` unvalidated; log_decision → `d-2` validated;
search_precedents found the validated record; status reported the
env-supplied agent/project and the temp path; unknown id exited 1
with `error: elen_expand: unknown decision id "d-99"`; missing
argument exited 2; unknown subcommand exited 2 with Usage.
MCP over stdio: initialize → `serverInfo {name: "decisiontrail",
version: "0.1.0"}`; tools/call commit → `d-1`; tools/call with a
missing required argument → JSON-RPC error `-32602` (InvalidParams);
tools/call expand on `d-42` → `isError` result naming `d-42`;
suggest returned the committed record as a pointer.

### 4. Parity (harness, tools-file mode)
```
$ python3 parity.py --original fixtures/elen-tools-original.json \
    --rebuild "stdio:node .../builds/decisiontrail/dist/cli.js mcp" \
    --out .../builds/decisiontrail/parity-out
verdict=PASS parity_pct=100.0 original_tools=10 rebuild_tools=10 missing=[] extra=[] schema_diffs=[]
(exit 0)
```
(Fixtures are skipped in tools-file mode by harness design; the
rebuild side was exercised live over stdio, as recorded in §3.)

## Lockfile status

`package-lock.json` was generated clean via LOCKFILE-ROUTE.md
**Route 3** (`npm install --package-lock-only --ignore-scripts
--offline`, from the local npm cache; no `node_modules` present at
generation time). Verified after generation: parses as JSON,
`name` = `@reneturcios/decisiontrail`, lockfileVersion 3,
**128 package entries**. `node_modules` was installed afterwards
(offline, from the same cache) solely to build and test locally; it
is gitignored and not part of the deliverable.

## Blockers

None for the local build. Notes for the publish wave:

- Container build not exercised locally (no Docker run in this wave);
  the publish-container workflow smoke-tests the image at publish time.
- No EPERM staging was needed: all writes landed directly in the
  build directory.
