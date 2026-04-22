import { createServer, Server } from "node:http";
import { QueryCommandOptions, resolveRepoPath, resolveStoragePaths } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { GraphDocument, GraphEdge, GraphNode } from "../types/graph.js";
import { buildHtml, sampleGraph, VisualizationEdge, VisualizationNode } from "./render-graph-page.js";

export interface RunGraphViewServerCommand extends QueryCommandOptions {
  maxNodes: number;
  host?: string;
  port?: number;
}

export interface RunGraphViewServerResult {
  repoPath: string;
  storeDir: string;
  url: string;
  totalNodeCount: number;
  totalEdgeCount: number;
  renderedNodeCount: number;
  renderedEdgeCount: number;
  truncated: boolean;
  close(): Promise<void>;
}

interface BridgeQueryResponse {
  label: string;
  summary: Record<string, string | number>;
  files: string[];
  nodeIds: string[];
  graph: {
    nodes: VisualizationNode[];
    edges: VisualizationEdge[];
  };
}

function normalizeFilePath(value: string | undefined): string {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function buildDegreeIndex(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const degreeByNode = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degreeByNode.set(edge.from, (degreeByNode.get(edge.from) ?? 0) + 1);
    degreeByNode.set(edge.to, (degreeByNode.get(edge.to) ?? 0) + 1);
  }
  return degreeByNode;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildAdjacency(edges: GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, new Set<string>());
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, new Set<string>());
    }
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  return adjacency;
}

function localSymbolMatches(symbolQuery: string, nodes: GraphNode[]): GraphNode[] {
  const query = symbolQuery.trim().toLowerCase();
  if (query.length === 0) {
    return [];
  }

  const symbolNodes = nodes.filter((node) => node.kind === "symbol");
  const exactMatches = symbolNodes.filter((node) => {
    const name = String(node.name ?? "").toLowerCase();
    const id = String(node.id ?? "").toLowerCase();
    return name === query || id === query;
  });
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return symbolNodes.filter((node) => {
    const name = String(node.name ?? "").toLowerCase();
    const id = String(node.id ?? "").toLowerCase();
    return name.includes(query) || id.includes(query);
  });
}

function buildQueryGraph(graph: GraphDocument, nodeIds: Set<string>): { nodes: VisualizationNode[]; edges: VisualizationEdge[] } {
  const nodes = graph.nodes.filter((node) => nodeIds.has(node.id));
  const edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const degreeByNode = buildDegreeIndex(nodes, edges);
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      language: node.language,
      filePath: node.filePath,
      degree: degreeByNode.get(node.id) ?? 0
    })),
    edges: edges.map((edge) => ({
      source: edge.from,
      target: edge.to,
      type: edge.type,
      filePath: edge.filePath,
      line: edge.line
    }))
  };
}

