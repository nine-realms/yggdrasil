export interface ToolExample {
  description: string;
  arguments: Record<string, unknown>;
  why: string;
}

export interface ToolParameterGuidance {
  name: string;
  meaning: string;
  defaultValue?: string;
  guidance?: string;
}

export interface ToolGuidanceDetail {
  name: string;
  intent: string;
  whenToUse: string;
  defaults: Record<string, string>;
  parameterSemantics: ToolParameterGuidance[];
  goodExamples: ToolExample[];
  badExamples: ToolExample[];
  nextBestQueries: string[];
}

export interface ToolGuidanceSummary {
  name: string;
  intent: string;
  whenToUse: string;
  defaults: Record<string, string>;
  hasDetailedGuidance: boolean;
}

const detailedGuidance: Record<string, ToolGuidanceDetail> = {
  method_usage: {
    name: "method_usage",
    intent: "Find method callsites first, with internal disambiguation and deduped usage files.",
    whenToUse: "Start here for method-usage questions before broader reference or neighborhood traversal.",
    defaults: {
      scope: "direct",
      outputMode: "files_only",
      limit: "200"
    },
    parameterSemantics: [
      { name: "symbol", meaning: "Method name, symbol id, or qualified method.", guidance: "Required." },
      { name: "scope", meaning: "Reference expansion scope.", defaultValue: "direct" },
      { name: "outputMode", meaning: "Response verbosity.", defaultValue: "files_only" },
      { name: "testOnly", meaning: "Restrict to test/spec files.", defaultValue: "false" }
    ],
    goodExamples: [
      {
        description: "Find direct callsites quickly",
        arguments: {
          symbol: "GetOrderDetails",
          scope: "direct",
          outputMode: "files_only"
        },
        why: "High-signal first pass."
      }
    ],
    badExamples: [
      {
        description: "Passing a file path as method symbol",
        arguments: {
          symbol: "src\\services\\order-service.ts"
        },
        why: "Use references_for_file for file-centric lookups."
      }
    ],
    nextBestQueries: [
      "If usage is sparse, run symbol_references with matching=prefer_qualified.",
      "If still unclear, pivot to references_for_file on likely implementation or interface."
    ]
  },
  symbol_references: {
    name: "symbol_references",
    intent: "Find references to an exact symbol id/name with configurable matching behavior.",
    whenToUse: "Use when symbol identity is known or when method_usage fallback needs exact-symbol confirmation.",
    defaults: {
      scope: "direct",
      matching: "prefer_qualified",
      outputMode: "files_only",
      limit: "200"
    },
    parameterSemantics: [
      { name: "symbol", meaning: "Symbol id, qualified id, or symbol name.", guidance: "Required." },
      {
        name: "matching",
        meaning: "Symbol matching strategy.",
        defaultValue: "prefer_qualified",
        guidance: "Use qualified_only only when symbol identity is exact."
      },
      { name: "scope", meaning: "Reference expansion scope.", defaultValue: "direct" },
      { name: "outputMode", meaning: "Response verbosity.", defaultValue: "files_only" }
    ],
    goodExamples: [
      {
        description: "Reference lookup from exact identity",
        arguments: {
          symbol: "PromotionService.GetUserAreaOfStudyGroups",
          matching: "qualified_only",
          scope: "direct",
          outputMode: "files_only"
        },
        why: "Avoids broad name matching when identity is known."
      }
    ],
    badExamples: [
      {
        description: "Unqualified symbol with matching=qualified_only",
        arguments: {
          symbol: "PrimaryService",
          matching: "qualified_only"
        },
        why: "Use prefer_qualified or name for unqualified symbols."
      }
    ],
    nextBestQueries: [
      "If this is a method-callsites question, start with method_usage.",
      "If identity is unknown, start with hybrid_search and then return here."
    ]
  },
  impact_from_diff: {
    name: "impact_from_diff",
    intent: "Estimate blast radius from changed files and/or changed symbols.",
    whenToUse: "Use for impact analysis after edits, diff review, or pre-refactor scoping.",
    defaults: {
      depth: "2",
      outputMode: "files_only",
      includeExternalTouchpoints: "true",
      limit: "100"
    },
    parameterSemantics: [
      {
        name: "changedFiles",
        meaning: "Changed file paths (array or CSV).",
        guidance: "Provide changedFiles and/or symbols."
      },
      {
        name: "symbols",
        meaning: "Changed symbols (array or CSV).",
        guidance: "Provide symbols and/or changedFiles."
      },
      { name: "depth", meaning: "Traversal depth from seeds.", defaultValue: "2" },
      { name: "outputMode", meaning: "files_only or full payload.", defaultValue: "files_only" }
    ],
    goodExamples: [
      {
        description: "Diff-based blast radius",
        arguments: {
          changedFiles: ["src\\services\\order-service.ts"],
          depth: 2,
          outputMode: "files_only"
        },
        why: "Fast, actionable impact map."
      }
    ],
    badExamples: [
      {
        description: "No anchors supplied",
        arguments: {
          depth: 2
        },
        why: "At least one of changedFiles or symbols is required."
      }
    ],
    nextBestQueries: [
      "For one-file dependency mapping, use references_for_file first.",
      "For symbol-centric follow-up, use symbol_references or method_usage."
    ]
  },
  hybrid_search: {
    name: "hybrid_search",
    intent: "Find likely symbols when identity is unknown using lexical + graph proximity ranking.",
    whenToUse: "Use as discovery before targeted tools when you only know text.",
    defaults: {
      depth: "1",
      outputMode: "files_only",
      limit: "50"
    },
    parameterSemantics: [
      { name: "query", meaning: "Free-text symbol search phrase.", guidance: "Required and non-empty." },
      { name: "depth", meaning: "Graph-proximity depth.", defaultValue: "2", guidance: "Start at 1 for precision." },
      { name: "outputMode", meaning: "Response verbosity.", defaultValue: "full" }
    ],
    goodExamples: [
      {
        description: "Unknown symbol discovery",
        arguments: {
          query: "order workflow handler",
          depth: 1,
          outputMode: "files_only"
        },
        why: "Narrow candidate list before direct reference queries."
      }
    ],
    badExamples: [
      {
        description: "Exact symbol id as free-text query",
        arguments: {
          query: "symbol:src/order.ts#ProcessOrder@42"
        },
        why: "Use symbol_references for exact symbol ids."
      }
    ],
    nextBestQueries: [
      "After selecting a candidate, pivot to symbol_references.",
      "For method callsites, pivot to method_usage."
    ]
  }
};

function fallbackSummary(name: string): ToolGuidanceSummary {
  return {
    name,
    intent: "Use this tool when its domain-specific method fits your starting anchor.",
    whenToUse: "See tools/list schema and prefer direct/files_only first.",
    defaults: {},
    hasDetailedGuidance: false
  };
}

export function describeTools(toolNames: string[]): { tools: ToolGuidanceSummary[] } {
  const ordered = [...new Set(toolNames)].sort((left, right) => left.localeCompare(right));
  return {
    tools: ordered.map((name) => {
      const detail = detailedGuidance[name];
      if (!detail) {
        return fallbackSummary(name);
      }
      return {
        name: detail.name,
        intent: detail.intent,
        whenToUse: detail.whenToUse,
        defaults: detail.defaults,
        hasDetailedGuidance: true
      };
    })
  };
}

export function describeTool(name: string): ToolGuidanceDetail | undefined {
  return detailedGuidance[name];
}
