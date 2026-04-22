import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../src/graph/sqlite-graph-store.js";
import { EdgeKind, NodeKind } from "../src/types/graph.js";
import { renderGraphPage } from "../src/visualization/render-graph-page.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

function extractGraphData(html: string): {
  metadata: {
    renderedNodeCount: number;
    renderedEdgeCount: number;
  };
  focusNodeIds: string[];
  nodes: Array<{ id: string }>;
  edges: Array<{ source: string; target: string }>;
} {
  const match = html.match(/const graphData = (\{[\s\S]*?\});\s*const queryApiBase = [\s\S]*?;\s*const WIDTH =/);
  if (!match) {
    throw new Error("Unable to locate graphData payload in rendered HTML.");
  }
  return JSON.parse(match[1]) as {
    metadata: {
      renderedNodeCount: number;
      renderedEdgeCount: number;
    };
    focusNodeIds: string[];
    nodes: Array<{ id: string }>;
    edges: Array<{ source: string; target: string }>;
  };
}

describe("renderGraphPage", () => {
  it("writes a standalone html page using default output path", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-visual-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [
        { id: "repo:r", kind: NodeKind.Repository, name: "repo" },
        { id: "file:src/a.ts", kind: NodeKind.File, name: "src/a.ts", filePath: "src/a.ts" },
        { id: "symbol:src/a.ts#run@1", kind: NodeKind.Symbol, name: "run", filePath: "src/a.ts" }
      ],
      edges: [
        { type: EdgeKind.Contains, from: "repo:r", to: "file:src/a.ts", filePath: "src/a.ts" },
        { type: EdgeKind.Defines, from: "file:src/a.ts", to: "symbol:src/a.ts#run@1", filePath: "src/a.ts" }
      ]
    });

    const result = await renderGraphPage({
      repoPath: repoDir,
      maxNodes: 400
    });

    expect(result.outputPath).toBe(path.resolve(path.join(storeDir, "graph-view.html")));
    expect(result.renderedNodeCount).toBe(3);
    expect(result.renderedEdgeCount).toBe(2);
    expect(result.truncated).toBe(false);

    const html = await readFile(result.outputPath, "utf8");
    expect(html).toContain("<title>Yggdrasil Graph Viewer</title>");
    expect(html).toContain("const graphData =");
    expect(html).toContain("Module dependency map");
    expect(html).toContain("<svg id=\"graph\"");
    expect(html).toContain("zoomAt(event.clientX, event.clientY, zoomFactor);");
    expect(html).toContain("svg.addEventListener('mousedown'");
    expect(html).toContain("id=\"hover-popover\"");
    expect(html).toContain("circle.addEventListener('mouseenter'");
    expect(html).toContain("id=\"node-legend\"");
    expect(html).toContain("renderLegend(nodeLegend, Object.entries(KIND_COLORS), 'node');");
    expect(html).toContain("Connected component");
    expect(html).toContain("return new Set([selectedNodeId]);");
    expect(html).toContain("sourceNode.kind === 'repository'");
    expect(html).toContain("Local graph queries");
    expect(html).toContain("query-symbol-references-button");
    expect(html).toContain("query-filter-results");
    expect(html).toContain("Filter graph to query results");
    expect(html).toContain("runLocalSymbolReferences");
    expect(html).toContain("runLocalSymbolNeighborhood");
    expect(html).toContain("runLocalReferencesForFile");
    expect(html).toContain("id=\"sidebar-resizer\"");
    expect(html).toContain("id=\"details-resizer\"");
    expect(html).toContain("beginResize('sidebar', event);");
    expect(html).toContain("beginResize('details', event);");
    expect(html).toContain("activeHandle.setPointerCapture(event.pointerId);");
    expect(html).toContain("activeHandle.releasePointerCapture(activeResize.pointerId);");
    expect(html).toContain("window.addEventListener('pointermove', updateResize);");
    expect(html).toContain("window.addEventListener('pointerup', endResize);");
    expect(html).toContain("window.addEventListener('pointercancel', endResize);");
    expect(html).toContain("window.addEventListener('resize', syncResizableBounds);");
    expect(html).toContain("queryFilterToResults");
    expect(html).toMatch(/queryResultNodeIds = new Set\(nodeIds\);\s*selectedNodeId = null;/);
    expect(html).not.toContain("https://unpkg.com");
  });

  it("samples large graphs according to maxNodes", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-visual-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    const outputPath = path.join(repoDir, "graph.html");
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

    const result = await renderGraphPage({
      repoPath: repoDir,
      outputPath,
      maxNodes: 25
    });

    expect(result.outputPath).toBe(path.resolve(outputPath));
    expect(result.totalNodeCount).toBe(30);
    expect(result.renderedNodeCount).toBe(25);
    expect(result.truncated).toBe(true);

    const html = await readFile(result.outputPath, "utf8");
    const payload = extractGraphData(html);
    expect(payload.metadata.renderedNodeCount).toBe(25);
    expect(payload.nodes).toHaveLength(30);
    expect(payload.focusNodeIds).toHaveLength(25);
  });

  it("does not require external bridge configuration for local query mode", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-visual-"));
    const storeDir = path.join(repoDir, ".yggdrasil");
    tempDirs.push(repoDir);

    const store = new SqliteGraphStore(repoDir, storeDir);
    await store.upsertGraph({
      schemaVersion: "1.0.0",
      nodes: [{ id: "symbol:1", kind: NodeKind.Symbol, name: "run", filePath: "src/a.ts" }],
      edges: []
    });

    const result = await renderGraphPage({
      repoPath: repoDir,
      maxNodes: 400
    });

    const html = await readFile(result.outputPath, "utf8");
    expect(html).toContain("Run local queries against the loaded graph snapshot.");
    expect(html).not.toContain("viewerConfig");
    expect(html).not.toContain("yggdrasilMcpCall");
  });
});
