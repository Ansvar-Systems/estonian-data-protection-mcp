#!/usr/bin/env node

/**
 * Estonian Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying AKI decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: ee_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "estonian-data-protection-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "ee_dp_search_decisions",
    description:
      "Full-text search across AKI (Andmekaitse Inspektsioon) decisions and sanctions. Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'küpsised', 'töötajate jälgimine', 'andmeleke')",
        },
        type: {
          type: "string",
          enum: ["sanction", "warning", "reprimand", "decision"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'consent', 'cookies', 'data_breach'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
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
        reference: {
          type: "string",
          description: "AKI decision reference (e.g., 'AKI-2022-001')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "ee_dp_search_guidelines",
    description:
      "Search AKI guidance documents: recommendations, guidelines, and FAQs on GDPR implementation in Estonia.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'DPIA', 'küpsised', 'andmesubjekti õigused')",
        },
        type: {
          type: "string",
          enum: ["guide", "recommendation", "faq", "template"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ee_dp_get_guideline",
    description:
      "Get a specific AKI guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from ee_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "ee_dp_list_topics",
    description:
      "List all covered data protection topics with Estonian and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ee_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
        return textContent({ results, count: results.length });
      }

      case "ee_dp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.reference);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.reference}`);
        }
        const decisionRecord = decision as unknown as Record<string, unknown>;
        return textContent({
          ...decisionRecord,
          _citation: buildCitation(
            String(decisionRecord.reference ?? parsed.reference),
            String(decisionRecord.title ?? decisionRecord.reference ?? parsed.reference),
            "ee_dp_get_decision",
            { reference: parsed.reference },
            decisionRecord.url as string | undefined,
          ),
        });
      }

      case "ee_dp_search_guidelines": {
        const parsed = SearchGuidelinesArgs.parse(args);
        const results = searchGuidelines({
          query: parsed.query,
          type: parsed.type,
          topic: parsed.topic,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "ee_dp_get_guideline": {
        const parsed = GetGuidelineArgs.parse(args);
        const guideline = getGuideline(parsed.id);
        if (!guideline) {
          return errorContent(`Guideline not found: id=${parsed.id}`);
        }
        const guidelineRecord = guideline as unknown as Record<string, unknown>;
        return textContent({
          ...guidelineRecord,
          _citation: buildCitation(
            String(guidelineRecord.reference ?? guidelineRecord.id ?? parsed.id),
            String(guidelineRecord.title ?? guidelineRecord.reference ?? `Guideline ${parsed.id}`),
            "ee_dp_get_guideline",
            { id: String(parsed.id) },
            guidelineRecord.url as string | undefined,
          ),
        });
      }

      case "ee_dp_list_topics": {
        const topics = listTopics();
        return textContent({ topics, count: topics.length });
      }

      case "ee_dp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "AKI (Andmekaitse Inspektsioon — Data Protection Inspectorate) MCP server. Provides access to Estonian data protection authority decisions, sanctions, and official guidance documents.",
          data_source: "AKI (https://www.aki.ee/)",
          coverage: {
            decisions: "AKI decisions, sanctions, warnings, and reprimands",
            guidelines: "AKI guides, recommendations, and FAQs",
            topics: "Cookies, employee monitoring, video surveillance, data breach, consent, DPIA, transfers, data subject rights",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
