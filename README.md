# Yggdrasil

Yggdrasil is a codebase indexer that builds a local SQLite knowledge graph for AI agent retrieval.

- Graph schema + provenance metadata
- Repository scanner
- TypeScript/JavaScript adapter
- C# adapter with Tree-sitter AST extraction
- Deterministic external-target resolution to in-repo symbols (unambiguous only)
- Relationship normalization and dedup
- SQLite graph persistence + in-memory adjacency traversal
- Smart queries: symbol neighborhood, symbol references, method usage, hybrid search, process flow, related clusters, impact from diff
- CLI + JSON-over-stdio tool bridge for agent integrations

## Requirements

- Node.js 20.19.5

No external database setup is required. Yggdrasil creates a local SQLite database in the store directory.

## Commands

Index a repository:

```bash
npx yggdrasil index --repo C:\path\to\repo --languages typescript,javascript,csharp
```

By default, graph data is written to `<repo>\.yggdrasil\graph.db`.

Optional custom storage directory:

```bash
npx yggdrasil index --repo C:\path\to\repo --store-dir C:\graph-cache\repo-a
```

Incremental update for changed files:

```bash
npx yggdrasil update --repo C:\path\to\repo --changed src\a.ts,src\b.cs
```

Changed paths are scoped to the target repo root (absolute paths inside the repo are normalized; outside paths are ignored).


Run the bridge-backed visualization server:

```bash
npx yggdrasil visualize --repo C:\path\to\repo --max-nodes 400
```

The command starts a local HTTP server and prints a URL to open in your browser. Local graph queries are bridge-backed against SQLite and `--max-nodes` controls the initial focused render set.

## MCP tools

Give your agent access to the yggdrasil stdio mcp tool bridge:

```bash
npx yggdrasil mcp-stdio
```

The stdio bridge supports MCP framed stdio and legacy JSON-per-line requests.

MCP tool exposure is intentionally read-only to avoid expensive graph rebuilds during agent query flows.
Use CLI commands (`index`, `update`, `visualize`) for graph mutation/render operations.
