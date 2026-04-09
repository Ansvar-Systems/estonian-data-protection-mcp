#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
  getDataFreshness,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "estonian-data-protection-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "ee_dp_search_decisions",
    description:
      "Full-text search across AKI (Andmekaitse Inspektsioon) decisions and sanctions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'küpsised', 'töötajate jälgimine')" },
        type: {
          type: "string",
          enum: ["sanction", "warning", "reprimand", "decision"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ee_dp_get_decision",
    description:
      "Get a specific AKI decision by reference number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Decision reference number" },
      },
      required: ["reference"],
    },
  },
  {
    name: "ee_dp_search_guidelines",
    description:
      "Search AKI guidance documents on GDPR implementation in Estonia.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        type: {
          type: "string",
          enum: ["guide", "recommendation", "faq", "template"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ee_dp_get_guideline",
    description: "Get a specific AKI guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "ee_dp_list_topics",
    description: "List all covered data protection topics with Estonian and English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ee_dp_list_sources",
    description:
      "List the data sources and collections available in this MCP: decisions corpus and guidelines corpus with record counts and newest record dates.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ee_dp_check_data_freshness",
    description:
      "Check when the local database was last updated. Returns record counts and the date of the most recent decision and guideline ingested.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ee_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["sanction", "warning", "reprimand", "decision"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["guide", "recommendation", "faq", "template"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- Meta helper -------------------------------------------------------------

const META_BASE = {
  disclaimer: "This is not legal advice. Verify all information with official AKI sources.",
  source_url: "https://www.aki.ee/",
  copyright: "AKI (Andmekaitse Inspektsioon)",
};

function addMeta(toolName: string, data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, _meta: { ...META_BASE, tool: toolName } };
}

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string) {
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "ee_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          return textContent(addMeta("ee_dp_search_decisions", { results, count: results.length }));
        }

        case "ee_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.reference}`);
          }
          const decisionRecord = decision as Record<string, unknown>;
          return textContent(addMeta("ee_dp_get_decision", {
            ...decisionRecord,
            _citation: buildCitation(
              String(decisionRecord["reference"] ?? parsed.reference),
              String(decisionRecord["title"] ?? decisionRecord["reference"] ?? parsed.reference),
              "ee_dp_get_decision",
              { reference: parsed.reference },
              decisionRecord["url"] as string | undefined,
            ),
          }));
        }

        case "ee_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          return textContent(addMeta("ee_dp_search_guidelines", { results, count: results.length }));
        }

        case "ee_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) {
            return errorContent(`Guideline not found: id=${parsed.id}`);
          }
          const guidelineRecord = guideline as Record<string, unknown>;
          return textContent(addMeta("ee_dp_get_guideline", {
            ...guidelineRecord,
            _citation: buildCitation(
              String(guidelineRecord["reference"] ?? guidelineRecord["id"] ?? parsed.id),
              String(guidelineRecord["title"] ?? guidelineRecord["reference"] ?? `Guideline ${parsed.id}`),
              "ee_dp_get_guideline",
              { id: String(parsed.id) },
              guidelineRecord["url"] as string | undefined,
            ),
          }));
        }

        case "ee_dp_list_topics": {
          const topics = listTopics();
          return textContent(addMeta("ee_dp_list_topics", { topics, count: topics.length }));
        }

        case "ee_dp_list_sources": {
          const freshness = getDataFreshness();
          return textContent(addMeta("ee_dp_list_sources", {
            sources: [
              {
                id: "decisions",
                label: "AKI Decisions and Sanctions",
                authority: "AKI (Andmekaitse Inspektsioon)",
                url: "https://www.aki.ee/ettekirjutused",
                record_count: freshness.decisions_count,
                newest_record: freshness.decisions_newest,
              },
              {
                id: "guidelines",
                label: "AKI Guidance Documents",
                authority: "AKI (Andmekaitse Inspektsioon)",
                url: "https://www.aki.ee/kiirelt-katte/juhendid",
                record_count: freshness.guidelines_count,
                newest_record: freshness.guidelines_newest,
              },
            ],
          }));
        }

        case "ee_dp_check_data_freshness": {
          const freshness = getDataFreshness();
          return textContent(addMeta("ee_dp_check_data_freshness", { ...freshness }));
        }

        case "ee_dp_about": {
          return textContent(addMeta("ee_dp_about", {
            name: SERVER_NAME,
            version: pkgVersion,
            description: "AKI (Andmekaitse Inspektsioon) MCP server. Provides access to Estonian data protection authority decisions and guidance.",
            data_source: "AKI (https://www.aki.ee/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
          }));
        }

        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Error executing ${name}: ${message}`);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
