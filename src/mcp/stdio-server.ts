import { parseLanguages } from "../config.js";
import { indexRepository } from "../indexer/index-repository.js";
import { updateFromDiff } from "../incremental/update-from-diff.js";
import { describeTool, describeTools } from "./tool-guidance.js";
import {
  validateHybridSearchArgs,
  validateImpactFromDiffArgs,
  validateMethodUsageArgs,
  validateSymbolReferencesArgs
} from "./tool-validation.js";
import { queryImpactFromDiff } from "../query/impact-from-diff.js";
import { queryHybridSearch } from "../query/hybrid-search.js";
import { queryMethodUsage } from "../query/method-usage.js";
import { queryProcessFlow } from "../query/process-flow.js";
import { queryRelatedClusters } from "../query/related-clusters.js";
import { queryReferencesForFile } from "../query/references-for-file.js";
import { querySymbolNeighborhood } from "../query/symbol-neighborhood.js";
import { querySymbolReferences } from "../query/symbol-references.js";
import { renderGraphPage } from "../visualization/render-graph-page.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: JsonValue;
}

type ReferenceScope = "direct" | "expanded";
type RequestSource = "legacy" | "mcp_tool";

function normalizeLanguageCsv(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value)).join(",");
  }

  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw;
  }

  return "typescript,javascript,csharp";
}

function parseChangedFiles(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value).trim()).filter((value) => value.length > 0);
  }

  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function asObject(value: JsonValue | undefined): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function normalizeReferenceScope(raw: unknown): ReferenceScope {
  const value = asOptionalString(raw)?.toLowerCase();
  return value === "expanded" ? "expanded" : "direct";
}

function normalizeOptionalDirection(raw: unknown): "outbound" | "inbound" | "both" | undefined {
  const value = asOptionalString(raw);
  if (value === "outbound" || value === "inbound" || value === "both") {
    return value;
  }
  return undefined;
}

export function resolveReferenceScopeFlags(args: {
  scope?: unknown;
  includeExternalNameMatches?: unknown;
  includeAliasExpansion?: unknown;
}): {
  scope: ReferenceScope;
  includeExternalNameMatches: boolean;
  includeAliasExpansion: boolean;
} {
  const scope = normalizeReferenceScope(args.scope);
  const includeExternalNameMatches =
    asOptionalBoolean(args.includeExternalNameMatches) ?? scope === "expanded";
  const includeAliasExpansion =
    asOptionalBoolean(args.includeAliasExpansion) ?? scope === "expanded";
  return {
    scope,
    includeExternalNameMatches,
    includeAliasExpansion
  };
}

export function resolveReferenceFlagsBySource(
  args: {
    scope?: unknown;
    includeExternalNameMatches?: unknown;
    includeAliasExpansion?: unknown;
  },
  source: RequestSource
): {
  includeExternalNameMatches: boolean | undefined;
  includeAliasExpansion: boolean | undefined;
} {
  const includeExternalNameMatches = asOptionalBoolean(args.includeExternalNameMatches);
  const includeAliasExpansion = asOptionalBoolean(args.includeAliasExpansion);
  const scoped = resolveReferenceScopeFlags(args);
  return {
    includeExternalNameMatches: includeExternalNameMatches ?? scoped.includeExternalNameMatches,
    includeAliasExpansion: includeAliasExpansion ?? scoped.includeAliasExpansion
  };
}

export function resolveFileReferenceDirection(
  rawDirection: unknown,
  source: RequestSource
): "outbound" | "inbound" | "both" | undefined {
  return normalizeOptionalDirection(rawDirection) ?? (source === "mcp_tool" ? "inbound" : undefined);
}

export function resolveImpactOutputModeBySource(
  rawOutputMode: unknown,
  source: RequestSource
): "full" | "files_only" {
  const outputMode = asOptionalString(rawOutputMode);
  if (outputMode === "full" || outputMode === "files_only") {
    return outputMode;
  }
  return source === "mcp_tool" ? "files_only" : "full";
}

