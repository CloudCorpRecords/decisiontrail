# decisiontrail

decisiontrail is a local decision memory for coding agents. When an
agent makes a call — which database, which cache, which release
cadence — decisiontrail records the decision together with the limits
it was made under, so a later session can find the precedent instead
of re-deciding from scratch, and can revise it explicitly when the
call changes.

Everything is local: decisions live in one JSON file on your machine.
There is no account, no login, and no network access. Records can be
plain commits or validated decision records (constraints, evidence and
an answer); validated records are the ones precedent search draws on.
Old decisions are never edited in place — a revision creates a new
record and marks the old one superseded, linked in both directions.

This package is a clean-room rebuild of the local surface of the
"elen" MCP server (10 of its 12 tools). The original's two
connected-mode beta tools, `elen_incoming` and `elen_team_search`,
need a hosted workspace, a login and an API key, and are not included.

## Install

```bash
npx @reneturcios/decisiontrail elen_status
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/decisiontrail
```

The container defaults to the MCP server (see below). Pass CLI
arguments to use it as a CLI instead. If you run the container, mount
a volume over the store directory if you want decisions to persist.

## Where decisions live

- Store path: the `DECISIONTRAIL_DB` environment variable, or
  `~/.decisiontrail/decisions.json` by default.
- The file is a single JSON document. A missing file starts empty;
  writes are atomic (temp file, then rename), so a crash mid-write
  cannot truncate the store.
- `DECISIONTRAIL_AGENT` and `DECISIONTRAIL_PROJECT` name the
  namespace reported by `elen_status`; both default to `local`.

Decision IDs are sequential: `d-1`, `d-2`, … in creation order.

## CLI

One bin serves both faces. Each tool is a subcommand taking a single
JSON argument (optional for the no-argument tools); results print as
JSON.

```bash
# Check the namespace before committing
decisiontrail elen_status

# Commit a decision with its limits
decisiontrail elen_commit '{"text":"Use Postgres for sessions","constraints":["must be durable"],"domain":"storage"}'

# Record a validated decision
decisiontrail elen_log_decision '{"constraints":["latency under 100ms"],"evidence":["benchmark run 42"],"answer":"Adopt the in-process cache","domain":"performance"}'

# Before a new decision, ask for pointers; then search validated precedents
decisiontrail elen_suggest '{"query":"session storage"}'
decisiontrail elen_search_precedents '{"query":"session storage"}'

# Read one record in full, revise one, survey the store
decisiontrail elen_expand '{"id":"d-1"}'
decisiontrail elen_supersede '{"id":"d-1","text":"Use Redis for sessions with Postgres fallback"}'
decisiontrail elen_get_context
decisiontrail elen_get_competency
decisiontrail elen_consolidate

decisiontrail --version
```

Exit codes: `0` on success, `1` for a domain error (for example an
unknown decision ID — the error names the ID), `2` for usage errors
and invalid arguments.

## MCP server

```bash
npx -y @reneturcios/decisiontrail mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "decisiontrail": {
      "command": "npx",
      "args": ["-y", "@reneturcios/decisiontrail", "mcp"]
    }
  }
}
```

### Tools

| Tool | Input | What it returns |
| --- | --- | --- |
| `elen_commit` | `text` (required), `constraints` (string array), `domain` | The new unvalidated decision record. |
| `elen_log_decision` | `constraints`, `evidence`, `answer` (all required), `text`, `domain` | A validated decision record built from those inputs. |
| `elen_expand` | `id` (required) | The full record for that decision ID. |
| `elen_suggest` | `query` (required), `limit` (default 5) | Short pointers (`id`, first 120 chars of text, `domain`, `validated`, `status`) to prior decisions matching the query, best match first. Considers all records. |
| `elen_search_precedents` | `query` (required), `limit` (default 5) | Full records matching the query, validated records only. |
| `elen_supersede` | `id`, `text` (both required), `constraints`, `domain` | The new successor record; the old record is marked superseded and the two are linked both ways. |
| `elen_get_context` | — | Active decision threads grouped by domain, with per-domain counts and the latest text, plus totals. |
| `elen_status` | — | Agent, project, database path, and counts (total / active / superseded / validated). |
| `elen_get_competency` | — | Validated-record counts per domain and the validated share (coverage) of all records, derived from validated history only. |
| `elen_consolidate` | — | Duplicate pairs (same domain, token Jaccard at least 0.6), the clusters they form, and stale candidates (active records older than 90 days). Changes nothing. |

### How matching works

`elen_suggest` and `elen_search_precedents` rank by case-insensitive
token overlap between the query and a record's text plus constraints:
the score is the number of distinct query tokens present. Records with
no overlap are omitted; ties are broken by recency, newest first.

A record counts as validated only when it was created with
`elen_log_decision`. A committed decision that is later superseded
keeps its history: `supersedes` / `superseded_by` link the chain and
the old record's status becomes `superseded`.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, temp dirs, no network
npm run dev     # run the CLI from source via tsx
```

## License

MIT — see `LICENSE`.