function makeBridgeQueryEngine(graph: GraphDocument): {
  symbolReferences(symbol: string): BridgeQueryResponse;
  symbolNeighborhood(symbol: string, depth: number): BridgeQueryResponse;
  referencesForFile(filePath: string, direction: "inbound" | "outbound" | "both"): BridgeQueryResponse;
} {
  const nonStructuralEdges = graph.edges.filter(
    (edge) => edge.type !== "contains" && edge.type !== "defines"
  );
  const adjacency = buildAdjacency(nonStructuralEdges);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const nodeFilePath = (nodeId: string, fallback: string | undefined): string => {
    const fromNode = nodeById.get(nodeId);
    const pathValue = fromNode?.filePath ?? fallback;
    return normalizeFilePath(pathValue);
  };

  const expandReferenceTargetIds = (matches: GraphNode[], symbolQuery: string): Set<string> => {
    const targetIds = new Set(matches.map((node) => node.id));
    const loweredNames = new Set(matches.map((node) => String(node.name ?? "").toLowerCase()));
    const loweredQuery = symbolQuery.trim().toLowerCase();
    if (loweredQuery.length > 0) {
      loweredNames.add(loweredQuery);
    }
    for (const node of graph.nodes) {
      if (node.kind !== "external") {
        continue;
      }
      const loweredName = String(node.name ?? "").toLowerCase();
      if (loweredNames.has(loweredName)) {
        targetIds.add(node.id);
      }
    }
    return targetIds;
  };

  return {
    symbolReferences(symbol: string): BridgeQueryResponse {
      const matches = localSymbolMatches(symbol, graph.nodes);
      const targetIds = expandReferenceTargetIds(matches, symbol);
      const referenceEdges = nonStructuralEdges.filter((edge) => targetIds.has(edge.to));
      const highlightSet = new Set<string>(matches.map((node) => node.id));
      for (const edge of referenceEdges) {
        highlightSet.add(edge.from);
        highlightSet.add(edge.to);
      }
      return {
        label: "Bridge symbol references",
        summary: {
          matchedSymbols: matches.length,
          references: referenceEdges.length
        },
        files: uniqueSorted(
          [...highlightSet]
            .map((nodeId) => normalizeFilePath(nodeById.get(nodeId)?.filePath))
            .filter((value) => value.length > 0)
        ),
        nodeIds: [...highlightSet],
        graph: buildQueryGraph(graph, highlightSet)
      };
    },
    symbolNeighborhood(symbol: string, depth: number): BridgeQueryResponse {
      const boundedDepth = Number.isFinite(depth) ? Math.max(0, Math.min(6, Math.trunc(depth))) : 2;
      const matches = localSymbolMatches(symbol, graph.nodes);
      const maxVisitedNodes = 240;
      const queue = matches.map((node) => ({ id: node.id, depth: 0 }));
      const visited = new Set<string>(matches.map((node) => node.id));

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || current.depth >= boundedDepth) {
          continue;
        }
        for (const neighbor of adjacency.get(current.id) ?? []) {
          if (visited.has(neighbor)) {
            continue;
          }
          visited.add(neighbor);
          if (visited.size >= maxVisitedNodes) {
            break;
          }
          queue.push({ id: neighbor, depth: current.depth + 1 });
        }
        if (visited.size >= maxVisitedNodes) {
          break;
        }
      }

      const neighborhoodEdges = nonStructuralEdges.filter(
        (edge) => visited.has(edge.from) && visited.has(edge.to)
      );
      return {
        label: "Bridge symbol neighborhood",
        summary: {
          seeds: matches.length,
          depth: boundedDepth,
          capped: visited.size >= maxVisitedNodes ? "true" : "false",
          nodes: visited.size,
          edges: neighborhoodEdges.length
        },
        files: uniqueSorted(
          [...visited]
            .map((nodeId) => normalizeFilePath(nodeById.get(nodeId)?.filePath))
            .filter((value) => value.length > 0)
        ),
        nodeIds: [...visited],
        graph: buildQueryGraph(graph, visited)
      };
    },
    referencesForFile(filePath: string, direction: "inbound" | "outbound" | "both"): BridgeQueryResponse {
      const targetFilePath = normalizeFilePath(filePath);
      const relatedFiles = new Set<string>([targetFilePath]);
      const highlightSet = new Set<string>(
        graph.nodes
          .filter((node) => normalizeFilePath(node.filePath) === targetFilePath)
          .map((node) => node.id)
      );

      for (const edge of nonStructuralEdges) {
        const sourcePath = nodeFilePath(edge.from, edge.filePath);
        const targetPath = nodeFilePath(edge.to, edge.filePath);
        const outboundMatch =
          sourcePath === targetFilePath && targetPath.length > 0 && targetPath !== targetFilePath;
        const inboundMatch =
          targetPath === targetFilePath && sourcePath.length > 0 && sourcePath !== targetFilePath;
        const include =
          direction === "both"
            ? outboundMatch || inboundMatch
            : direction === "outbound"
              ? outboundMatch
              : inboundMatch;
        if (!include) {
          continue;
        }
        if (sourcePath.length > 0) {
          relatedFiles.add(sourcePath);
        }
        if (targetPath.length > 0) {
          relatedFiles.add(targetPath);
        }
        highlightSet.add(edge.from);
        highlightSet.add(edge.to);
      }

      for (const node of graph.nodes) {
        const normalizedPath = normalizeFilePath(node.filePath);
        if (relatedFiles.has(normalizedPath)) {
          highlightSet.add(node.id);
        }
      }

      return {
        label: "Bridge file references",
        summary: {
          filePath: targetFilePath,
          direction,
          relatedFiles: relatedFiles.size
        },
        files: [...relatedFiles].sort((left, right) => left.localeCompare(right)),
        nodeIds: [...highlightSet],
        graph: buildQueryGraph(graph, highlightSet)
      };
    }
  };
}

