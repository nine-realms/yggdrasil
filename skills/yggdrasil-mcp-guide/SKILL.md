---
name: yggdrasil-mcp-guide
description: >
  Use when querying Yggdrasil MCP graph tools for symbol lookup, references,
  impact analysis, clustering, and execution flow. Includes lightweight
  selection heuristics and examples aligned with MCP tool descriptions.
---

# Yggdrasil MCP Guide

Use this skill to answer:
- Which files/symbols reference this symbol or file?
- What is the likely blast radius of this change?
- What nearby dependencies/call paths should I inspect first?
- How do I avoid returning 0 nodes, 2 nodes, or an overwhelming graph?

Tool descriptions in the MCP server are the source of truth for when to use each tool; this guide provides practical defaults and fallback patterns.

## Discoverability-first workflow (new)

When uncertain, avoid guess-and-retry loops:

1. Call `describe_tools` to pick the best-fit tool by intent.
2. Call `describe_tool` for the selected tool to confirm parameter semantics and examples.
3. Run one focused query with direct/file-only defaults.
4. Only broaden scope/depth if the first query is insufficient.

Example `describe_tool` request:

```json
{
  "name": "method_usage"
}
```

## Tool selection matrix

| Goal | Primary tool | Good defaults |
|---|---|---|
| Find a symbol when you only know text | `hybrid_search` | `depth: 1`, `outputMode: "files_only"` |
| Find direct call-sites/usages of a method | `method_usage` | `scope: "direct"`, `outputMode: "files_only"` |
| Find direct references to an exact symbol id/name | `symbol_references` | `scope: "direct"`, `matching: "prefer_qualified"` (or `qualified_only` when known) |
| Find files connected to one changed file | `references_for_file` | `direction: "inbound"` first, `outputMode: "files_only"` |
| Expand nearby technical context | `symbol_neighborhood` | `depth: 1` first, then `2` only if needed |
| Estimate blast radius from many changes | `impact_from_diff` | `depth: 2`, `outputMode: "files_only"`, `includeExternalTouchpoints: true` |
| Group related domains/components | `related_clusters` | `minSize: 2`, `includeMembers: true` |
| Follow entry-point execution slices | `process_flow` | set `entrySymbols` when known |

## Default operating pattern (high signal first)

1. **Choose the right anchor**:
   - unknown symbol identity -> `hybrid_search`
   - method callsites -> `method_usage`
   - file-centric blast radius -> `references_for_file`
2. **Start concise**: use `scope: "direct"` and `outputMode: "files_only"` first.
3. **Broaden once** if needed: switch to `expanded` scope or depth `2`.
4. **Use `outputMode: "full"`** only when you need edge-level evidence.

This avoids noisy graphs while preserving traceability.

## Efficiency guardrails (reduce tool-call churn)

- Prefer fewer, higher-signal calls over exploratory loops with the same inputs.
- Use `outputMode: "files_only"` first; switch to `full` once you have the likely target.
- Stop when you have enough evidence to answer the user goal.
- For usage lookup, prefer `method_usage`/`symbol_references` before `symbol_neighborhood`/`process_flow`.
- If implementation-level refs are sparse, pivot to adjacent anchors (interface, caller file, or changed file path).
- Use `describe_tools` / `describe_tool` first when input shape is uncertain.

### Fallback sequence for method-usage questions

1. Run `method_usage` with `scope: "direct"` and `outputMode: "files_only"`.
2. If results are ambiguous or sparse, run `symbol_references` with `matching: "prefer_qualified"` (or `name` when only a method name is known).
3. If needed, pivot to `references_for_file` on a likely implementation or interface file (`direction: "inbound"`).
4. Run one `full` query on the winning symbol/file to capture line-level evidence.

Avoid looping across equivalent retries (`direct` -> `expanded` -> `direct` with same target) unless the prior step changed the target symbol/file.

## Example payloads (adapt as needed)

### 1) Method usage first

```json
{
  "repoPath": "C:\\path\\to\\repo",
  "symbol": "GetOrderDetails",
  "scope": "direct",
  "outputMode": "files_only",
  "testOnly": false
}
```

### 2) Exact-symbol references (when identity is known)

```json
{
  "repoPath": "C:\\path\\to\\repo",
  "symbol": "PromotionService.GetUserAreaOfStudyGroups",
  "matching": "qualified_only",
  "scope": "direct",
  "outputMode": "files_only"
}
```

### 3) File impact from the implementation file

```json
{
  "repoPath": "C:\\path\\to\\repo",
  "filePath": "src\\path\\ImplementationFile.cs",
  "direction": "inbound",
  "scope": "direct",
  "outputMode": "files_only"
}
```

