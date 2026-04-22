import { describe, expect, it } from "vitest";
import {
  executeMcpToolInProcess,
  normalizeStructuredContent,
  resolveFileReferenceDirection,
  resolveImpactOutputModeBySource,
  resolveSymbolReferenceOutputModeBySource,
  resolveReferenceFlagsBySource,
  resolveReferenceScopeFlags,
  toolDefinitions
} from "../src/mcp/stdio-server.js";

describe("normalizeStructuredContent", () => {
  it("wraps array results into an object for MCP structuredContent", () => {
    const result = normalizeStructuredContent([{ id: "symbol:1" }]);
    expect(result).toEqual({
      items: [{ id: "symbol:1" }]
    });
  });

  it("passes through object results unchanged", () => {
    const result = normalizeStructuredContent({ ok: true, count: 2 });
    expect(result).toEqual({
      ok: true,
      count: 2
    });
  });

  it("wraps primitive results into an object", () => {
    const result = normalizeStructuredContent("done");
    expect(result).toEqual({
      value: "done"
    });
  });
});

describe("toolDefinitions", () => {
  it("exposes read-only query tools for MCP", () => {
    const names = toolDefinitions().map((tool) => String((tool as { name?: string }).name));
    expect(names).toEqual([
      "describe_tools",
      "describe_tool",
      "symbol_neighborhood",
      "symbol_references",
      "method_usage",
      "references_for_file",
      "hybrid_search",
      "impact_from_diff",
      "process_flow",
      "related_clusters"
    ]);
  });

  it("keeps MCP schemas focused on common query inputs", () => {
    const definitions = toolDefinitions() as Array<{
      name?: string;
      inputSchema?: { properties?: Record<string, unknown> };
    }>;
    const propsFor = (name: string): string[] =>
      Object.keys(definitions.find((tool) => tool.name === name)?.inputSchema?.properties ?? {});

    expect(propsFor("describe_tools")).toEqual([]);
    expect(propsFor("describe_tool")).toEqual(["name"]);
    expect(propsFor("symbol_references")).toEqual([
      "repoPath",
      "symbol",
      "limit",
      "scope",
      "includeExternalNameMatches",
      "includeAliasExpansion",
      "matching",
      "outputMode",
      "testOnly"
    ]);
    expect(propsFor("method_usage")).toEqual([
      "repoPath",
      "symbol",
      "limit",
      "scope",
      "includeExternalNameMatches",
      "includeAliasExpansion",
      "outputMode",
      "testOnly"
    ]);
    expect(propsFor("references_for_file")).toEqual([
      "repoPath",
      "filePath",
      "direction",
      "limit",
      "scope",
      "includeExternalNameMatches",
      "includeAliasExpansion",
      "outputMode",
      "testOnly"
    ]);
    expect(propsFor("hybrid_search")).toEqual([
      "repoPath",
      "query",
      "limit",
      "offset",
      "depth",
      "includeStructural",
      "outputMode"
    ]);
    expect(propsFor("impact_from_diff")).toEqual([
      "repoPath",
      "changedFiles",
      "symbols",
      "depth",
      "limit",
      "includeExternalTouchpoints",
      "outputMode"
    ]);
    expect(propsFor("process_flow")).toEqual([
      "repoPath",
      "entrySymbols",
      "limit",
      "edgeLimit",
      "includeStructural"
    ]);
    expect(propsFor("related_clusters")).toEqual([
      "repoPath",
      "symbols",
      "changedFiles",
      "limit",
      "minSize",
      "includeMembers",
      "memberLimit"
    ]);
  });
});

describe("MCP ergonomics describe helpers", () => {
  it("returns top-level tool guidance summaries", async () => {
    const result = (await executeMcpToolInProcess("describe_tools", {})) as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((tool) => tool.name);
    expect(names).toEqual([
      "hybrid_search",
      "impact_from_diff",
      "method_usage",
      "process_flow",
      "references_for_file",
      "related_clusters",
      "symbol_neighborhood",
      "symbol_references"
    ]);
  });

  it("returns detailed guidance for a specific tool", async () => {
    const result = (await executeMcpToolInProcess("describe_tool", {
      name: "method_usage"
    })) as {
      name: string;
      parameterSemantics: Array<{ name: string }>;
      goodExamples: Array<unknown>;
      badExamples: Array<unknown>;
    };
    expect(result.name).toBe("method_usage");
    expect(result.parameterSemantics.some((item) => item.name === "symbol")).toBe(true);
    expect(result.goodExamples.length).toBeGreaterThan(0);
    expect(result.badExamples.length).toBeGreaterThan(0);
  });
});