export function resolveSymbolReferenceOutputModeBySource(
  rawOutputMode: unknown,
  source: RequestSource
): "full" | "files_only" | undefined {
  const outputMode = asOptionalString(rawOutputMode);
  if (outputMode === "full" || outputMode === "files_only") {
    return outputMode;
  }
  return source === "mcp_tool" ? "files_only" : undefined;
}

export function normalizeStructuredContent(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  if (Array.isArray(result)) {
    return { items: result };
  }
  return { value: result ?? null };
}

export const MCP_QUERY_TOOL_NAMES = [
  "symbol_neighborhood",
  "symbol_references",
  "method_usage",
  "references_for_file",
  "hybrid_search",
  "impact_from_diff",
  "related_clusters",
  "process_flow"
] as const;

export const MCP_DISCOVERY_TOOL_NAMES = ["describe_tools", "describe_tool"] as const;

const MCP_TOOL_NAMES = new Set<string>([...MCP_QUERY_TOOL_NAMES, ...MCP_DISCOVERY_TOOL_NAMES]);

type TransportMode = "line" | "framed";

class RpcWriter {
  private mode: TransportMode = "line";

  public setMode(mode: TransportMode): void {
    this.mode = mode;
  }

  public write(payload: unknown): void {
    const body = JSON.stringify(payload);
    if (this.mode === "framed") {
      const size = Buffer.byteLength(body, "utf8");
      process.stdout.write(`Content-Length: ${size}\r\n\r\n${body}`);
      return;
    }

    process.stdout.write(`${body}\n`);
  }
}

