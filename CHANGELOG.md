# Changelog

## 0.1.0 (2026-10-27)

- Initial release. Local decision-memory store for coding agents,
  rebuilt from the local surface of the elen MCP server: 10 tools
  (`elen_commit`, `elen_log_decision`, `elen_expand`, `elen_suggest`,
  `elen_search_precedents`, `elen_supersede`, `elen_get_context`,
  `elen_status`, `elen_get_competency`, `elen_consolidate`). The
  original's connected-mode beta tools (`elen_incoming`,
  `elen_team_search`) are not included; they need a hosted workspace,
  a login and an API key.
- CLI: `decisiontrail <tool> '<json>'` subcommands for every tool,
  `decisiontrail mcp` for the stdio MCP server, `--version`.
- Store: one JSON document at `DECISIONTRAIL_DB` or
  `~/.decisiontrail/decisions.json`, written atomically; a missing
  file starts empty. Namespace from `DECISIONTRAIL_AGENT` /
  `DECISIONTRAIL_PROJECT` (default `local`).