describe("MCP ergonomics validation hints", () => {
  it("guides symbol_references callers when qualified_only is used with unqualified symbols", async () => {
    await expect(
      executeMcpToolInProcess("symbol_references", {
        repoPath: "C:\\repo",
        symbol: "PrimaryService",
        matching: "qualified_only"
      })
    ).rejects.toThrow(/matching.*qualified_only.*prefer_qualified|name/i);
  });

  it("guides method_usage callers away from file-path input", async () => {
    await expect(
      executeMcpToolInProcess("method_usage", {
        repoPath: "C:\\repo",
        symbol: "src\\services\\order-service.ts"
      })
    ).rejects.toThrow(/file path|references_for_file/i);
  });

  it("requires at least one impact seed for impact_from_diff", async () => {
    await expect(
      executeMcpToolInProcess("impact_from_diff", {
        repoPath: "C:\\repo"
      })
    ).rejects.toThrow(/changedFiles|symbols/i);
  });

  it("guides hybrid_search callers when the query looks like an exact symbol id", async () => {
    await expect(
      executeMcpToolInProcess("hybrid_search", {
        repoPath: "C:\\repo",
        query: "symbol:src/order.ts#ProcessOrder@42"
      })
    ).rejects.toThrow(/symbol_references|method_usage/i);
  });
});

describe("resolveReferenceScopeFlags", () => {
  it("defaults to direct scope with expansion disabled", () => {
    expect(resolveReferenceScopeFlags({})).toEqual({
      scope: "direct",
      includeExternalNameMatches: false,
      includeAliasExpansion: false
    });
  });

  it("enables expansion for expanded scope", () => {
    expect(resolveReferenceScopeFlags({ scope: "expanded" })).toEqual({
      scope: "expanded",
      includeExternalNameMatches: true,
      includeAliasExpansion: true
    });
  });

  it("allows explicit flags to override scope defaults", () => {
    expect(
      resolveReferenceScopeFlags({
        scope: "direct",
        includeExternalNameMatches: true,
        includeAliasExpansion: false
      })
    ).toEqual({
      scope: "direct",
      includeExternalNameMatches: true,
      includeAliasExpansion: false
    });
  });
});

describe("resolveFileReferenceDirection", () => {
  it("defaults MCP tool calls to inbound when direction is omitted", () => {
    expect(resolveFileReferenceDirection(undefined, "mcp_tool")).toBe("inbound");
  });

  it("preserves legacy behavior when direction is omitted", () => {
    expect(resolveFileReferenceDirection(undefined, "legacy")).toBeUndefined();
  });

  it("uses explicit direction for both call paths", () => {
    expect(resolveFileReferenceDirection("both", "mcp_tool")).toBe("both");
    expect(resolveFileReferenceDirection("outbound", "legacy")).toBe("outbound");
  });
});

describe("resolveReferenceFlagsBySource", () => {
  it("applies direct defaults for legacy calls when scope is omitted", () => {
    expect(resolveReferenceFlagsBySource({}, "legacy")).toEqual({
      includeExternalNameMatches: false,
      includeAliasExpansion: false
    });
  });

  it("applies direct defaults for mcp tools when scope is omitted", () => {
    expect(resolveReferenceFlagsBySource({}, "mcp_tool")).toEqual({
      includeExternalNameMatches: false,
      includeAliasExpansion: false
    });
  });

  it("uses scoped defaults for expanded mode", () => {
    expect(resolveReferenceFlagsBySource({ scope: "expanded" }, "mcp_tool")).toEqual({
      includeExternalNameMatches: true,
      includeAliasExpansion: true
    });
  });
});

describe("resolveImpactOutputModeBySource", () => {
  it("defaults MCP tool calls to files_only", () => {
    expect(resolveImpactOutputModeBySource(undefined, "mcp_tool")).toBe("files_only");
  });

  it("preserves legacy default as full", () => {
    expect(resolveImpactOutputModeBySource(undefined, "legacy")).toBe("full");
  });

  it("honors explicit valid output modes", () => {
    expect(resolveImpactOutputModeBySource("full", "mcp_tool")).toBe("full");
    expect(resolveImpactOutputModeBySource("files_only", "legacy")).toBe("files_only");
  });
});

describe("resolveSymbolReferenceOutputModeBySource", () => {
  it("defaults MCP tool calls to files_only", () => {
    expect(resolveSymbolReferenceOutputModeBySource(undefined, "mcp_tool")).toBe("files_only");
  });

  it("preserves legacy default as undefined for store-level full fallback", () => {
    expect(resolveSymbolReferenceOutputModeBySource(undefined, "legacy")).toBeUndefined();
  });

  it("honors explicit valid output modes", () => {
    expect(resolveSymbolReferenceOutputModeBySource("full", "mcp_tool")).toBe("full");
    expect(resolveSymbolReferenceOutputModeBySource("files_only", "legacy")).toBe("files_only");
  });
});