async function executeLegacyMethod(
  method: string,
  params: Record<string, unknown>,
  source: RequestSource = "legacy"
): Promise<unknown> {
  switch (method) {
    case "describe_tools": {
      return describeTools([...MCP_QUERY_TOOL_NAMES]);
    }
    case "describe_tool": {
      const name = asOptionalString(params.name);
      if (!name) {
        throw new Error(
          'describe_tool: "name" is required. Hint: use {"name":"method_usage"} (or symbol_references, impact_from_diff, hybrid_search).'
        );
      }
      const guidance = describeTool(name);
      if (!guidance) {
        throw new Error(
          `describe_tool: unknown tool "${name}". Hint: call describe_tools for available names.`
        );
      }
      return guidance;
    }
    case "index_repo": {
      const repoPath = String(params.repoPath ?? "");
      const languageRaw = normalizeLanguageCsv(params.languages);
      const storeDir = asOptionalString(params.storeDir);
      return indexRepository({
        repoPath,
        languages: parseLanguages(languageRaw),
        storeDir
      });
    }
    case "update_from_diff": {
      const repoPath = String(params.repoPath ?? "");
      const languageRaw = normalizeLanguageCsv(params.languages);
      const changed = parseChangedFiles(params.changedFiles);
      const storeDir = asOptionalString(params.storeDir);

      return updateFromDiff({
        repoPath,
        languages: parseLanguages(languageRaw),
        changedFiles: changed,
        storeDir
      });
    }
    case "symbol_neighborhood": {
      const repoPath = String(params.repoPath ?? "");
      const symbol = String(params.symbol ?? "");
      const depth = Number(params.depth ?? 2);
      const limit = Number(params.limit ?? 100);
      const offset = Number(params.offset ?? 0);
      const edgeLimit = Number(params.edgeLimit ?? 500);
      const direction = asOptionalString(params.direction);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const storeDir = asOptionalString(params.storeDir);
      return querySymbolNeighborhood({
        repoPath,
        symbol,
        depth,
        limit,
        offset,
        edgeLimit,
        direction: direction as "outbound" | "inbound" | "both" | undefined,
        includeStructural,
        storeDir
      });
    }
    case "symbol_references": {
      const repoPath = String(params.repoPath ?? "");
      const symbol = String(params.symbol ?? "");
      const limit = Number(params.limit ?? 200);
      const offset = Number(params.offset ?? 0);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const matching = asOptionalString(params.matching);
      const { includeExternalNameMatches, includeAliasExpansion } = resolveReferenceFlagsBySource(
        {
          scope: params.scope,
          includeExternalNameMatches: params.includeExternalNameMatches,
          includeAliasExpansion: params.includeAliasExpansion
        },
        source
      );
      const outputMode = resolveSymbolReferenceOutputModeBySource(params.outputMode, source);
      const excludeSelf = asOptionalBoolean(params.excludeSelf);
      const testOnly = asOptionalBoolean(params.testOnly);
      const storeDir = asOptionalString(params.storeDir);
      validateSymbolReferencesArgs({
        repoPath,
        symbol,
        matching: matching as "prefer_qualified" | "qualified_only" | "name" | undefined
      });
      return querySymbolReferences({
        repoPath,
        symbol,
        limit,
        offset,
        includeStructural,
        matching: matching as "prefer_qualified" | "qualified_only" | "name" | undefined,
        includeExternalNameMatches,
        includeAliasExpansion,
        outputMode,
        excludeSelf,
        testOnly,
        storeDir
      });
    }
    case "method_usage": {
      const repoPath = String(params.repoPath ?? "");
      const symbol = String(params.symbol ?? "");
      const limit = Number(params.limit ?? 200);
      const offset = Number(params.offset ?? 0);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const { includeExternalNameMatches, includeAliasExpansion } = resolveReferenceFlagsBySource(
        {
          scope: params.scope,
          includeExternalNameMatches: params.includeExternalNameMatches,
          includeAliasExpansion: params.includeAliasExpansion
        },
        source
      );
      const outputMode = resolveSymbolReferenceOutputModeBySource(params.outputMode, source);
      const excludeSelf = asOptionalBoolean(params.excludeSelf);
      const testOnly = asOptionalBoolean(params.testOnly);
      const storeDir = asOptionalString(params.storeDir);
      validateMethodUsageArgs({
        repoPath,
        symbol
      });
      return queryMethodUsage({
        repoPath,
        symbol,
        limit,
        offset,
        includeStructural,
        includeExternalNameMatches,
        includeAliasExpansion,
        outputMode,
        excludeSelf,
        testOnly,
        storeDir
      });
    }
    case "references_for_file": {
      const repoPath = String(params.repoPath ?? "");
      const filePath = String(params.filePath ?? "");
      const direction = resolveFileReferenceDirection(params.direction, source);
      const limit = Number(params.limit ?? 200);
      const offset = Number(params.offset ?? 0);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const { includeExternalNameMatches, includeAliasExpansion } = resolveReferenceFlagsBySource(
        {
          scope: params.scope,
          includeExternalNameMatches: params.includeExternalNameMatches,
          includeAliasExpansion: params.includeAliasExpansion
        },
        source
      );
      const outputMode = asOptionalString(params.outputMode) ?? "files_only";
      const excludeSelf = asOptionalBoolean(params.excludeSelf);
      const testOnly = asOptionalBoolean(params.testOnly);
      const storeDir = asOptionalString(params.storeDir);
      return queryReferencesForFile({
        repoPath,
        filePath,
        direction: direction as "outbound" | "inbound" | "both" | undefined,
        limit,
        offset,
        includeStructural,
        includeExternalNameMatches,
        includeAliasExpansion,
        outputMode: outputMode as "full" | "files_only",
        excludeSelf,
        testOnly,
        storeDir
      });
    }
    case "hybrid_search": {
      const repoPath = String(params.repoPath ?? "");
      const query = String(params.query ?? "");
      const limit = Number(params.limit ?? 50);
      const offset = Number(params.offset ?? 0);
      const depth = Number(params.depth ?? 2);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const outputMode = asOptionalString(params.outputMode);
      const storeDir = asOptionalString(params.storeDir);
      validateHybridSearchArgs({
        repoPath,
        query
      });
      return queryHybridSearch({
        repoPath,
        query,
        limit,
        offset,
        depth,
        includeStructural,
        outputMode: outputMode as "full" | "files_only" | undefined,
        storeDir
      });
    }
    case "impact_from_diff": {
      const repoPath = String(params.repoPath ?? "");
      const changedFiles = parseChangedFiles(params.changedFiles);
      const symbols = parseChangedFiles(params.symbols);
      const depth = Number(params.depth ?? 2);
      const limit = Number(params.limit ?? 100);
      const offset = Number(params.offset ?? 0);
      const edgeLimit = Number(params.edgeLimit ?? 500);
      const direction = asOptionalString(params.direction);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const includeExternalTouchpoints = asOptionalBoolean(params.includeExternalTouchpoints);
      const outputMode = resolveImpactOutputModeBySource(params.outputMode, source);
      const storeDir = asOptionalString(params.storeDir);
      validateImpactFromDiffArgs({
        repoPath,
        changedFiles,
        symbols
      });
      return queryImpactFromDiff({
        repoPath,
        changedFiles,
        symbols,
        depth,
        limit,
        offset,
        edgeLimit,
        direction: direction as "outbound" | "inbound" | "both" | undefined,
        includeStructural,
        includeExternalTouchpoints,
        outputMode,
        storeDir
      });
    }
    case "related_clusters": {
      const repoPath = String(params.repoPath ?? "");
      const symbols = parseChangedFiles(params.symbols);
      const changedFiles = parseChangedFiles(params.changedFiles);
      const limit = Number(params.limit ?? 20);
      const offset = Number(params.offset ?? 0);
      const minSize = Number(params.minSize ?? 2);
      const includeMembers = asOptionalBoolean(params.includeMembers);
      const memberLimit = Number(params.memberLimit ?? 25);
      const storeDir = asOptionalString(params.storeDir);
      return queryRelatedClusters({
        repoPath,
        symbols,
        changedFiles,
        limit,
        offset,
        minSize,
        includeMembers,
        memberLimit,
        storeDir
      });
    }
    case "process_flow": {
      const repoPath = String(params.repoPath ?? "");
      const limit = Number(params.limit ?? 100);
      const offset = Number(params.offset ?? 0);
      const edgeLimit = Number(params.edgeLimit ?? 500);
      const includeStructural = asOptionalBoolean(params.includeStructural);
      const storeDir = asOptionalString(params.storeDir);
      const entrySymbols = parseChangedFiles(params.entrySymbols);
      return queryProcessFlow({
        repoPath,
        entrySymbols,
        limit,
        offset,
        edgeLimit,
        includeStructural,
        storeDir
      });
    }
    case "render_graph_page": {
      const repoPath = String(params.repoPath ?? "");
      const storeDir = asOptionalString(params.storeDir);
      const outputPath = asOptionalString(params.outputPath);
      const maxNodes = Number(params.maxNodes ?? 400);
      return renderGraphPage({ repoPath, storeDir, outputPath, maxNodes });
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export async function executeMcpToolInProcess(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!MCP_TOOL_NAMES.has(method)) {
    throw new Error(`Tool not found: ${method}`);
  }
  return executeLegacyMethod(method, params, "mcp_tool");
}

export function toolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      name: "describe_tools",
      description: "List MCP tool guidance with intent and default usage patterns",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "describe_tool",
      description: "Return detailed parameter guidance and good/bad examples for one tool",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tool name to describe" }
        },
        required: ["name"]
      }
    },
    {
      name: "symbol_neighborhood",
      description:
        "Use when you already know a symbol and need nearby graph context; not for exhaustive callsite lookup",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          symbol: { type: "string", description: "Symbol name to center the query on" },
          depth: { type: "number", description: "Traversal depth (default 2)" },
          limit: { type: "number", description: "Maximum nodes returned (default 100)" },
          direction: {
            type: "string",
            enum: ["outbound", "inbound", "both"],
            description: "Traversal direction (default both)"
          }
        },
        required: ["repoPath", "symbol"]
      }
    },
    {
      name: "symbol_references",
      description:
        "Use for direct references to an exact symbol or qualified id; for method callsites, start with method_usage",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          symbol: { type: "string", description: "Symbol name or qualified id" },
          limit: { type: "number", description: "Maximum references returned (default 200)" },
          scope: {
            type: "string",
            enum: ["direct", "expanded"],
            description: "Reference expansion scope (default direct)"
          },
          includeExternalNameMatches: {
            type: "boolean",
            description: "Optional override for external-name matching (otherwise derived from scope)"
          },
          includeAliasExpansion: {
            type: "boolean",
            description: "Optional override for alias expansion (otherwise derived from scope)"
          },
          matching: {
            type: "string",
            enum: ["prefer_qualified", "qualified_only", "name"],
            description: "Symbol matching behavior (default prefer_qualified)"
          },
          outputMode: {
            type: "string",
            enum: ["full", "files_only"],
            description: "Output shape (default files_only)"
          },
          testOnly: {
            type: "boolean",
            description: "Only include references from test/spec files (default false)"
          }
        },
        required: ["repoPath", "symbol"]
      }
    },
    {
      name: "method_usage",
      description:
        "Use first for method callsite lookup; performs internal disambiguation and returns deduped usage files",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          symbol: { type: "string", description: "Method symbol, id, or qualified name" },
          limit: { type: "number", description: "Maximum references returned (default 200)" },
          scope: {
            type: "string",
            enum: ["direct", "expanded"],
            description: "Reference expansion scope (default direct)"
          },
          includeExternalNameMatches: {
            type: "boolean",
            description: "Optional override for external-name matching (otherwise derived from scope)"
          },
          includeAliasExpansion: {
            type: "boolean",
            description: "Optional override for alias expansion (otherwise derived from scope)"
          },
          outputMode: {
            type: "string",
            enum: ["full", "files_only"],
            description: "Output shape (default files_only)"
          },
          testOnly: {
            type: "boolean",
            description: "Only include references from test/spec files (default false)"
          }
        },
        required: ["repoPath", "symbol"]
      }
    },
    {
      name: "references_for_file",
      description: "Use when the starting point is a file and you need inbound or outbound dependent files",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          filePath: { type: "string", description: "Repository-relative file path" },
          direction: {
            type: "string",
            enum: ["outbound", "inbound", "both"],
            description: "Traversal direction (default inbound)"
          },
          limit: { type: "number", description: "Maximum files/references returned (default 200)" },
          scope: {
            type: "string",
            enum: ["direct", "expanded"],
            description: "Reference expansion scope (default direct)"
          },
          includeExternalNameMatches: {
            type: "boolean",
            description: "Optional override for external-name matching (otherwise derived from scope)"
          },
          includeAliasExpansion: {
            type: "boolean",
            description: "Optional override for alias expansion (otherwise derived from scope)"
          },
          outputMode: {
            type: "string",
            enum: ["full", "files_only"],
            description: "Output shape (default files_only)"
          },
          testOnly: {
            type: "boolean",
            description: "Only include test/spec counterpart files (default false)"
          }
        },
        required: ["repoPath", "filePath"]
      }
    },
    {
      name: "hybrid_search",
      description: "Use when symbol identity is unknown and you need ranked candidates before targeted tools",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          query: { type: "string", description: "Search text query" },
          limit: { type: "number", description: "Maximum matches returned (default 50)" },
          offset: { type: "number", description: "Match page offset (default 0)" },
          depth: { type: "number", description: "Graph-proximity depth (default 2)" },
          includeStructural: {
            type: "boolean",
            description: "Include structural edges (contains/defines), default false"
          },
          outputMode: {
            type: "string",
            enum: ["full", "files_only"],
            description: "Output shape (default full)"
          }
        },
        required: ["repoPath", "query"]
      }
    },
    {
      name: "impact_from_diff",
      description: "Use for blast-radius analysis from changed files or changed symbols",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          changedFiles: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Changed file paths as CSV or array"
          },
          symbols: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Changed symbols as CSV or array"
          },
          depth: { type: "number", description: "Traversal depth (default 2)" },
          limit: { type: "number", description: "Maximum nodes/files returned (default 100)" },
          includeExternalTouchpoints: {
            type: "boolean",
            description: "Include external touchpoint annotations (default true)"
          },
          outputMode: {
            type: "string",
            enum: ["full", "files_only"],
            description: "Output shape (default files_only)"
          }
        },
        required: ["repoPath"]
      }
    },
    {
      name: "process_flow",
      description: "Use when tracing execution from entry symbols instead of counting references",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          entrySymbols: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Optional entry symbol names/ids as CSV or array"
          },
          limit: { type: "number", description: "Maximum nodes returned (default 100)" },
          edgeLimit: { type: "number", description: "Maximum edges returned (default 500)" },
          includeStructural: {
            type: "boolean",
            description: "Include structural edges (contains/defines), default false"
          }
        },
        required: ["repoPath"]
      }
    },
    {
      name: "related_clusters",
      description: "Use for broad architecture or refactor discovery across related symbol communities",
      inputSchema: {
        type: "object",
        properties: {
          repoPath: { type: "string", description: "Repository path containing graph files" },
          symbols: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Seed symbol names/ids as CSV or array"
          },
          changedFiles: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Seed changed file paths as CSV or array"
          },
          limit: { type: "number", description: "Maximum clusters returned (default 20)" },
          minSize: { type: "number", description: "Minimum member count per cluster (default 2)" },
          includeMembers: {
            type: "boolean",
            description: "Include representative members for each cluster, default false"
          },
          memberLimit: { type: "number", description: "Maximum members returned per cluster (default 25)" }
        },
        required: ["repoPath"]
      }
    }
  ];
}

