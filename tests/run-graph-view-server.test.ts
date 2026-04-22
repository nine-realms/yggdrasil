import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../src/graph/sqlite-graph-store.js";
import { EdgeKind, NodeKind } from "../src/types/graph.js";
import { runGraphViewServer } from "../src/visualization/run-graph-view-server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

function extractGraphData(html: string): { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> } {
  const match = html.match(/const graphData = (\{[\s\S]*?\});\s*const queryApiBase = [\s\S]*?;\s*const WIDTH =/);
  if (!match) {
    throw new Error("Unable to locate graphData payload in rendered HTML.");
  }
  return JSON.parse(match[1]) as { nodes: Array<{ id: string }>; edges: Array<{ source: string; target: string }> };
}

describe("runGraphViewServer", () => {
  it("serves bridge-backed html and sqlite query endpoints", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-visual-server-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const nodes = Array.from({ length: 30 }, (_, index) => ({
      id: `symbol:${index + 1}`,
      kind: NodeKind.Symbol,
      name: `symbol-${index + 1}`,
      filePath: index < 15 ? "src/a.ts" : "src/b.ts"
    }));
    const edges = Array.from({ length: 29 }, (_, index) => ({
      type: EdgeKind.Calls,
      from: "symbol:1",
      to: `symbol:${index + 2}`,
      filePath: index < 14 ? "src/a.ts" : "src/b.ts"
    }));

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes,
      edges
    });

    const server = await runGraphViewServer({
      repoPath: repoDir,
      storeDir,
      host: "127.0.0.1",
      port: 0,
      maxNodes: 25
    });

    try {
      const htmlResponse = await fetch(server.url);
      const html = await htmlResponse.text();
      expect(htmlResponse.status).toBe(200);
      expect(html).toContain("const queryApiBase = \"/api\";");
      const payload = extractGraphData(html);
      expect(payload.nodes).toHaveLength(25);

      const referencesResponse = await fetch(
        `${server.url}/api/query/symbol-references?symbol=${encodeURIComponent("symbol-2")}`
      );
      const referencesPayload = await referencesResponse.json();
      expect(referencesResponse.status).toBe(200);
      expect(referencesPayload.label).toBe("Bridge symbol references");
      expect(Array.isArray(referencesPayload.nodeIds)).toBe(true);
      expect(Array.isArray(referencesPayload.graph?.nodes)).toBe(true);

      const neighborhoodResponse = await fetch(
        `${server.url}/api/query/symbol-neighborhood?symbol=${encodeURIComponent("symbol-1")}&depth=1`
      );
      const neighborhoodPayload = await neighborhoodResponse.json();
      expect(neighborhoodResponse.status).toBe(200);
      expect(neighborhoodPayload.summary.depth).toBe(1);

      const relatedResponse = await fetch(
        `${server.url}/api/query/references-for-file?filePath=${encodeURIComponent("src/a.ts")}&direction=both`
      );
      const relatedPayload = await relatedResponse.json();
      expect(relatedResponse.status).toBe(200);
      expect(relatedPayload.label).toBe("Bridge file references");
      expect(Array.isArray(relatedPayload.files)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("expands symbol references to matching external targets and caps large neighborhoods", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-visual-server-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const nodes = [
      { id: "symbol:interface#GetUserCourseCompletions@1", kind: NodeKind.Symbol, name: "GetUserCourseCompletions", filePath: "src/interface.cs" },
      { id: "symbol:impl#GetUserCourseCompletions@2", kind: NodeKind.Symbol, name: "GetUserCourseCompletions", filePath: "src/impl.cs" },
      { id: "external:GetUserCourseCompletions", kind: NodeKind.External, name: "GetUserCourseCompletions" },
      { id: "symbol:caller#1@3", kind: NodeKind.Symbol, name: "Caller1", filePath: "src/caller1.cs" },
      { id: "symbol:caller#2@4", kind: NodeKind.Symbol, name: "Caller2", filePath: "src/caller2.cs" },
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `symbol:chain:${index + 1}`,
        kind: NodeKind.Symbol,
        name: `Chain${index + 1}`,
        filePath: `src/chain${index + 1}.cs`
      }))
    ];
    const edges = [
      { type: EdgeKind.Calls, from: "symbol:caller#1@3", to: "external:GetUserCourseCompletions", filePath: "src/caller1.cs" },
      { type: EdgeKind.Calls, from: "symbol:caller#2@4", to: "external:GetUserCourseCompletions", filePath: "src/caller2.cs" },
      ...Array.from({ length: 299 }, (_, index) => ({
        type: EdgeKind.Calls,
        from: index === 0 ? "symbol:impl#GetUserCourseCompletions@2" : `symbol:chain:${index}`,
        to: `symbol:chain:${index + 1}`,
        filePath: "src/chain.cs"
      }))
    ];

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes,
      edges
    });

    const server = await runGraphViewServer({
      repoPath: repoDir,
      storeDir,
      host: "127.0.0.1",
      port: 0,
      maxNodes: 100
    });

    try {
      const referencesResponse = await fetch(
        `${server.url}/api/query/symbol-references?symbol=${encodeURIComponent("GetUserCourseCompletions")}`
      );
      const referencesPayload = await referencesResponse.json();
      expect(referencesResponse.status).toBe(200);
      expect(referencesPayload.nodeIds).toContain("external:GetUserCourseCompletions");
      expect(referencesPayload.summary.references).toBe(2);

      const neighborhoodResponse = await fetch(
        `${server.url}/api/query/symbol-neighborhood?symbol=${encodeURIComponent("GetUserCourseCompletions")}&depth=6`
      );
      const neighborhoodPayload = await neighborhoodResponse.json();
      expect(neighborhoodResponse.status).toBe(200);
      expect(typeof neighborhoodPayload.summary.capped).toBe("string");
      expect(neighborhoodPayload.nodeIds.length).toBeLessThanOrEqual(240);
    } finally {
      await server.close();
    }
  });
});
