/**
 * decisiontrail MCP server. Tools: the 10 local elen_* tools.
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects keys that are not in
 * this tool's public spec ("$schema" and "additionalProperties"), which
 * breaks exact tool-list/schema parity with the spec. This file serves
 * tools/list with the spec's exact input schemas as explicit literals,
 * and the core validates every tools/call argument set itself:
 * missing or wrongly-typed arguments raise McpError InvalidParams,
 * while domain errors (e.g. an unknown decision id, named in the
 * message) come back as isError results.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { DecisionTrail, ValidationError, VERSION } from "./decisiontrail.js";

const TOOLS = [
  {
    name: "elen_commit",
    description: "Commits a new decision to the graph, with its constraints as a plain-text list.",
    inputSchema: {
      type: "object" as const,
      properties: {
        constraints: {
          description: "The limits that bound the decision, as plain-text entries",
          items: { type: "string" },
          type: "array",
        },
        domain: { description: "Optional domain the decision belongs to", type: "string" },
        text: { description: "The decision itself", type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "elen_log_decision",
    description: "Creates a validated Decision Record from constraints, evidence and an answer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        answer: { description: "The answer the decision records", type: "string" },
        constraints: {
          description: "The constraints the record was validated against",
          items: { type: "string" },
          type: "array",
        },
        domain: { description: "Optional domain the record belongs to", type: "string" },
        evidence: {
          description: "The evidence supporting the record",
          items: { type: "string" },
          type: "array",
        },
        text: { description: "Optional summary text for the record", type: "string" },
      },
      required: ["constraints", "evidence", "answer"],
    },
  },
  {
    name: "elen_expand",
    description: "Expands a decision ID into its full constraints and text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { description: "The decision ID to expand", type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "elen_suggest",
    description: "Retrieves short pointers to prior decisions before you make a new one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { description: "Maximum number of pointers to return (default 5)", type: "integer" },
        query: { description: "What the new decision is about", type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "elen_search_precedents",
    description: "Searches validated decisions for precedents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { description: "Maximum number of records to return (default 5)", type: "integer" },
        query: { description: "The topic to find precedents for", type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "elen_supersede",
    description: "Revises an older decision and marks it superseded by a new one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        constraints: {
          description: "The new decision's constraints, as plain-text entries",
          items: { type: "string" },
          type: "array",
        },
        domain: { description: "Optional domain for the new decision", type: "string" },
        id: { description: "The ID of the decision being superseded", type: "string" },
        text: { description: "The new decision that replaces the old one", type: "string" },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "elen_get_context",
    description: "Gives an overview of active decision threads grouped by domain, for the start of a session.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "elen_status",
    description: "Returns the agent, project, database path and counts, to check the namespace before committing.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "elen_get_competency",
    description: "Shows the competency profile for this agent, built from its validated decision history.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "elen_consolidate",
    description: "Suggests clusters and duplicate or stale candidates without changing the graph.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "decisiontrail", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const known = TOOLS.some((t) => t.name === name);
  if (!known) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  try {
    const trail = DecisionTrail.fromEnv();
    return textResult(trail.dispatch(name, args ?? {}));
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new McpError(ErrorCode.InvalidParams, err.message);
    }
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