function success(writer: RpcWriter, id: string | number | null, result: unknown): void {
  if (id === null) {
    return;
  }

  writer.write({
    jsonrpc: "2.0",
    id,
    result
  });
}

function failure(writer: RpcWriter, id: string | number | null, code: number, message: string): void {
  if (id === null) {
    return;
  }

  writer.write({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

async function handleRequest(writer: RpcWriter, request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;
  try {
    switch (request.method) {
      case "initialize":
        success(writer, id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "yggdrasil",
            version: "0.1.0"
          }
        });
        return;
      case "notifications/initialized":
        return;
      case "ping":
        success(writer, id, {});
        return;
      case "tools/list":
        success(writer, id, {
          tools: toolDefinitions()
        });
        return;
      case "tools/call": {
        const params = asObject(request.params);
        const name = String(params.name ?? "");
        if (!MCP_TOOL_NAMES.has(name)) {
          failure(writer, id, -32601, `Tool not found: ${name}`);
          return;
        }
        const args = asObject(params.arguments as JsonValue | undefined);
        const result = await executeLegacyMethod(name, args, "mcp_tool");

        success(writer, id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: normalizeStructuredContent(result)
        });
        return;
      }
      case "symbol_neighborhood":
      case "symbol_references":
      case "method_usage":
      case "references_for_file":
      case "hybrid_search":
      case "impact_from_diff":
      case "related_clusters":
      case "process_flow":
      case "describe_tools":
      case "describe_tool":
      {
        const result = await executeLegacyMethod(request.method, asObject(request.params));
        success(writer, id, result);
        return;
      }
      default:
        failure(writer, id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected failure";
    failure(writer, id, -32000, message);
  }
}

export async function runMcpStdioBridge(): Promise<void> {
  const writer = new RpcWriter();
  let buffer = Buffer.alloc(0);

  const parseBody = async (body: string): Promise<void> => {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return;
    }

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      failure(writer, "parse-error", -32700, "Parse error");
      return;
    }

    if (!request || typeof request.method !== "string") {
      failure(writer, request?.id ?? "invalid-request", -32600, "Invalid Request");
      return;
    }

    await handleRequest(writer, request);
  };

  for await (const chunk of process.stdin) {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    buffer = Buffer.concat([buffer, incoming]);

    while (buffer.length > 0) {
      const headerBoundary = buffer.indexOf("\r\n\r\n");
      if (headerBoundary >= 0) {
        const headerText = buffer.slice(0, headerBoundary).toString("utf8");
        const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!lengthMatch) {
          buffer = buffer.slice(headerBoundary + 4);
          continue;
        }

        const contentLength = Number(lengthMatch[1]);
        const bodyStart = headerBoundary + 4;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) {
          break;
        }

        writer.setMode("framed");
        const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.slice(bodyEnd);
        await parseBody(body);
        continue;
      }

      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        break;
      }

      writer.setMode("line");
      const line = buffer.slice(0, newlineIndex).toString("utf8");
      buffer = buffer.slice(newlineIndex + 1);
      await parseBody(line);
    }
  }
}