function sendJson(response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function parseDirection(raw: string | null): "inbound" | "outbound" | "both" {
  return raw === "inbound" || raw === "outbound" || raw === "both" ? raw : "both";
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine graph server address."));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function runGraphViewServer(
  command: RunGraphViewServerCommand
): Promise<RunGraphViewServerResult> {
  const repoPath = resolveRepoPath(command.repoPath);
  const storage = resolveStoragePaths(repoPath, command.storeDir);
  const host = command.host?.trim().length ? String(command.host).trim() : "127.0.0.1";
  const requestedPort = Number.isFinite(command.port) ? Math.max(0, Math.trunc(command.port ?? 4173)) : 4173;
  const store = createGraphStore(repoPath, command.storeDir);
  const graph = await store.readGraph();
  const payload = sampleGraph(graph, command.maxNodes, false);
  const html = buildHtml(payload, { queryApiBase: "/api" });
  const engine = makeBridgeQueryEngine(graph);

  const server = createServer((request, response) => {
    if (!request.url) {
      sendJson(response, 400, { error: "Request URL is required." });
      return;
    }

    const requestUrl = new URL(request.url, `http://${host}`);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }

    if (requestUrl.pathname === "/api/query/symbol-references") {
      const symbol = String(requestUrl.searchParams.get("symbol") ?? "").trim();
      if (symbol.length === 0) {
        sendJson(response, 400, { error: "symbol is required." });
        return;
      }
      sendJson(response, 200, engine.symbolReferences(symbol));
      return;
    }

    if (requestUrl.pathname === "/api/query/symbol-neighborhood") {
      const symbol = String(requestUrl.searchParams.get("symbol") ?? "").trim();
      if (symbol.length === 0) {
        sendJson(response, 400, { error: "symbol is required." });
        return;
      }
      const depthRaw = Number(requestUrl.searchParams.get("depth") ?? "2");
      const depth = Number.isFinite(depthRaw) ? depthRaw : 2;
      sendJson(response, 200, engine.symbolNeighborhood(symbol, depth));
      return;
    }

    if (requestUrl.pathname === "/api/query/references-for-file") {
      const filePath = String(requestUrl.searchParams.get("filePath") ?? "").trim();
      if (filePath.length === 0) {
        sendJson(response, 400, { error: "filePath is required." });
        return;
      }
      const direction = parseDirection(requestUrl.searchParams.get("direction"));
      sendJson(response, 200, engine.referencesForFile(filePath, direction));
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  });

  const boundPort = await listen(server, requestedPort, host);
  const close = async (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  return {
    repoPath,
    storeDir: storage.storeDir,
    url: `http://${host}:${boundPort}`,
    totalNodeCount: payload.metadata.totalNodeCount,
    totalEdgeCount: payload.metadata.totalEdgeCount,
    renderedNodeCount: payload.metadata.renderedNodeCount,
    renderedEdgeCount: payload.metadata.renderedEdgeCount,
    truncated: payload.metadata.truncated,
    close
  };
}
