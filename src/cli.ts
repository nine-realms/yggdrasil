#!/usr/bin/env node
import { Command } from "commander";
import { parseLanguages, parseResolverLanguageScope, parseResolverMode } from "./config.js";
import { indexRepository } from "./indexer/index-repository.js";
import { updateFromDiff } from "./incremental/update-from-diff.js";
import { queryImpactFromDiff } from "./query/impact-from-diff.js";
import { queryHybridSearch } from "./query/hybrid-search.js";
import { queryMethodUsage } from "./query/method-usage.js";
import { queryProcessFlow } from "./query/process-flow.js";
import { queryRelatedClusters } from "./query/related-clusters.js";
import { queryReferencesForFile } from "./query/references-for-file.js";
import { runMcpStdioBridge } from "./mcp/stdio-server.js";
import { querySymbolNeighborhood } from "./query/symbol-neighborhood.js";
import { querySymbolReferences } from "./query/symbol-references.js";
import { runGraphViewServer } from "./visualization/run-graph-view-server.js";
import { createWatchDrivenIncrementalIntegration } from "./runtime/incremental-integration.js";

const program = new Command();

program.name("yggdrasil").description("Codebase knowledge-graph indexer").version("0.1.0");

program
  .command("index")
  .requiredOption("--repo <path>", "Repository path to index")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--languages <csv>", "Comma-separated languages", "typescript,javascript,csharp")
  .option("--resolution-mode <mode>", "Resolver mode: ranked|strict", "ranked")
  .option(
    "--resolver-language-scope <scope>",
    "Resolver language scope: csharp-and-typescript|all-current-languages",
    "csharp-and-typescript"
  )
  .option("--resolver-high-confidence <number>", "High-confidence auto-resolution threshold (0-1)", "0.85")
  .option("--resolver-medium-confidence <number>", "Medium-confidence threshold (0-1)", "0.6")
  .option("--resolver-top-candidates <number>", "Maximum ranked alternatives persisted in edge metadata", "3")
  .action(
    async (options: {
      repo: string;
      languages: string;
      storeDir?: string;
      resolutionMode: string;
      resolverLanguageScope: string;
      resolverHighConfidence: string;
      resolverMediumConfidence: string;
      resolverTopCandidates: string;
    }) => {
    const result = await indexRepository({
      repoPath: options.repo,
      languages: parseLanguages(options.languages),
      storeDir: options.storeDir,
      resolverPolicy: {
        mode: parseResolverMode(options.resolutionMode),
        languageScope: parseResolverLanguageScope(options.resolverLanguageScope),
        highConfidenceThreshold: Number(options.resolverHighConfidence),
        mediumConfidenceThreshold: Number(options.resolverMediumConfidence),
        maxAlternatives: Number(options.resolverTopCandidates)
      }
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

program
  .command("update")
  .requiredOption("--repo <path>", "Repository path to update")
  .requiredOption("--changed <csv>", "Comma-separated changed file paths")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--languages <csv>", "Comma-separated languages", "typescript,javascript,csharp")
  .option("--resolution-mode <mode>", "Resolver mode: ranked|strict", "ranked")
  .option(
    "--resolver-language-scope <scope>",
    "Resolver language scope: csharp-and-typescript|all-current-languages",
    "csharp-and-typescript"
  )
  .option("--resolver-high-confidence <number>", "High-confidence auto-resolution threshold (0-1)", "0.85")
  .option("--resolver-medium-confidence <number>", "Medium-confidence threshold (0-1)", "0.6")
  .option("--resolver-top-candidates <number>", "Maximum ranked alternatives persisted in edge metadata", "3")
  .action(
    async (options: {
      repo: string;
      changed: string;
      languages: string;
      storeDir?: string;
      resolutionMode: string;
      resolverLanguageScope: string;
      resolverHighConfidence: string;
      resolverMediumConfidence: string;
      resolverTopCandidates: string;
    }) => {
      const changedFiles = options.changed
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      const result = await updateFromDiff({
        repoPath: options.repo,
        languages: parseLanguages(options.languages),
        changedFiles,
        storeDir: options.storeDir,
        resolverPolicy: {
          mode: parseResolverMode(options.resolutionMode),
          languageScope: parseResolverLanguageScope(options.resolverLanguageScope),
          highConfidenceThreshold: Number(options.resolverHighConfidence),
          mediumConfidenceThreshold: Number(options.resolverMediumConfidence),
          maxAlternatives: Number(options.resolverTopCandidates)
        }
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

program
  .command("watch")
  .requiredOption("--repo <path>", "Repository path to watch for incremental graph refresh")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--languages <csv>", "Comma-separated languages", "typescript,javascript,csharp")
  .option("--resolution-mode <mode>", "Resolver mode: ranked|strict", "ranked")
  .option(
    "--resolver-language-scope <scope>",
    "Resolver language scope: csharp-and-typescript|all-current-languages",
    "csharp-and-typescript"
  )
  .option("--resolver-high-confidence <number>", "High-confidence auto-resolution threshold (0-1)", "0.85")
  .option("--resolver-medium-confidence <number>", "Medium-confidence threshold (0-1)", "0.6")
  .option("--resolver-top-candidates <number>", "Maximum ranked alternatives persisted in edge metadata", "3")
  .option("--watch-debounce <number>", "Filesystem watch debounce window in milliseconds", "150")
  .option("--runtime-debounce <number>", "Incremental update debounce window in milliseconds", "75")
  .action(
    async (options: {
      repo: string;
      languages: string;
      storeDir?: string;
      resolutionMode: string;
      resolverLanguageScope: string;
      resolverHighConfidence: string;
      resolverMediumConfidence: string;
      resolverTopCandidates: string;
      watchDebounce: string;
      runtimeDebounce: string;
    }) => {
      const integration = createWatchDrivenIncrementalIntegration({
        indexOptions: {
          repoPath: options.repo,
          languages: parseLanguages(options.languages),
          storeDir: options.storeDir,
          resolverPolicy: {
            mode: parseResolverMode(options.resolutionMode),
            languageScope: parseResolverLanguageScope(options.resolverLanguageScope),
            highConfidenceThreshold: Number(options.resolverHighConfidence),
            mediumConfidenceThreshold: Number(options.resolverMediumConfidence),
            maxAlternatives: Number(options.resolverTopCandidates)
          }
        },
        watchDebounceMs: Number(options.watchDebounce),
        runtimeDebounceMs: Number(options.runtimeDebounce),
        onError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`watch error: ${message}\n`);
        }
      });

      await integration.watchService.start();
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "watching",
            repoPath: options.repo,
            watchDebounceMs: Number(options.watchDebounce),
            runtimeDebounceMs: Number(options.runtimeDebounce)
          },
          null,
          2
        )}\n`
      );

      await new Promise<void>((resolve) => {
        let shuttingDown = false;
        const keepAlive = setInterval(() => {}, 1_000);
        const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
          if (shuttingDown) {
            return;
          }
          shuttingDown = true;
          process.stdout.write(`${JSON.stringify({ status: "stopping", signal }, null, 2)}\n`);
          try {
            await integration.watchService.stop();
            process.stdout.write(`${JSON.stringify({ status: "stopped", signal }, null, 2)}\n`);
          } finally {
            clearInterval(keepAlive);
            process.removeListener("SIGINT", onSigint);
            process.removeListener("SIGTERM", onSigterm);
            resolve();
          }
        };

        const onSigint = () => {
          void shutdown("SIGINT");
        };
        const onSigterm = () => {
          void shutdown("SIGTERM");
        };

        process.once("SIGINT", onSigint);
        process.once("SIGTERM", onSigterm);
      });
    }
  );

program
  .command("visualize")
  .requiredOption("--repo <path>", "Repository path containing graph files")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--host <host>", "Host/interface to bind the visualization server", "127.0.0.1")
  .option("--port <number>", "Port for the visualization server (0 for auto)", "4173")
  .option("--max-nodes <number>", "Maximum nodes to render (25-5000)", "400")
  .action(
    async (options: {
      repo: string;
      storeDir?: string;
      host: string;
      port: string;
      maxNodes: string;
    }) => {
      const result = await runGraphViewServer({
        repoPath: options.repo,
        storeDir: options.storeDir,
        host: options.host,
        port: Number(options.port),
        maxNodes: Number(options.maxNodes)
      });
      const { close, ...serializable } = result;
      process.stdout.write(`${JSON.stringify(serializable, null, 2)}\n`);

      const shutdown = async () => {
        await close();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    }
  );

const queryCommand = program.command("query").description("Graph query commands");
queryCommand
  .command("symbol-neighborhood")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .requiredOption("--symbol <name>", "Symbol name")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--depth <number>", "Traversal depth (1-4)", "2")
  .option("--limit <number>", "Maximum nodes in response page", "100")
  .option("--offset <number>", "Node page offset", "0")
  .option("--edge-limit <number>", "Maximum edges in response", "500")
  .option("--direction <mode>", "Traversal direction: outbound|inbound|both", "both")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .action(
    async (options: {
      repo: string;
      symbol: string;
      depth: string;
      limit: string;
      offset: string;
      edgeLimit: string;
      direction: "outbound" | "inbound" | "both";
      includeStructural: boolean;
      storeDir?: string;
    }) => {
      const result = await querySymbolNeighborhood({
        repoPath: options.repo,
        symbol: options.symbol,
        depth: Number(options.depth),
        limit: Number(options.limit),
        offset: Number(options.offset),
        edgeLimit: Number(options.edgeLimit),
        direction: options.direction,
        includeStructural: options.includeStructural,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("symbol-references")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .requiredOption("--symbol <name>", "Symbol name or qualified id")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--limit <number>", "Maximum references in response page", "200")
  .option("--offset <number>", "Reference page offset", "0")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .option(
    "--matching <mode>",
    "Symbol matching mode: prefer_qualified|qualified_only|name",
    "prefer_qualified"
  )
  .option("--include-external-name-matches", "Include unresolved external targets by name", false)
  .option("--include-alias-expansion", "Expand alias mappings discovered from dependency edges", false)
  .option("--output <mode>", "Response shape: full|files_only", "full")
  .option("--exclude-self", "Exclude references where source and target are in the same file", false)
  .option("--test-only", "Only include references from test/spec files", false)
  .action(
    async (options: {
      repo: string;
      symbol: string;
      limit: string;
      offset: string;
      includeStructural: boolean;
      matching: "prefer_qualified" | "qualified_only" | "name";
      includeExternalNameMatches: boolean;
      includeAliasExpansion: boolean;
      output: "full" | "files_only";
      excludeSelf: boolean;
      testOnly: boolean;
      storeDir?: string;
    }) => {
      const result = await querySymbolReferences({
        repoPath: options.repo,
        symbol: options.symbol,
        limit: Number(options.limit),
        offset: Number(options.offset),
        includeStructural: options.includeStructural,
        matching: options.matching,
        includeExternalNameMatches: options.includeExternalNameMatches,
        includeAliasExpansion: options.includeAliasExpansion,
        outputMode: options.output,
        excludeSelf: options.excludeSelf,
        testOnly: options.testOnly,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("method-usage")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .requiredOption("--symbol <name>", "Method symbol, id, or qualified name")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--limit <number>", "Maximum references in response page", "200")
  .option("--offset <number>", "Reference page offset", "0")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .option("--include-external-name-matches", "Include unresolved external targets by name", false)
  .option("--include-alias-expansion", "Expand alias mappings discovered from dependency edges", false)
  .option("--output <mode>", "Response shape: full|files_only", "files_only")
  .option("--exclude-self", "Exclude references where source and target are in the same file", false)
  .option("--test-only", "Only include references from test/spec files", false)
  .action(
    async (options: {
      repo: string;
      symbol: string;
      limit: string;
      offset: string;
      includeStructural: boolean;
      includeExternalNameMatches: boolean;
      includeAliasExpansion: boolean;
      output: "full" | "files_only";
      excludeSelf: boolean;
      testOnly: boolean;
      storeDir?: string;
    }) => {
      const result = await queryMethodUsage({
        repoPath: options.repo,
        symbol: options.symbol,
        limit: Number(options.limit),
        offset: Number(options.offset),
        includeStructural: options.includeStructural,
        includeExternalNameMatches: options.includeExternalNameMatches,
        includeAliasExpansion: options.includeAliasExpansion,
        outputMode: options.output,
        excludeSelf: options.excludeSelf,
        testOnly: options.testOnly,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("references-for-file")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .requiredOption("--file <path>", "Repository-relative file path")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--direction <mode>", "Traversal direction: outbound|inbound|both", "both")
  .option("--limit <number>", "Maximum files/references in response page", "200")
  .option("--offset <number>", "Page offset", "0")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .option("--output <mode>", "Response shape: full|files_only", "files_only")
  .option("--exclude-self", "Exclude references where source and target are in the same file", false)
  .option("--test-only", "Only include test/spec counterpart files", false)
  .action(
    async (options: {
      repo: string;
      file: string;
      direction: "outbound" | "inbound" | "both";
      limit: string;
      offset: string;
      includeStructural: boolean;
      output: "full" | "files_only";
      excludeSelf: boolean;
      testOnly: boolean;
      storeDir?: string;
    }) => {
      const result = await queryReferencesForFile({
        repoPath: options.repo,
        filePath: options.file,
        direction: options.direction,
        limit: Number(options.limit),
        offset: Number(options.offset),
        includeStructural: options.includeStructural,
        outputMode: options.output,
        excludeSelf: options.excludeSelf,
        testOnly: options.testOnly,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("process-flow")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .option("--entries <csv>", "Comma-separated entry symbol names or ids")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--limit <number>", "Maximum nodes in response page", "100")
  .option("--offset <number>", "Node page offset", "0")
  .option("--edge-limit <number>", "Maximum edges in response", "500")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .action(
    async (options: {
      repo: string;
      entries?: string;
      limit: string;
      offset: string;
      edgeLimit: string;
      includeStructural: boolean;
      storeDir?: string;
    }) => {
      const entrySymbols = (options.entries ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const result = await queryProcessFlow({
        repoPath: options.repo,
        entrySymbols,
        limit: Number(options.limit),
        offset: Number(options.offset),
        edgeLimit: Number(options.edgeLimit),
        includeStructural: options.includeStructural,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("related-clusters")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .option("--symbols <csv>", "Comma-separated seed symbols or qualified ids")
  .option("--changed <csv>", "Comma-separated changed file paths to seed related clusters")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--limit <number>", "Maximum clusters in response page", "20")
  .option("--offset <number>", "Cluster page offset", "0")
  .option("--min-size <number>", "Minimum cluster member count", "2")
  .option("--include-members", "Include representative members for each returned cluster", false)
  .option("--member-limit <number>", "Maximum members returned per cluster", "25")
  .action(
    async (options: {
      repo: string;
      symbols?: string;
      changed?: string;
      limit: string;
      offset: string;
      minSize: string;
      includeMembers: boolean;
      memberLimit: string;
      storeDir?: string;
    }) => {
      const symbols = (options.symbols ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const changedFiles = (options.changed ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const result = await queryRelatedClusters({
        repoPath: options.repo,
        symbols,
        changedFiles,
        limit: Number(options.limit),
        offset: Number(options.offset),
        minSize: Number(options.minSize),
        includeMembers: options.includeMembers,
        memberLimit: Number(options.memberLimit),
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("hybrid-search")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .requiredOption("--query <text>", "Search query text")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--limit <number>", "Maximum matches in response page", "50")
  .option("--offset <number>", "Match page offset", "0")
  .option("--depth <number>", "Graph-proximity depth (1-4)", "2")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .option("--output <mode>", "Response shape: full|files_only", "full")
  .action(
    async (options: {
      repo: string;
      query: string;
      limit: string;
      offset: string;
      depth: string;
      includeStructural: boolean;
      output: "full" | "files_only";
      storeDir?: string;
    }) => {
      const result = await queryHybridSearch({
        repoPath: options.repo,
        query: options.query,
        limit: Number(options.limit),
        offset: Number(options.offset),
        depth: Number(options.depth),
        includeStructural: options.includeStructural,
        outputMode: options.output,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

queryCommand
  .command("impact-from-diff")
  .requiredOption("--repo <path>", "Repository path containing .yggdrasil graph files")
  .option("--changed <csv>", "Comma-separated changed file paths")
  .option("--symbols <csv>", "Comma-separated changed symbols or qualified ids")
  .option("--store-dir <path>", "Directory for SQLite graph storage (defaults to <repo>/.yggdrasil)")
  .option("--depth <number>", "Traversal depth (1-6)", "2")
  .option("--limit <number>", "Maximum nodes in response page", "100")
  .option("--offset <number>", "Node page offset", "0")
  .option("--edge-limit <number>", "Maximum edges in response", "500")
  .option("--direction <mode>", "Traversal direction: outbound|inbound|both", "both")
  .option("--include-structural", "Include structural edges (contains/defines)", false)
  .option("--no-external-touchpoints", "Exclude external symbol touchpoint annotations from output")
  .option("--output <mode>", "Response shape: full|files_only", "files_only")
  .action(
    async (options: {
      repo: string;
      changed?: string;
      symbols?: string;
      depth: string;
      limit: string;
      offset: string;
      edgeLimit: string;
      direction: "outbound" | "inbound" | "both";
      includeStructural: boolean;
      externalTouchpoints: boolean;
      output: "full" | "files_only";
      storeDir?: string;
    }) => {
      const changedFiles = (options.changed ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const symbols = (options.symbols ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (changedFiles.length === 0 && symbols.length === 0) {
        throw new Error("impact-from-diff requires --changed and/or --symbols.");
      }

      const result = await queryImpactFromDiff({
        repoPath: options.repo,
        changedFiles,
        symbols,
        depth: Number(options.depth),
        limit: Number(options.limit),
        offset: Number(options.offset),
        edgeLimit: Number(options.edgeLimit),
        direction: options.direction,
        includeStructural: options.includeStructural,
        includeExternalTouchpoints: options.externalTouchpoints,
        outputMode: options.output,
        storeDir: options.storeDir
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  );

program.command("mcp-stdio").description("Run JSON-over-stdio tool bridge").action(runMcpStdioBridge);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