Then optionally rerun with `direction: "both"` or `scope: "expanded"`.

### 4) Nearby context (bounded neighborhood)

```json
{
  "repoPath": "C:\\path\\to\\repo",
  "symbol": "GetOrderDetails",
  "depth": 1,
  "direction": "both",
  "limit": 120
}
```

### 5) Multi-file blast radius

```json
{
  "repoPath": "C:\\path\\to\\repo",
  "changedFiles": [
    "src\\path\\ChangedFile.ext",
    "src\\path\\AnotherChangedFile.ext"
  ],
  "depth": 2,
  "limit": 100,
  "includeExternalTouchpoints": true,
  "outputMode": "files_only"
}
```

`impact_from_diff` now traverses **internal-first** by default (it does not fan out through external nodes), and reports external API/framework integration as `externalTouchpoints`.

### 6) Cluster-level related context

```json
{
  "repoPath": "C:\\path\\to\\repo",
  "symbols": ["GetOrderDetails"],
  "limit": 20,
  "minSize": 2,
  "includeMembers": true,
  "memberLimit": 25
}
```

## Parameter guidance

- `scope` (`symbol_references`, `references_for_file`): `direct` first, `expanded` for recall.
- `matching` (`symbol_references`):
  - `qualified_only` when full id is known
  - `name` for method-name queries
  - `prefer_qualified` for mixed input
- `outputMode`:
  - `files_only`: concise impact list (default for planning/review)
  - `full`: edge/reference details for debugging
- Method-usage efficiency defaults:
  - Prefer `limit: 100-200` and `scope: "direct"` first.
  - Prefer direct-reference tools first; use deeper neighborhood traversal only when direct results are insufficient.
- `includeExternalTouchpoints` (`impact_from_diff`):
  - `true` (default): include `externalTouchpoints` annotations for first-hop external APIs/framework symbols
  - `false`: suppress external touchpoint annotations when you want purely internal/actionable output

## Interpreting results

- Prefer `files` for quick impact review.
- Use `references`/edges (`full`) only when behavior is unclear.
- Check `summary` for counts and pagination (`hasMore`).
- For `impact_from_diff`, inspect:
  - `externalTouchpoints` for integration touchpoints
  - `summary.totalExternalTouchpoints` / `hasMoreExternalTouchpoints` for external annotation volume
- For unresolved paths, inspect `resolution`, `resolutionReason`, and `sourceLocation`.

## Troubleshooting

- **Validation hint returned by MCP**:
  - Treat hint text as a routing suggestion, not a hard failure.
  - Apply the hinted argument/tool correction and retry once before broadening scope.

- **`symbol_references`: "symbol looked unqualified; try matching=prefer_qualified"`**:
  - Keep `scope: "direct"`.
  - Use `matching: "prefer_qualified"` for mixed inputs, or `matching: "name"` when only bare names are known.

- **`method_usage`: symbol looks like a file path**:
  - Provide a method symbol/name (for example `OrderService.GetById`), not `src\\...\\file.ts`.
  - If your anchor is a file path, use `references_for_file` instead.

- **`impact_from_diff`: missing anchors**:
  - Provide at least one of `changedFiles` or `symbols`.
  - Start with one concrete changed file if symbol set is unknown.

- **`hybrid_search`: query appears to be an exact symbol id**:
  - Use `symbol_references` (exact/direct refs) or `method_usage` (callsites) instead of `hybrid_search`.

- **Only 2 nodes (interface + implementation)**:
  - Start with `method_usage` (`scope: "direct"`, `outputMode: "files_only"`).
  - If needed, run `symbol_references` with `matching: "name"` or `prefer_qualified`.
  - Then run `references_for_file` on the implementation file with `direction: "inbound"`.
  - If implementation still shows 0 inbound, pivot to the related interface file and re-run inbound refs there.

- **No nodes**:
  - Confirm `repoPath` points to the indexed repo root (not directly to `graph.db`).
  - Run `hybrid_search` first to confirm the indexed symbol id/name.
  - Then rerun with `method_usage` or `symbol_references` using `matching: "name"` before broad neighborhood queries.

- **Way too many nodes**:
  - Keep `scope: "direct"`.
  - Prefer `symbol_neighborhood depth: 1` before depth 2+.
  - Use `files_only` and narrow by `direction`.
  - If you only need usage locations, skip neighborhood/process-flow and stay on `symbol_references` + `references_for_file`.

## Viewer note (bridge-backed visualize)

The viewer's top search box (`Search (name, id, file path)`) is a **client-side text filter** over the currently displayed graph set.  
For authoritative graph retrieval, use MCP tools (`symbol_references`, `references_for_file`, etc.) rather than relying on the sidebar text filter alone.
