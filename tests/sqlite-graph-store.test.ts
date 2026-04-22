import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../src/graph/sqlite-graph-store.js";
import { EdgeKind, NodeKind } from "../src/types/graph.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("SqliteGraphStore", () => {
  it("writes and reads full graph snapshots", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "repo:r", kind: NodeKind.Repository, name: "r" },
        { id: "symbol:a", kind: NodeKind.Symbol, name: "a", filePath: "src/a.ts" }
      ],
      edges: [{ type: EdgeKind.Defines, from: "repo:r", to: "symbol:a", filePath: "src/a.ts" }]
    });

    const graph = await store.readGraph();
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(1);
  });

  it("merges incremental updates for changed files", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "repo:r", kind: NodeKind.Repository, name: "r" },
        { id: "symbol:a", kind: NodeKind.Symbol, name: "a", filePath: "src/a.ts" },
        { id: "symbol:b", kind: NodeKind.Symbol, name: "b", filePath: "src/b.ts" }
      ],
      edges: [
        { type: EdgeKind.Defines, from: "repo:r", to: "symbol:a", filePath: "src/a.ts" },
        { type: EdgeKind.Defines, from: "repo:r", to: "symbol:b", filePath: "src/b.ts" }
      ]
    });

    await store.upsertGraph(
      {
        schemaVersion: "1.0.0",
        nodes: [
          { id: "repo:r", kind: NodeKind.Repository, name: "r" },
          { id: "symbol:a2", kind: NodeKind.Symbol, name: "a2", filePath: "src/a.ts" }
        ],
        edges: [{ type: EdgeKind.Defines, from: "repo:r", to: "symbol:a2", filePath: "src/a.ts" }]
      },
      ["src/a.ts"]
    );

    const graph = await store.readGraph();
    expect(graph.nodes.some((node) => node.id === "symbol:a")).toBe(false);
    expect(graph.nodes.some((node) => node.id === "symbol:a2")).toBe(true);
    expect(graph.nodes.some((node) => node.id === "symbol:b")).toBe(true);
  });

  it("does not treat empty changed-files updates as full snapshot replacement", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "repo:r", kind: NodeKind.Repository, name: "r" },
        { id: "symbol:a", kind: NodeKind.Symbol, name: "a", filePath: "src/a.ts" }
      ],
      edges: [{ type: EdgeKind.Defines, from: "repo:r", to: "symbol:a", filePath: "src/a.ts" }]
    });

    await store.upsertGraph(
      {
        schemaVersion: "1.0.0",
        nodes: [{ id: "repo:r", kind: NodeKind.Repository, name: "r" }],
        edges: []
      },
      []
    );

    const graph = await store.readGraph();
    expect(graph.nodes.some((node) => node.id === "symbol:a")).toBe(true);
  });

  it("keeps symbol neighborhood semantic by default and avoids structural fan-out", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "repo:r", kind: NodeKind.Repository, name: "repo" },
        { id: "file:a", kind: NodeKind.File, name: "a.ts", filePath: "src/a.ts" },
        { id: "file:b", kind: NodeKind.File, name: "b.ts", filePath: "src/b.ts" },
        { id: "symbol:a", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/a.ts" },
        { id: "symbol:b", kind: NodeKind.Symbol, name: "SecondaryService", filePath: "src/b.ts" },
        { id: "external:query", kind: NodeKind.External, name: "query" }
      ],
      edges: [
        { type: EdgeKind.Contains, from: "repo:r", to: "file:a", filePath: "src/a.ts" },
        { type: EdgeKind.Contains, from: "repo:r", to: "file:b", filePath: "src/b.ts" },
        { type: EdgeKind.Defines, from: "file:a", to: "symbol:a", filePath: "src/a.ts" },
        { type: EdgeKind.Defines, from: "file:b", to: "symbol:b", filePath: "src/b.ts" },
        { type: EdgeKind.Calls, from: "symbol:a", to: "external:query", filePath: "src/a.ts" }
      ]
    });

    const result = await store.getSymbolNeighborhood({
      symbol: "PrimaryService",
      depth: 4,
      limit: 100
    });

    expect(result.nodes.some((node) => node.id === "symbol:a")).toBe(true);
    expect(result.nodes.some((node) => node.id === "symbol:b")).toBe(false);
    expect(result.summary.matchedRoots).toBe(1);
  });

  it("returns first-hop process flow from detected entrypoints", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:main", kind: NodeKind.Symbol, name: "Main", filePath: "src/program.cs" },
        { id: "symbol:run", kind: NodeKind.Symbol, name: "Run", filePath: "src/program.cs" },
        { id: "symbol:helper", kind: NodeKind.Symbol, name: "Helper", filePath: "src/helper.cs" },
        { id: "external:ConsoleWriteLine", kind: NodeKind.External, name: "ConsoleWriteLine" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:main", to: "symbol:run", filePath: "src/program.cs" },
        {
          type: EdgeKind.Calls,
          from: "symbol:main",
          to: "external:ConsoleWriteLine",
          filePath: "src/program.cs"
        },
        { type: EdgeKind.Calls, from: "symbol:helper", to: "symbol:run", filePath: "src/helper.cs" }
      ]
    });

    const result = await store.getProcessFlow({
      limit: 50,
      edgeLimit: 50
    });

    expect(result.summary.detectedEntrypoints).toBe(1);
    expect(result.entrypoints.map((node) => node.id)).toEqual(["symbol:main"]);
    expect(result.edges.every((edge) => edge.from === "symbol:main")).toBe(true);
    expect(result.edges.some((edge) => edge.to === "symbol:run")).toBe(true);
    expect(result.edges.some((edge) => edge.to === "external:ConsoleWriteLine")).toBe(true);
  });

  it("returns deterministic related clusters from seed symbols and changed files", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:main", kind: NodeKind.Symbol, name: "Main", filePath: "src/program.cs" },
        { id: "symbol:run", kind: NodeKind.Symbol, name: "Run", filePath: "src/program.cs" },
        { id: "symbol:helper", kind: NodeKind.Symbol, name: "Helper", filePath: "src/helper.cs" },
        { id: "symbol:worker", kind: NodeKind.Symbol, name: "Worker", filePath: "src/worker.cs" },
        { id: "symbol:workerHelper", kind: NodeKind.Symbol, name: "WorkerHelper", filePath: "src/worker-helper.cs" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:main", to: "symbol:run", filePath: "src/program.cs" },
        { type: EdgeKind.Calls, from: "symbol:run", to: "symbol:helper", filePath: "src/program.cs" },
        { type: EdgeKind.Calls, from: "symbol:worker", to: "symbol:workerHelper", filePath: "src/worker.cs" }
      ]
    });

    const seeded = await store.getRelatedClusters({
      symbols: ["Main"],
      includeMembers: true,
      memberLimit: 10,
      limit: 10
    });
    expect(seeded.summary.seedCount).toBe(1);
    expect(seeded.summary.totalClusters).toBe(1);
    expect(seeded.clusters[0]?.size).toBe(3);
    expect(seeded.clusters[0]?.seedHits).toBe(1);
    expect(seeded.clusters[0]?.members.map((node) => node.id)).toEqual([
      "symbol:helper",
      "symbol:main",
      "symbol:run"
    ]);
    expect(seeded.clusters[0]?.files.some((file) => file.filePath === "src/program.cs")).toBe(true);

    const byChangedFile = await store.getRelatedClusters({
      changedFiles: ["src/worker.cs"],
      limit: 10
    });
    expect(byChangedFile.summary.seedCount).toBe(1);
    expect(byChangedFile.summary.totalClusters).toBe(1);
    expect(byChangedFile.clusters[0]?.size).toBe(2);
  });

  it("ranks hybrid search results with lexical and graph proximity signals", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:processOrder", kind: NodeKind.Symbol, name: "processOrder", filePath: "src/order-service.ts" },
        { id: "symbol:persistOrder", kind: NodeKind.Symbol, name: "persistOrder", filePath: "src/order-repo.ts" },
        { id: "symbol:orderController", kind: NodeKind.Symbol, name: "OrdersController", filePath: "src/order-controller.ts" },
        { id: "symbol:shipPackage", kind: NodeKind.Symbol, name: "shipPackage", filePath: "src/shipping.ts" }
      ],
      edges: [
        {
          type: EdgeKind.Calls,
          from: "symbol:orderController",
          to: "symbol:processOrder",
          filePath: "src/order-controller.ts"
        },
        {
          type: EdgeKind.Calls,
          from: "symbol:processOrder",
          to: "symbol:persistOrder",
          filePath: "src/order-service.ts"
        }
      ]
    });

    const result = await store.getHybridSearch({
      query: "processOrder",
      limit: 10,
      depth: 2
    });

    expect(result.summary.totalMatches).toBeGreaterThanOrEqual(3);
    expect(result.hits[0]?.node.id).toBe("symbol:processOrder");
    expect(result.hits.some((hit) => hit.node.id === "symbol:persistOrder")).toBe(true);
    expect(result.hits.some((hit) => hit.node.id === "symbol:orderController")).toBe(true);
    expect(result.files.some((file) => file.filePath === "src/order-service.ts")).toBe(true);

    const filesPage = await store.getHybridSearch({
      query: "order",
      limit: 1,
      outputMode: "files_only"
    });
    expect(filesPage.summary.returnedMatches).toBe(0);
    expect(filesPage.summary.returnedFiles).toBe(1);
    expect(filesPage.summary.hasMoreFiles).toBe(true);
  });

  it("finds symbol references with bounded response", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/target.ts" },
        { id: "symbol:caller1", kind: NodeKind.Symbol, name: "CallerOne", filePath: "src/caller1.ts" },
        { id: "symbol:caller2", kind: NodeKind.Symbol, name: "CallerTwo", filePath: "src/caller2.ts" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:caller1", to: "symbol:target", filePath: "src/caller1.ts", line: 10 },
        { type: EdgeKind.Calls, from: "symbol:caller2", to: "symbol:target", filePath: "src/caller2.ts", line: 12 }
      ]
    });

    const firstPage = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 1,
      offset: 0
    });
    const secondPage = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 1,
      offset: 1
    });

    expect(firstPage.summary.totalReferences).toBe(2);
    expect(firstPage.summary.hasMore).toBe(true);
    expect(firstPage.references.length).toBe(1);
    expect(secondPage.references.length).toBe(1);
  });

  it("paginates symbol references deterministically when references share the same source file", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/PrimaryService.cs" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "external:IPrimaryService", kind: NodeKind.External, name: "IPrimaryService" },
        { id: "symbol:caller", kind: NodeKind.Symbol, name: "PrimaryController", filePath: "src/PrimaryController.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "external:IPrimaryService",
          to: "external:PrimaryService",
          filePath: "src/Startup.cs",
          line: 5
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:caller",
          to: "external:PrimaryService",
          filePath: "src/PrimaryController.cs",
          line: 12
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:caller",
          to: "external:IPrimaryService",
          filePath: "src/PrimaryController.cs",
          line: 10
        }
      ]
    });

    const page1a = await store.findSymbolReferences({ symbol: "PrimaryService", limit: 1, offset: 0 });
    const page2a = await store.findSymbolReferences({ symbol: "PrimaryService", limit: 1, offset: 1 });
    const page1b = await store.findSymbolReferences({ symbol: "PrimaryService", limit: 1, offset: 0 });
    const page2b = await store.findSymbolReferences({ symbol: "PrimaryService", limit: 1, offset: 1 });

    expect(page1a.references[0]?.toId).toBe("external:IPrimaryService");
    expect(page2a.references[0]?.toId).toBe("external:PrimaryService");
    expect(page1a.references[0]?.toId).toBe(page1b.references[0]?.toId);
    expect(page2a.references[0]?.toId).toBe(page2b.references[0]?.toId);
  });

  it("matches unresolved external-name references to known symbol roots", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/target.ts" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "symbol:caller", kind: NodeKind.Symbol, name: "Caller", filePath: "src/caller.ts" }
      ],
      edges: [
        { type: EdgeKind.DependsOn, from: "symbol:caller", to: "external:PrimaryService", filePath: "src/caller.ts" }
      ]
    });

    const result = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 20,
      includeExternalNameMatches: true
    });

    expect(result.summary.matchedRoots).toBe(1);
    expect(result.summary.totalReferences).toBe(1);
    expect(result.references[0]?.toId).toBe("external:PrimaryService");
    expect(result.references[0]?.resolution).toBe("unresolved");
  });

  it("surfaces ranked-resolution metadata on unresolved references", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target-a", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/target-a.ts" },
        { id: "symbol:target-b", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/target-b.ts" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "symbol:caller", kind: NodeKind.Symbol, name: "Caller", filePath: "src/caller.ts" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "symbol:caller",
          to: "external:PrimaryService",
          filePath: "src/caller.ts",
          metadata: {
            resolverMode: "ranked",
            resolverDecision: "ranked_candidates_only",
            resolverConfidence: 0.72,
            resolverConfidenceBand: "medium",
            resolverCandidateCount: 2,
            resolverTopCandidates: JSON.stringify([
              {
                id: "symbol:target-a",
                name: "PrimaryService",
                confidence: 0.72,
                fullyQualifiedName: "App.Services.PrimaryService"
              },
              {
                id: "symbol:target-b",
                name: "PrimaryService",
                confidence: 0.7,
                fullyQualifiedName: "Other.Services.PrimaryService"
              }
            ])
          }
        }
      ]
    });

    const result = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 20,
      includeExternalNameMatches: true
    });

    expect(result.summary.totalReferences).toBe(1);
    expect(result.references[0]).toMatchObject({
      resolution: "unresolved",
      resolutionMode: "ranked",
      resolutionDecision: "ranked_candidates_only",
      resolutionConfidence: 0.72,
      resolutionConfidenceBand: "medium",
      resolutionCandidateCount: 2
    });
    expect(result.references[0]?.resolutionCandidates?.map((candidate) => candidate.id)).toEqual([
      "symbol:target-a",
      "symbol:target-b"
    ]);
  });

  it("includes external-name matches by default and allows opting out", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/primary.ts" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "symbol:caller", kind: NodeKind.Symbol, name: "Caller", filePath: "src/caller.ts" }
      ],
      edges: [
        { type: EdgeKind.DependsOn, from: "symbol:caller", to: "external:PrimaryService", filePath: "src/caller.ts" }
      ]
    });

    const strictResult = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 20
    });
    expect(strictResult.summary.totalReferences).toBe(1);

    const optedOutResult = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 20,
      includeExternalNameMatches: false,
      includeAliasExpansion: false
    });
    expect(optedOutResult.summary.totalReferences).toBe(0);
  });

  it("expands qualified symbol lookups to external and alias targets by default", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:impl", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/PrimaryService.cs" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "external:IPrimaryService", kind: NodeKind.External, name: "IPrimaryService" },
        { id: "symbol:consumer", kind: NodeKind.Symbol, name: "Consumer", filePath: "src/Consumer.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "external:IPrimaryService",
          to: "external:PrimaryService",
          filePath: "src/Startup.cs"
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:consumer",
          to: "external:IPrimaryService",
          filePath: "src/Consumer.cs"
        }
      ]
    });

    const result = await store.findSymbolReferences({
      symbol: "symbol:impl",
      matching: "qualified_only",
      limit: 50
    });

    expect(result.summary.totalReferences).toBe(2);
    expect(result.references.some((reference) => reference.toId === "external:IPrimaryService")).toBe(true);
  });

  it("includes interface-aliased references for implementation symbol lookups", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/PrimaryService.cs" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "external:IPrimaryService", kind: NodeKind.External, name: "IPrimaryService" },
        { id: "symbol:startup", kind: NodeKind.Symbol, name: "ConfigureServices", filePath: "src/Startup.cs" },
        { id: "symbol:controller", kind: NodeKind.Symbol, name: "PrimaryController", filePath: "src/PrimaryController.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "external:IPrimaryService",
          to: "external:PrimaryService",
          filePath: "src/Startup.cs"
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:controller",
          to: "external:IPrimaryService",
          filePath: "src/PrimaryController.cs"
        }
      ]
    });

    const result = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 20
    });

    expect(result.files.some((file) => file.filePath === "src/PrimaryController.cs")).toBe(true);
    expect(result.references.some((reference) => reference.toId === "external:IPrimaryService")).toBe(true);
    expect(result.references.some((reference) => reference.resolution === "alias_expanded")).toBe(true);
  });

  it("expands aliases deterministically regardless of dependency-edge order", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/PrimaryService.cs" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "external:IPrimaryService", kind: NodeKind.External, name: "IPrimaryService" },
        { id: "symbol:controller", kind: NodeKind.Symbol, name: "PrimaryController", filePath: "src/PrimaryController.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "symbol:controller",
          to: "external:IPrimaryService",
          filePath: "src/PrimaryController.cs"
        },
        {
          type: EdgeKind.DependsOn,
          from: "external:IPrimaryService",
          to: "external:PrimaryService",
          filePath: "src/Startup.cs"
        }
      ]
    });

    const result = await store.findSymbolReferences({
      symbol: "PrimaryService",
      limit: 20
    });

    expect(result.references.some((reference) => reference.toId === "external:IPrimaryService")).toBe(true);
    expect(result.files.some((file) => file.filePath === "src/PrimaryController.cs")).toBe(true);
  });

  it("does not expand ambiguous external aliases when symbol names are not unique", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:logger1", kind: NodeKind.Symbol, name: "Logger", filePath: "src/LoggerA.cs" },
        { id: "symbol:logger2", kind: NodeKind.Symbol, name: "Logger", filePath: "src/LoggerB.cs" },
        { id: "external:Logger", kind: NodeKind.External, name: "Logger" },
        { id: "external:ILogger", kind: NodeKind.External, name: "ILogger" },
        { id: "symbol:startup", kind: NodeKind.Symbol, name: "ConfigureServices", filePath: "src/Startup.cs" },
        { id: "symbol:consumer", kind: NodeKind.Symbol, name: "Consumer", filePath: "src/Consumer.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "external:ILogger",
          to: "external:Logger",
          filePath: "src/Startup.cs"
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:consumer",
          to: "external:ILogger",
          filePath: "src/Consumer.cs"
        }
      ]
    });

    const result = await store.findSymbolReferences({
      symbol: "Logger",
      limit: 50
    });

    expect(result.summary.matchedRoots).toBe(2);
    expect(result.references.some((reference) => reference.toId === "external:ILogger")).toBe(false);
    expect(result.files.some((file) => file.filePath === "src/Consumer.cs")).toBe(false);
  });

  it("supports file-only output, self filtering, and test-only filtering", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:primary", kind: NodeKind.Symbol, name: "Primary", filePath: "src/primary.ts" },
        { id: "symbol:helper", kind: NodeKind.Symbol, name: "Helper", filePath: "src/helper.ts" },
        { id: "symbol:test", kind: NodeKind.Symbol, name: "PrimarySpec", filePath: "test/primary.spec.ts" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:primary", to: "symbol:primary", filePath: "src/primary.ts" },
        { type: EdgeKind.Calls, from: "symbol:helper", to: "symbol:primary", filePath: "src/helper.ts" },
        { type: EdgeKind.Calls, from: "symbol:test", to: "symbol:primary", filePath: "test/primary.spec.ts" }
      ]
    });

    const filesOnly = await store.findSymbolReferences({
      symbol: "Primary",
      limit: 50,
      outputMode: "files_only",
      excludeSelf: true
    });
    expect(filesOnly.references.length).toBe(0);
    expect(filesOnly.summary.hasMore).toBe(false);
    expect(filesOnly.files.some((file) => file.filePath === "src/helper.ts")).toBe(true);
    expect(filesOnly.files.some((file) => file.filePath === "src/primary.ts")).toBe(false);

    const testOnly = await store.findSymbolReferences({
      symbol: "Primary",
      limit: 50,
      testOnly: true
    });
    expect(testOnly.files.length).toBe(1);
    expect(testOnly.files[0]?.filePath).toBe("test/primary.spec.ts");
  });

  it("returns inbound and outbound files for a file-centric blast radius query", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:target", kind: NodeKind.Symbol, name: "Target", filePath: "src/target.ts" },
        { id: "symbol:caller", kind: NodeKind.Symbol, name: "Caller", filePath: "src/caller.ts" },
        { id: "symbol:consumer", kind: NodeKind.Symbol, name: "Consumer", filePath: "src/consumer.ts" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:caller", to: "symbol:target", filePath: "src/caller.ts" },
        { type: EdgeKind.Calls, from: "symbol:target", to: "symbol:consumer", filePath: "src/target.ts" }
      ]
    });

    const result = await store.getReferencesForFile({
      filePath: "src/target.ts",
      direction: "both",
      limit: 50,
      outputMode: "files_only"
    });

    expect(result.files.some((file) => file.filePath === "src/caller.ts" && file.inbound === 1)).toBe(true);
    expect(result.files.some((file) => file.filePath === "src/consumer.ts" && file.outbound === 1)).toBe(true);
    expect(result.references.length).toBe(0);
  });

  it("includes alias-linked inbound files for file-centric queries by default", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:impl", kind: NodeKind.Symbol, name: "PrimaryService", filePath: "src/PrimaryService.cs" },
        { id: "external:PrimaryService", kind: NodeKind.External, name: "PrimaryService" },
        { id: "external:IPrimaryService", kind: NodeKind.External, name: "IPrimaryService" },
        { id: "symbol:consumer", kind: NodeKind.Symbol, name: "Consumer", filePath: "src/Consumer.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "external:IPrimaryService",
          to: "external:PrimaryService",
          filePath: "src/Startup.cs"
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:consumer",
          to: "external:IPrimaryService",
          filePath: "src/Consumer.cs"
        }
      ]
    });

    const result = await store.getReferencesForFile({
      filePath: "src/PrimaryService.cs",
      direction: "both",
      limit: 50,
      outputMode: "files_only"
    });

    expect(result.summary.totalFiles).toBe(2);
    expect(result.files.some((file) => file.filePath === "src/Consumer.cs" && file.inbound === 1)).toBe(true);
    expect(result.files.some((file) => file.filePath === "src/Startup.cs" && file.inbound === 1)).toBe(true);
  });

  it("does not count module/external-only edges as cross-file blast radius", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "file:src/service.cs", kind: NodeKind.File, name: "src/service.cs", filePath: "src/service.cs" },
        { id: "symbol:service", kind: NodeKind.Symbol, name: "Service", filePath: "src/service.cs" },
        { id: "module:System", kind: NodeKind.Module, name: "System" },
        { id: "external:List", kind: NodeKind.External, name: "List" }
      ],
      edges: [
        { type: EdgeKind.Imports, from: "file:src/service.cs", to: "module:System", filePath: "src/service.cs" },
        { type: EdgeKind.DependsOn, from: "symbol:service", to: "external:List", filePath: "src/service.cs" }
      ]
    });

    const result = await store.getReferencesForFile({
      filePath: "src/service.cs",
      direction: "both",
      limit: 50,
      outputMode: "full"
    });

    expect(result.summary.totalFiles).toBe(0);
    expect(result.summary.totalReferences).toBe(0);
    expect(result.files.length).toBe(0);
    expect(result.references.length).toBe(0);
  });

  it("avoids ambiguous external-name seeding for file-centric queries", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:loggerA", kind: NodeKind.Symbol, name: "Logger", filePath: "src/LoggerA.cs" },
        { id: "symbol:loggerB", kind: NodeKind.Symbol, name: "Logger", filePath: "src/LoggerB.cs" },
        { id: "external:Logger", kind: NodeKind.External, name: "Logger" },
        { id: "external:ILogger", kind: NodeKind.External, name: "ILogger" },
        { id: "symbol:startup", kind: NodeKind.Symbol, name: "ConfigureServices", filePath: "src/Startup.cs" },
        { id: "symbol:consumer", kind: NodeKind.Symbol, name: "Consumer", filePath: "src/Consumer.cs" }
      ],
      edges: [
        {
          type: EdgeKind.DependsOn,
          from: "external:ILogger",
          to: "external:Logger",
          filePath: "src/Startup.cs"
        },
        {
          type: EdgeKind.DependsOn,
          from: "symbol:consumer",
          to: "external:ILogger",
          filePath: "src/Consumer.cs"
        }
      ]
    });

    const result = await store.getReferencesForFile({
      filePath: "src/LoggerA.cs",
      direction: "both",
      limit: 50,
      outputMode: "files_only"
    });

    expect(result.summary.totalFiles).toBe(0);
    expect(result.summary.totalReferences).toBe(0);
    expect(result.files.length).toBe(0);
  });

  it("computes impact neighborhood from changed files", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:changed", kind: NodeKind.Symbol, name: "ChangedService", filePath: "src/changed.ts" },
        { id: "symbol:dependent", kind: NodeKind.Symbol, name: "DependentService", filePath: "src/dependent.ts" },
        { id: "symbol:other", kind: NodeKind.Symbol, name: "OtherService", filePath: "src/other.ts" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:changed", to: "symbol:dependent", filePath: "src/changed.ts" },
        { type: EdgeKind.Calls, from: "symbol:other", to: "symbol:other", filePath: "src/other.ts" }
      ]
    });

    const result = await store.getImpactFromDiff({
      changedFiles: ["src/changed.ts"],
      depth: 2,
      limit: 100
    });

    expect(result.summary.seedCount).toBeGreaterThan(0);
    expect(result.nodes.some((node) => node.id === "symbol:changed")).toBe(true);
    expect(result.nodes.some((node) => node.id === "symbol:dependent")).toBe(true);
    expect(result.nodes.some((node) => node.id === "symbol:other")).toBe(false);
  });

  it("supports files_only impact output without node/edge payloads", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:changed", kind: NodeKind.Symbol, name: "ChangedService", filePath: "src/changed.ts" },
        { id: "symbol:dependent", kind: NodeKind.Symbol, name: "DependentService", filePath: "src/dependent.ts" },
        { id: "symbol:other", kind: NodeKind.Symbol, name: "OtherService", filePath: "src/other.ts" }
      ],
      edges: [{ type: EdgeKind.Calls, from: "symbol:changed", to: "symbol:dependent", filePath: "src/changed.ts" }]
    });

    const result = await store.getImpactFromDiff({
      changedFiles: ["src/changed.ts"],
      depth: 2,
      limit: 100,
      outputMode: "files_only"
    });

    expect(result.query.outputMode).toBe("files_only");
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.summary.returnedNodes).toBe(0);
    expect(result.summary.returnedEdges).toBe(0);
    expect(result.summary.totalEdges).toBeGreaterThan(0);
    expect(result.summary.hasMoreEdges).toBe(true);
    expect(result.summary.totalFiles).toBeGreaterThan(0);
    expect(result.files.some((entry) => entry.filePath === "src/changed.ts")).toBe(true);
    expect(result.impactedFiles).toEqual(result.files);
    expect(result.externalTouchpoints).toEqual([]);
  });

  it("keeps blast radius internal while surfacing external touchpoints", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:changed", kind: NodeKind.Symbol, name: "ChangedService", filePath: "src/changed.ts" },
        { id: "symbol:dependent", kind: NodeKind.Symbol, name: "DependentService", filePath: "src/dependent.ts" },
        { id: "external:HttpClient", kind: NodeKind.External, name: "HttpClient" }
      ],
      edges: [
        { type: EdgeKind.Calls, from: "symbol:changed", to: "external:HttpClient", filePath: "src/changed.ts" },
        { type: EdgeKind.Calls, from: "external:HttpClient", to: "symbol:dependent", filePath: "src/dependent.ts" }
      ]
    });

    const result = await store.getImpactFromDiff({
      changedFiles: ["src/changed.ts"],
      depth: 2,
      limit: 100
    });

    expect(result.nodes.some((node) => node.id === "symbol:changed")).toBe(true);
    expect(result.nodes.some((node) => node.id === "symbol:dependent")).toBe(false);
    expect(result.nodes.some((node) => node.id === "external:HttpClient")).toBe(false);
    expect(result.externalTouchpoints).toEqual([
      {
        symbolId: "external:HttpClient",
        symbol: "HttpClient",
        references: 1,
        inbound: 0,
        outbound: 1,
        files: [{ filePath: "src/changed.ts", references: 1 }]
      }
    ]);
  });

  it("can disable external touchpoint annotations in impact output", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "symbol:changed", kind: NodeKind.Symbol, name: "ChangedService", filePath: "src/changed.ts" },
        { id: "external:HttpClient", kind: NodeKind.External, name: "HttpClient" }
      ],
      edges: [{ type: EdgeKind.Calls, from: "symbol:changed", to: "external:HttpClient", filePath: "src/changed.ts" }]
    });

    const result = await store.getImpactFromDiff({
      changedFiles: ["src/changed.ts"],
      includeExternalTouchpoints: false,
      depth: 2,
      limit: 100
    });

    expect(result.query.includeExternalTouchpoints).toBe(false);
    expect(result.summary.totalExternalTouchpoints).toBe(0);
    expect(result.externalTouchpoints).toEqual([]);
  });
});
