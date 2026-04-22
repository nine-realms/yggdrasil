import { promises as fs } from "node:fs";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";
import { resolveStoragePaths } from "../config.js";
import {
  FileReferencesQueryOptions,
  FileReferencesResult,
  HybridSearchHit,
  HybridSearchQueryOptions,
  HybridSearchResult,
  ImpactExternalTouchpointItem,
  ImpactFromDiffQueryOptions,
  ImpactFromDiffResult,
  RelatedClusterItem,
  RelatedClustersQueryOptions,
  RelatedClustersResult,
  ProcessFlowQueryOptions,
  ProcessFlowResult,
  QueryDirection,
  QueryOutputMode,
  SymbolMatchingMode,
  SymbolNeighborhoodQueryOptions,
  SymbolNeighborhoodResult,
  SymbolReferenceItem,
  SymbolReferencesQueryOptions,
  SymbolReferencesResult
} from "../query/query-contracts.js";
import {
  EdgeKind,
  GRAPH_SCHEMA_VERSION,
  GraphDocument,
  GraphEdge,
  GraphNode,
  Metadata,
  NodeKind,
  normalizePath
} from "../types/graph.js";

interface NeighborLink {
  nodeId: string;
  edge: GraphEdge;
}

interface SymbolLookup {
  id: number;
  fileId: number;
}

interface TraversalView {
  root: GraphNode;
  matchedRoots: GraphNode[];
  visitedNodeIds: Set<string>;
  traversedEdgeSet: Set<string>;
  traversalCapped: boolean;
}

interface ClusterComponent {
  representative: string;
  memberIds: string[];
  internalEdges: number;
  density: number;
}

const STRUCTURAL_EDGE_KINDS = new Set<string>([EdgeKind.Contains, EdgeKind.Defines]);
const SEMANTIC_EDGE_KINDS = new Set<string>([EdgeKind.Calls, EdgeKind.Imports, EdgeKind.DependsOn]);
const DEFAULT_ENTRYPOINT_NAMES = new Set([
  "Main",
  "main",
  "Startup",
  "Program",
  "ConfigureServices",
  "Configure"
]);
const VIRTUAL_PATH_PREFIX = "__virtual__/";
const TEST_PATH_REGEX = /(^|\/)(test|tests|spec|specs|__tests__|__mocks__)(\/|$)|(\.|-)(test|spec)\./i;

function isVirtualPath(path: string): boolean {
  return path.startsWith(VIRTUAL_PATH_PREFIX);
}

function virtualPathForNode(node: GraphNode): string {
  const normalizedId = normalizePath(node.id).replace(/:/g, "_");
  return `${VIRTUAL_PATH_PREFIX}${node.kind}/${normalizedId}`;
}

function asMetadata(value: string | null): Metadata | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Metadata;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return 0;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const deduped = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.type}|${edge.from}|${edge.to}|${edge.filePath ?? ""}|${edge.line ?? ""}`;
    if (!deduped.has(key)) {
      deduped.set(key, edge);
    }
  }
  return Array.from(deduped.values());
}

function dedupeNodes(nodes: GraphNode[]): GraphNode[] {
  const deduped = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (!deduped.has(node.id)) {
      deduped.set(node.id, node);
      continue;
    }

    const existing = deduped.get(node.id)!;
    deduped.set(node.id, {
      ...existing,
      ...node,
      metadata: {
        ...(existing.metadata ?? {}),
        ...(node.metadata ?? {})
      }
    });
  }
  return Array.from(deduped.values());
}

function clampInteger(raw: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(raw as number)));
}

function normalizeDirection(raw: QueryDirection | undefined): QueryDirection {
  if (raw === "inbound" || raw === "outbound" || raw === "both") {
    return raw;
  }
  return "both";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseResolutionCandidates(
  raw: unknown
): SymbolReferenceItem["resolutionCandidates"] {
  const value = asString(raw);
  if (!value) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const candidates: NonNullable<SymbolReferenceItem["resolutionCandidates"]> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const id = asString(item.id);
    const name = asString(item.name);
    const confidence = asNumber(item.confidence);
    if (!id || !name || confidence === undefined) {
      continue;
    }
    candidates.push({
      id,
      name,
      confidence,
      fullyQualifiedName: asString(item.fullyQualifiedName)
    });
  }
  return candidates.length > 0 ? candidates : undefined;
}

function compareReferenceItems(left: SymbolReferenceItem, right: SymbolReferenceItem): number {
  const fileDelta = String(left.filePath ?? "").localeCompare(String(right.filePath ?? ""));
  if (fileDelta !== 0) {
    return fileDelta;
  }
  const fromDelta = left.fromId.localeCompare(right.fromId);
  if (fromDelta !== 0) {
    return fromDelta;
  }
  const toDelta = left.toId.localeCompare(right.toId);
  if (toDelta !== 0) {
    return toDelta;
  }
  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }
  const lineDelta = (left.line ?? 0) - (right.line ?? 0);
  if (lineDelta !== 0) {
    return lineDelta;
  }
  return left.flow.localeCompare(right.flow);
}

function edgeTraversalKey(edge: GraphEdge): string {
  return `${edge.type}|${edge.from}|${edge.to}|${edge.filePath ?? ""}|${edge.line ?? ""}`;
}

function buildSymbolNameCounts(nodes: GraphNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind !== "symbol") {
      continue;
    }
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  }
  return counts;
}

function isExternalAliasOfUniqueInRepoSymbol(
  node: GraphNode | undefined,
  symbolNameCounts: Map<string, number>
): boolean {
  if (node?.kind !== "external") {
    return false;
  }
  return (symbolNameCounts.get(node.name) ?? 0) === 1;
}

function normalizeOutputMode(raw: QueryOutputMode | undefined): QueryOutputMode {
  return raw === "files_only" ? "files_only" : "full";
}

function normalizeSymbolMatching(raw: SymbolMatchingMode | undefined): SymbolMatchingMode {
  if (raw === "qualified_only" || raw === "name" || raw === "prefer_qualified") {
    return raw;
  }
  return "prefer_qualified";
}

function isTestPath(filePath: string | undefined): boolean {
  if (!filePath) {
    return false;
  }
  return TEST_PATH_REGEX.test(normalizePath(filePath));
}

function computeSemanticClusters(graph: GraphDocument): ClusterComponent[] {
  const candidateNodes = graph.nodes.filter((node) => node.kind === "symbol" || node.kind === "external");
  if (candidateNodes.length === 0) {
    return [];
  }

  const candidateIds = new Set(candidateNodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  for (const node of candidateNodes) {
    adjacency.set(node.id, new Set());
  }

  const undirectedPairs = new Set<string>();
  for (const edge of graph.edges) {
    if (!SEMANTIC_EDGE_KINDS.has(edge.type)) {
      continue;
    }
    if (!candidateIds.has(edge.from) || !candidateIds.has(edge.to) || edge.from === edge.to) {
      continue;
    }

    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
    const [left, right] = edge.from < edge.to ? [edge.from, edge.to] : [edge.to, edge.from];
    undirectedPairs.add(`${left}|${right}`);
  }

  const orderedNodeIds = candidateNodes.map((node) => node.id).sort((left, right) => left.localeCompare(right));
  const visited = new Set<string>();
  const components: ClusterComponent[] = [];
  for (const nodeId of orderedNodeIds) {
    if (visited.has(nodeId)) {
      continue;
    }

    const queue: string[] = [nodeId];
    const members: string[] = [];
    visited.add(nodeId);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      members.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    members.sort((left, right) => left.localeCompare(right));
    const memberSet = new Set(members);
    let internalEdges = 0;
    for (const pair of undirectedPairs) {
      const [left, right] = pair.split("|", 2);
      if (memberSet.has(left) && memberSet.has(right)) {
        internalEdges += 1;
      }
    }

    const possibleEdges = members.length < 2 ? 0 : (members.length * (members.length - 1)) / 2;
    const density = possibleEdges === 0 ? 0 : Number((internalEdges / possibleEdges).toFixed(4));
    components.push({
      representative: members[0],
      memberIds: members,
      internalEdges,
      density
    });
  }

  return components.sort((left, right) => left.representative.localeCompare(right.representative));
}

function normalizeSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function lexicalScoreForNode(node: GraphNode, normalizedQuery: string, terms: string[]): number {
  if (normalizedQuery.length === 0 || terms.length === 0) {
    return 0;
  }

  const name = node.name.toLowerCase();
  const id = node.id.toLowerCase();
  const file = String(node.filePath ?? "").toLowerCase();
  const signature = String(node.signature ?? "").toLowerCase();

  if (name === normalizedQuery || id === normalizedQuery) {
    return 1;
  }
  if (name.startsWith(normalizedQuery) || id.startsWith(normalizedQuery)) {
    return 0.9;
  }

  const allTermsInIdentity = terms.every((term) => name.includes(term) || id.includes(term));
  if (allTermsInIdentity) {
    return 0.75;
  }

  const anyTermInIdentity = terms.some((term) => name.includes(term) || id.includes(term));
  if (anyTermInIdentity) {
    return 0.6;
  }

  const anyTermInContext = terms.some((term) => file.includes(term) || signature.includes(term));
  if (anyTermInContext) {
    return 0.45;
  }

  return 0;
}

export class SqliteGraphStore {
  private readonly repoPath: string;
  private readonly storeDir?: string;

  public constructor(repoPath: string, storeDir?: string) {
    this.repoPath = repoPath;
    this.storeDir = storeDir;
  }

  public async upsertGraph(graph: GraphDocument, changedFiles?: string[]): Promise<void> {
    const storage = resolveStoragePaths(this.repoPath, this.storeDir);
    await fs.mkdir(storage.storeDir, { recursive: true });
    const indexedAt = Math.trunc(Date.now() / 1000);

    await this.withDatabase(async (db) => {
      await this.ensureSchema(db);
      await db.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        const isIncrementalUpdate = changedFiles !== undefined;
        const changed = (changedFiles ?? []).map((value) => normalizePath(value));
        if (!isIncrementalUpdate) {
          await db.exec("DELETE FROM refs; DELETE FROM symbols; DELETE FROM files;");
        } else if (changed.length > 0) {
          await this.deleteChangedFileContributions(db, changed);
        }

        const fileIdCache = new Map<string, number>();
        const symbolIdCache = new Map<string, SymbolLookup>();

        for (const node of graph.nodes) {
          const filePath = normalizePath(node.filePath ?? virtualPathForNode(node));
          const fileId = await this.upsertFileRow(
            db,
            filePath,
            node.language ?? "unknown",
            node.sourceHash ?? "",
            indexedAt,
            fileIdCache
          );
          const metadataJson = node.metadata ? JSON.stringify(node.metadata) : null;
          const metadata = node.metadata ?? {};
          const startLine = asInteger(metadata.startLine ?? metadata.start_line);
          const startCol = asInteger(metadata.startCol ?? metadata.start_col);
          const endLine = asInteger(metadata.endLine ?? metadata.end_line);
          const endCol = asInteger(metadata.endCol ?? metadata.end_col);
          const docstring =
            typeof metadata.docstring === "string" ? String(metadata.docstring) : null;

          await db.run(
            `INSERT INTO symbols (
               file_id, name, kind, qualified, parent_id,
               start_line, start_col, end_line, end_col,
               signature, docstring, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(qualified) DO UPDATE SET
               file_id = excluded.file_id,
               name = excluded.name,
               kind = excluded.kind,
               parent_id = excluded.parent_id,
               start_line = excluded.start_line,
               start_col = excluded.start_col,
               end_line = excluded.end_line,
               end_col = excluded.end_col,
               signature = excluded.signature,
               docstring = excluded.docstring,
               metadata_json = excluded.metadata_json`,
            fileId,
            node.name,
            node.kind,
            node.id,
            null,
            startLine,
            startCol,
            endLine,
            endCol,
            node.signature ?? null,
            docstring,
            metadataJson
          );

          const symbolRow = await db.get<{ id: number; file_id: number }>(
            "SELECT id, file_id FROM symbols WHERE qualified = ?",
            node.id
          );
          if (symbolRow) {
            symbolIdCache.set(node.id, { id: symbolRow.id, fileId: symbolRow.file_id });
          }
        }

        for (const edge of dedupeEdges(graph.edges)) {
          const fromSymbol = await this.getSymbolLookup(db, edge.from, symbolIdCache);
          const toSymbol = await this.getSymbolLookup(db, edge.to, symbolIdCache);
          if (!fromSymbol || !toSymbol) {
            continue;
          }

          const filePath = edge.filePath ? normalizePath(edge.filePath) : undefined;
          const fileId = filePath
            ? await this.upsertFileRow(db, filePath, "unknown", "", indexedAt, fileIdCache)
            : fromSymbol.fileId;
          const metadataJson = edge.metadata ? JSON.stringify(edge.metadata) : null;

          await db.run(
            `INSERT INTO refs (symbol_id, file_id, kind, context_id, line, col, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(symbol_id, file_id, kind, context_id, line, col) DO UPDATE SET
               metadata_json = excluded.metadata_json`,
            toSymbol.id,
            fileId,
            edge.type,
            fromSymbol.id,
            asInteger(edge.line),
            0,
            metadataJson
          );
        }

        await db.exec("COMMIT;");
      } catch (error) {
        await db.exec("ROLLBACK;");
        throw error;
      }
    });

    await this.rebuildClusterIndex();
  }

  public async getSymbolNeighborhood(
    query: SymbolNeighborhoodQueryOptions
  ): Promise<SymbolNeighborhoodResult> {
    const boundedDepth = clampInteger(query.depth, 1, 6, 2);
    const boundedLimit = clampInteger(query.limit, 1, 500, 100);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const boundedEdgeLimit = clampInteger(query.edgeLimit, 1, 2_000, 500);
    const direction = normalizeDirection(query.direction);
    const includeStructural = Boolean(query.includeStructural);
    const traversalLimit = clampInteger(boundedOffset + boundedLimit + 200, 100, 5_000, 400);
    const graph = await this.readGraph();

    const traversal = this.buildTraversalView(graph, {
      symbol: query.symbol,
      depth: boundedDepth,
      direction,
      includeStructural,
      traversalLimit
    });

    if (!traversal) {
      return {
        query: {
          symbol: query.symbol,
          depth: boundedDepth,
          limit: boundedLimit,
          offset: boundedOffset,
          edgeLimit: boundedEdgeLimit,
          direction,
          includeStructural
        },
        summary: {
          matchedRoots: 0,
          selectedRoot: null,
          totalNodes: 0,
          returnedNodes: 0,
          hasMoreNodes: false,
          totalEdges: 0,
          returnedEdges: 0,
          hasMoreEdges: false,
          truncated: false
        },
        root: null,
        matchedRoots: [],
        nodes: [],
        edges: []
      };
    }

    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const nodes = Array.from(traversal.visitedNodeIds)
      .map((id) => nodeById.get(id))
      .filter((node): node is GraphNode => node !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
    const pagedNodes = nodes.slice(boundedOffset, boundedOffset + boundedLimit);
    const visibleNodeIds = new Set(pagedNodes.map((node) => node.id));

    const traversedEdgeKeys = traversal.traversedEdgeSet;
    const edges = graph.edges
      .filter((edge) => {
        const key = edgeTraversalKey(edge);
        return traversedEdgeKeys.has(key) && visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to);
      })
      .sort((left, right) => edgeTraversalKey(left).localeCompare(edgeTraversalKey(right)));
    const pagedEdges = edges.slice(0, boundedEdgeLimit);

    return {
      query: {
        symbol: query.symbol,
        depth: boundedDepth,
        limit: boundedLimit,
        offset: boundedOffset,
        edgeLimit: boundedEdgeLimit,
        direction,
        includeStructural
      },
      summary: {
        matchedRoots: traversal.matchedRoots.length,
        selectedRoot: traversal.root.id,
        totalNodes: nodes.length,
        returnedNodes: pagedNodes.length,
        hasMoreNodes: nodes.length > boundedOffset + pagedNodes.length,
        totalEdges: edges.length,
        returnedEdges: pagedEdges.length,
        hasMoreEdges: edges.length > pagedEdges.length,
        truncated:
          traversal.traversalCapped ||
          nodes.length > boundedOffset + pagedNodes.length ||
          edges.length > pagedEdges.length
      },
      root: traversal.root,
      matchedRoots: traversal.matchedRoots,
      nodes: pagedNodes,
      edges: pagedEdges
    };
  }

  public async findSymbolReferences(
    query: SymbolReferencesQueryOptions
  ): Promise<SymbolReferencesResult> {
    const boundedLimit = clampInteger(query.limit, 1, 1_000, 200);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const includeStructural = Boolean(query.includeStructural);
    const matching = normalizeSymbolMatching(query.matching);
    const includeExternalNameMatches = query.includeExternalNameMatches ?? true;
    const includeAliasExpansion = query.includeAliasExpansion ?? true;
    const outputMode = normalizeOutputMode(query.outputMode);
    const excludeSelf = Boolean(query.excludeSelf);
    const testOnly = Boolean(query.testOnly);
    const graph = await this.readGraph();
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const roots = this.findMatchingRoots(graph.nodes, query.symbol, matching);
    const rootIds = new Set(roots.map((root) => root.id));
    const rootNames = new Set(roots.map((root) => root.name));
    const unresolvedAliasIds =
      includeExternalNameMatches || includeAliasExpansion
        ? new Set(
            graph.nodes
              .filter((node) => node.kind === "external" && rootNames.has(node.name))
              .map((node) => node.id)
          )
        : new Set<string>();
    const seedTargetIds = new Set([...rootIds, ...unresolvedAliasIds]);
    const targetIds = includeAliasExpansion
      ? this.expandReferenceTargetIds(graph, seedTargetIds)
      : new Set(seedTargetIds);
    const aliasExpandedOnlyIds = new Set(
      [...targetIds].filter((targetId) => includeAliasExpansion && !seedTargetIds.has(targetId))
    );

    const references = graph.edges
      .filter((edge) => {
        if (!targetIds.has(edge.to)) {
          return false;
        }
        if (!includeStructural && STRUCTURAL_EDGE_KINDS.has(edge.type)) {
          return false;
        }
        return true;
      })
      .map((edge) => this.toReferenceItem(edge, nodeById, "inbound", aliasExpandedOnlyIds))
      .filter((reference) => {
        if (excludeSelf && reference.fromFilePath && reference.toFilePath) {
          if (normalizePath(reference.fromFilePath) === normalizePath(reference.toFilePath)) {
            return false;
          }
        }

        if (testOnly) {
          const sourcePath = reference.filePath ?? reference.fromFilePath;
          return isTestPath(sourcePath);
        }

        return true;
      })
      .sort(compareReferenceItems);
    const pagedReferences =
      outputMode === "files_only" ? [] : references.slice(boundedOffset, boundedOffset + boundedLimit);
    const fileCounts = new Map<string, number>();
    for (const reference of references) {
      const filePath = reference.filePath ?? reference.fromFilePath ?? reference.toFilePath;
      if (!filePath) {
        continue;
      }
      const normalizedFilePath = normalizePath(filePath);
      fileCounts.set(normalizedFilePath, (fileCounts.get(normalizedFilePath) ?? 0) + 1);
    }

    return {
      query: {
        symbol: query.symbol,
        limit: boundedLimit,
        offset: boundedOffset,
        includeStructural,
        matching,
        includeExternalNameMatches,
        includeAliasExpansion,
        outputMode,
        excludeSelf,
        testOnly
      },
      summary: {
        matchedRoots: roots.length,
        totalReferences: references.length,
        returnedReferences: pagedReferences.length,
        hasMore:
          outputMode === "files_only" ? false : references.length > boundedOffset + pagedReferences.length
      },
      roots,
      references: pagedReferences,
      files: Array.from(fileCounts.entries())
        .map(([filePath, references]) => ({ filePath, references }))
        .sort((left, right) => right.references - left.references || left.filePath.localeCompare(right.filePath))
    };
  }

  public async getReferencesForFile(query: FileReferencesQueryOptions): Promise<FileReferencesResult> {
    const targetFilePath = normalizePath(query.filePath);
    const boundedLimit = clampInteger(query.limit, 1, 1_000, 200);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const direction = normalizeDirection(query.direction);
    const includeStructural = Boolean(query.includeStructural);
    const includeExternalNameMatches = query.includeExternalNameMatches ?? true;
    const includeAliasExpansion = query.includeAliasExpansion ?? true;
    const outputMode = query.outputMode === "full" ? "full" : "files_only";
    const excludeSelf = Boolean(query.excludeSelf);
    const testOnly = Boolean(query.testOnly);
    const graph = await this.readGraph();
    const symbolNameCounts = buildSymbolNameCounts(graph.nodes);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const allowedKinds = includeStructural
      ? new Set<string>([...SEMANTIC_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS])
      : SEMANTIC_EDGE_KINDS;
    const seedNodes = graph.nodes.filter((node) => normalizePath(node.filePath ?? "") === targetFilePath);
    const seedTargetIds = new Set(seedNodes.map((node) => node.id));
    if (includeExternalNameMatches) {
      const seedSymbolNames = new Set(
        seedNodes
          .filter((node) => node.kind === "symbol" && (symbolNameCounts.get(node.name) ?? 0) === 1)
          .map((node) => node.name)
      );
      for (const node of graph.nodes) {
        if (node.kind === "external" && seedSymbolNames.has(node.name)) {
          seedTargetIds.add(node.id);
        }
      }
    }
    const targetIds = includeAliasExpansion
      ? this.expandReferenceTargetIds(graph, seedTargetIds)
      : seedTargetIds;

    const matchedReferences = graph.edges
      .filter((edge) => allowedKinds.has(edge.type))
      .flatMap((edge) => {
        const fromMatches = targetIds.has(edge.from);
        const toMatches = targetIds.has(edge.to);
        if (!fromMatches && !toMatches) {
          return [];
        }

        const flow = toMatches ? "inbound" : "outbound";
        if (direction === "inbound" && flow !== "inbound") {
          return [];
        }
        if (direction === "outbound" && flow !== "outbound") {
          return [];
        }

        const reference = this.toReferenceItem(edge, nodeById, flow, new Set());
        const counterpartPathRaw =
          (flow === "inbound" ? reference.fromFilePath : reference.toFilePath) ?? reference.filePath;
        if (!counterpartPathRaw) {
          return [];
        }
        const counterpartPath = normalizePath(counterpartPathRaw);
        if (counterpartPath === targetFilePath) {
          return [];
        }

        if (excludeSelf && reference.fromFilePath && reference.toFilePath) {
          if (normalizePath(reference.fromFilePath) === normalizePath(reference.toFilePath)) {
            return [];
          }
        }

        if (testOnly) {
          if (!isTestPath(counterpartPath)) {
            return [];
          }
        }

        return [reference];
      })
      .sort(compareReferenceItems);

    const fileCounts = new Map<string, { inbound: number; outbound: number; references: number }>();
    for (const reference of matchedReferences) {
      const counterpartPathRaw =
        (reference.flow === "inbound" ? reference.fromFilePath : reference.toFilePath) ??
        reference.filePath;
      if (!counterpartPathRaw) {
        continue;
      }
      const counterpartPath = normalizePath(counterpartPathRaw);
      const current = fileCounts.get(counterpartPath) ?? { inbound: 0, outbound: 0, references: 0 };
      current.references += 1;
      if (reference.flow === "inbound") {
        current.inbound += 1;
      } else {
        current.outbound += 1;
      }
      fileCounts.set(counterpartPath, current);
    }

    const allFiles = Array.from(fileCounts.entries())
      .map(([filePath, stats]) => ({
        filePath,
        inbound: stats.inbound,
        outbound: stats.outbound,
        references: stats.references
      }))
      .sort((left, right) => right.references - left.references || left.filePath.localeCompare(right.filePath));
    const pagedFiles = allFiles.slice(boundedOffset, boundedOffset + boundedLimit);
    const pagedReferences =
      outputMode === "files_only"
        ? []
        : matchedReferences.slice(boundedOffset, boundedOffset + boundedLimit);

    return {
      query: {
        filePath: targetFilePath,
        direction,
        limit: boundedLimit,
        offset: boundedOffset,
        includeStructural,
        includeExternalNameMatches,
        includeAliasExpansion,
        outputMode,
        excludeSelf,
        testOnly
      },
      summary: {
        totalFiles: allFiles.length,
        returnedFiles: pagedFiles.length,
        hasMoreFiles: allFiles.length > boundedOffset + pagedFiles.length,
        totalReferences: matchedReferences.length,
        returnedReferences: pagedReferences.length,
        hasMoreReferences:
          outputMode === "files_only" ? false : matchedReferences.length > boundedOffset + pagedReferences.length
      },
      files: pagedFiles,
      references: pagedReferences
    };
  }

  public async getHybridSearch(query: HybridSearchQueryOptions): Promise<HybridSearchResult> {
    const rawQuery = query.query.trim();
    const normalizedQuery = rawQuery.toLowerCase();
    const terms = normalizeSearchTerms(rawQuery);
    const boundedLimit = clampInteger(query.limit, 1, 1_000, 50);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const boundedDepth = clampInteger(query.depth, 1, 4, 2);
    const includeStructural = Boolean(query.includeStructural);
    const outputMode = normalizeOutputMode(query.outputMode);
    const graph = await this.readGraph();

    if (normalizedQuery.length === 0 || terms.length === 0) {
      return {
        query: {
          query: rawQuery,
          limit: boundedLimit,
          offset: boundedOffset,
          depth: boundedDepth,
          includeStructural,
          outputMode
        },
        summary: {
          totalMatches: 0,
          returnedMatches: 0,
          hasMoreMatches: false,
          totalFiles: 0,
          returnedFiles: 0,
          hasMoreFiles: false
        },
        seeds: [],
        hits: [],
        files: []
      };
    }

    const lexicalScores = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.kind !== "symbol" && node.kind !== "external") {
        continue;
      }
      const score = lexicalScoreForNode(node, normalizedQuery, terms);
      if (score > 0) {
        lexicalScores.set(node.id, score);
      }
    }

    const seeds = graph.nodes
      .filter((node) => lexicalScores.has(node.id))
      .sort(
        (left, right) =>
          (lexicalScores.get(right.id) ?? 0) - (lexicalScores.get(left.id) ?? 0) ||
          left.id.localeCompare(right.id)
      );

    const edgeWeights = new Map<string, number>([
      [EdgeKind.Calls, 1],
      [EdgeKind.DependsOn, 0.85],
      [EdgeKind.Imports, 0.7],
      [EdgeKind.Defines, 0.35],
      [EdgeKind.Contains, 0.25]
    ]);
    const allowedEdgeKinds = includeStructural
      ? new Set<string>([...SEMANTIC_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS])
      : SEMANTIC_EDGE_KINDS;
    const adjacency = new Map<string, Array<{ nodeId: string; weight: number }>>();
    const semanticDegree = new Map<string, number>();
    for (const edge of graph.edges) {
      if (!allowedEdgeKinds.has(edge.type)) {
        continue;
      }
      const weight = edgeWeights.get(edge.type) ?? 0.5;
      const push = (source: string, target: string): void => {
        const neighbors = adjacency.get(source) ?? [];
        neighbors.push({ nodeId: target, weight });
        adjacency.set(source, neighbors);
      };
      push(edge.from, edge.to);
      push(edge.to, edge.from);
      semanticDegree.set(edge.from, (semanticDegree.get(edge.from) ?? 0) + weight);
      semanticDegree.set(edge.to, (semanticDegree.get(edge.to) ?? 0) + weight);
    }

    const proximityScores = new Map<string, number>();
    const queue: Array<{ nodeId: string; hops: number; score: number }> = [];
    for (const [nodeId, lexicalScore] of lexicalScores.entries()) {
      queue.push({ nodeId, hops: 0, score: lexicalScore });
    }

    const decay = 0.75;
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (current.hops >= boundedDepth) {
        continue;
      }
      for (const neighbor of adjacency.get(current.nodeId) ?? []) {
        const candidateScore = Number((current.score * decay * neighbor.weight).toFixed(6));
        if (candidateScore <= 0) {
          continue;
        }
        const existing = proximityScores.get(neighbor.nodeId) ?? 0;
        if (candidateScore > existing) {
          proximityScores.set(neighbor.nodeId, candidateScore);
          queue.push({
            nodeId: neighbor.nodeId,
            hops: current.hops + 1,
            score: candidateScore
          });
        }
      }
    }

    const allHits: HybridSearchHit[] = graph.nodes
      .filter((node) => {
        if (node.kind !== "symbol" && node.kind !== "external") {
          return false;
        }
        const lexicalScore = lexicalScores.get(node.id) ?? 0;
        const proximityScore = proximityScores.get(node.id) ?? 0;
        return lexicalScore > 0 || proximityScore > 0;
      })
      .map((node) => {
        const lexicalScore = lexicalScores.get(node.id) ?? 0;
        const proximityScore = proximityScores.get(node.id) ?? 0;
        const semanticScore = Math.min(1, (semanticDegree.get(node.id) ?? 0) / 4);
        const score = Number((lexicalScore * 0.55 + proximityScore * 0.3 + semanticScore * 0.15).toFixed(6));
        return { node, score, lexicalScore, proximityScore, semanticScore };
      })
      .sort((left, right) => {
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        const lexicalDelta = right.lexicalScore - left.lexicalScore;
        if (lexicalDelta !== 0) {
          return lexicalDelta;
        }
        const proximityDelta = right.proximityScore - left.proximityScore;
        if (proximityDelta !== 0) {
          return proximityDelta;
        }
        return left.node.id.localeCompare(right.node.id);
      });

    const pagedHits = allHits.slice(boundedOffset, boundedOffset + boundedLimit);
    const fileStats = new Map<string, { hits: number; maxScore: number }>();
    for (const hit of allHits) {
      if (!hit.node.filePath) {
        continue;
      }
      const filePath = normalizePath(hit.node.filePath);
      const current = fileStats.get(filePath) ?? { hits: 0, maxScore: 0 };
      current.hits += 1;
      current.maxScore = Math.max(current.maxScore, hit.score);
      fileStats.set(filePath, current);
    }
    const allFiles = Array.from(fileStats.entries())
      .map(([filePath, stats]) => ({
        filePath,
        hits: stats.hits,
        maxScore: Number(stats.maxScore.toFixed(6))
      }))
      .sort((left, right) => right.maxScore - left.maxScore || right.hits - left.hits || left.filePath.localeCompare(right.filePath));
    const pagedFiles = allFiles.slice(boundedOffset, boundedOffset + boundedLimit);

    return {
      query: {
        query: rawQuery,
        limit: boundedLimit,
        offset: boundedOffset,
        depth: boundedDepth,
        includeStructural,
        outputMode
      },
      summary: {
        totalMatches: allHits.length,
        returnedMatches: outputMode === "files_only" ? 0 : pagedHits.length,
        hasMoreMatches: outputMode === "files_only" ? false : allHits.length > boundedOffset + pagedHits.length,
        totalFiles: allFiles.length,
        returnedFiles: pagedFiles.length,
        hasMoreFiles: allFiles.length > boundedOffset + pagedFiles.length
      },
      seeds,
      hits: outputMode === "files_only" ? [] : pagedHits,
      files: pagedFiles
    };
  }

  public async getImpactFromDiff(query: ImpactFromDiffQueryOptions): Promise<ImpactFromDiffResult> {
    const changedFiles = (query.changedFiles ?? []).map((value) => normalizePath(value));
    const symbols = (query.symbols ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
    const boundedDepth = clampInteger(query.depth, 1, 6, 2);
    const boundedLimit = clampInteger(query.limit, 1, 500, 100);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const boundedEdgeLimit = clampInteger(query.edgeLimit, 1, 2_000, 500);
    const direction = normalizeDirection(query.direction);
    const includeStructural = Boolean(query.includeStructural);
    const includeExternalTouchpoints = query.includeExternalTouchpoints ?? true;
    const outputMode = normalizeOutputMode(query.outputMode);
    const traversalLimit = clampInteger(boundedOffset + boundedLimit + 400, 200, 5_000, 600);
    const graph = await this.readGraph();
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const changedFileSet = new Set(changedFiles);
    const symbolSet = new Set(symbols);

    const seeds = graph.nodes.filter(
      (node) =>
        (node.filePath !== undefined && changedFileSet.has(normalizePath(node.filePath))) ||
        symbolSet.has(node.name) ||
        symbolSet.has(node.id)
    );
    const uniqueSeeds = dedupeNodes(seeds);

    if (uniqueSeeds.length === 0) {
      return {
        query: {
          changedFiles,
          symbols,
          depth: boundedDepth,
          limit: boundedLimit,
          offset: boundedOffset,
          edgeLimit: boundedEdgeLimit,
          direction,
          includeStructural,
          includeExternalTouchpoints,
          outputMode
        },
        summary: {
          seedCount: 0,
          totalNodes: 0,
          returnedNodes: 0,
          hasMoreNodes: false,
          totalEdges: 0,
          returnedEdges: 0,
          hasMoreEdges: false,
          totalFiles: 0,
          returnedFiles: 0,
          hasMoreFiles: false,
          totalExternalTouchpoints: 0,
          returnedExternalTouchpoints: 0,
          hasMoreExternalTouchpoints: false,
          truncated: false
        },
        seeds: [],
        nodes: [],
        edges: [],
        files: [],
        impactedFiles: [],
        externalTouchpoints: []
      };
    }

    const allowedEdgeKinds = includeStructural
      ? new Set<string>([...SEMANTIC_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS])
      : SEMANTIC_EDGE_KINDS;
    const adjacency = this.buildAdjacency(graph.edges, direction, allowedEdgeKinds);
    const traversableSeeds = uniqueSeeds.filter((seed) => seed.kind !== NodeKind.External);
    const visited = new Set<string>(traversableSeeds.map((seed) => seed.id));
    const traversedEdgeSet = new Set<string>();
    const queue = traversableSeeds.map((seed) => ({ id: seed.id, hops: 0 }));
    let traversalCapped = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      if (current.hops >= boundedDepth) {
        continue;
      }
      for (const neighbor of adjacency.get(current.id) ?? []) {
        traversedEdgeSet.add(edgeTraversalKey(neighbor.edge));
        const neighborNode = nodeById.get(neighbor.nodeId);
        if (neighborNode?.kind === NodeKind.External) {
          continue;
        }
        if (!visited.has(neighbor.nodeId)) {
          if (visited.size >= traversalLimit) {
            traversalCapped = true;
            break;
          }
          visited.add(neighbor.nodeId);
          queue.push({ id: neighbor.nodeId, hops: current.hops + 1 });
        }
      }
      if (traversalCapped) {
        break;
      }
    }

    const allNodes = Array.from(visited)
      .map((id) => nodeById.get(id))
      .filter((node): node is GraphNode => node !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
    const pagedNodes =
      outputMode === "files_only" ? [] : allNodes.slice(boundedOffset, boundedOffset + boundedLimit);
    const visibleNodeIds = new Set(pagedNodes.map((node) => node.id));

    const traversedEdges = graph.edges
      .filter((edge) => {
        return traversedEdgeSet.has(edgeTraversalKey(edge));
      })
      .sort((left, right) => edgeTraversalKey(left).localeCompare(edgeTraversalKey(right)));
    const visibleEdges =
      outputMode === "files_only"
        ? []
        : traversedEdges.filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));
    const pagedEdges = visibleEdges.slice(0, boundedEdgeLimit);

    const fileCounts = new Map<string, number>();
    for (const node of allNodes) {
      if (!node.filePath) {
        continue;
      }
      const filePath = normalizePath(node.filePath);
      fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1);
    }
    const allImpactedFiles = Array.from(fileCounts.entries())
      .map(([filePath, hits]) => ({ filePath, hits }))
      .sort((left, right) => right.hits - left.hits || left.filePath.localeCompare(right.filePath));
    const pagedImpactedFiles = allImpactedFiles.slice(boundedOffset, boundedOffset + boundedLimit);

    const allExternalTouchpoints: ImpactExternalTouchpointItem[] = [];
    if (includeExternalTouchpoints) {
      const touchpointByExternalId = new Map<
        string,
        {
          symbolId: string;
          symbol: string;
          references: number;
          inbound: number;
          outbound: number;
          fileCounts: Map<string, number>;
        }
      >();
      for (const edge of traversedEdges) {
        const fromNode = nodeById.get(edge.from);
        const toNode = nodeById.get(edge.to);
        if (!fromNode || !toNode) {
          continue;
        }

        let externalNode: GraphNode | undefined;
        let internalNode: GraphNode | undefined;
        let outbound = false;
        if (fromNode.kind !== NodeKind.External && toNode.kind === NodeKind.External && visited.has(fromNode.id)) {
          internalNode = fromNode;
          externalNode = toNode;
          outbound = true;
        } else if (fromNode.kind === NodeKind.External && toNode.kind !== NodeKind.External && visited.has(toNode.id)) {
          internalNode = toNode;
          externalNode = fromNode;
          outbound = false;
        } else {
          continue;
        }

        const record = touchpointByExternalId.get(externalNode.id) ?? {
          symbolId: externalNode.id,
          symbol: externalNode.name,
          references: 0,
          inbound: 0,
          outbound: 0,
          fileCounts: new Map<string, number>()
        };
        record.references += 1;
        if (outbound) {
          record.outbound += 1;
        } else {
          record.inbound += 1;
        }

        const filePath = normalizePath(edge.filePath ?? internalNode.filePath ?? "");
        if (filePath.length > 0) {
          record.fileCounts.set(filePath, (record.fileCounts.get(filePath) ?? 0) + 1);
        }
        touchpointByExternalId.set(externalNode.id, record);
      }

      allExternalTouchpoints.push(
        ...Array.from(touchpointByExternalId.values())
          .map((record) => ({
            symbolId: record.symbolId,
            symbol: record.symbol,
            references: record.references,
            inbound: record.inbound,
            outbound: record.outbound,
            files: Array.from(record.fileCounts.entries())
              .map(([filePath, references]) => ({ filePath, references }))
              .sort((left, right) => right.references - left.references || left.filePath.localeCompare(right.filePath))
          }))
          .sort((left, right) => right.references - left.references || left.symbol.localeCompare(right.symbol))
      );
    }
    const pagedExternalTouchpoints = allExternalTouchpoints.slice(boundedOffset, boundedOffset + boundedLimit);

    return {
      query: {
        changedFiles,
        symbols,
        depth: boundedDepth,
        limit: boundedLimit,
        offset: boundedOffset,
        edgeLimit: boundedEdgeLimit,
        direction,
        includeStructural,
        includeExternalTouchpoints,
        outputMode
      },
      summary: {
        seedCount: uniqueSeeds.length,
        totalNodes: allNodes.length,
        returnedNodes: pagedNodes.length,
        hasMoreNodes: outputMode === "files_only" ? false : allNodes.length > boundedOffset + pagedNodes.length,
        totalEdges: traversedEdges.length,
        returnedEdges: pagedEdges.length,
        hasMoreEdges:
          outputMode === "files_only" ? traversedEdges.length > 0 : traversedEdges.length > pagedEdges.length,
        totalFiles: allImpactedFiles.length,
        returnedFiles: pagedImpactedFiles.length,
        hasMoreFiles: allImpactedFiles.length > boundedOffset + pagedImpactedFiles.length,
        totalExternalTouchpoints: allExternalTouchpoints.length,
        returnedExternalTouchpoints: pagedExternalTouchpoints.length,
        hasMoreExternalTouchpoints: allExternalTouchpoints.length > boundedOffset + pagedExternalTouchpoints.length,
        truncated:
          traversalCapped ||
          allExternalTouchpoints.length > boundedOffset + pagedExternalTouchpoints.length ||
          (outputMode === "files_only"
            ? allImpactedFiles.length > boundedOffset + pagedImpactedFiles.length
            : allNodes.length > boundedOffset + pagedNodes.length || traversedEdges.length > pagedEdges.length)
      },
      seeds: uniqueSeeds,
      nodes: pagedNodes,
      edges: pagedEdges,
      files: pagedImpactedFiles,
      impactedFiles: pagedImpactedFiles,
      externalTouchpoints: pagedExternalTouchpoints
    };
  }

  public async getRelatedClusters(query: RelatedClustersQueryOptions): Promise<RelatedClustersResult> {
    const symbols = (query.symbols ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
    const changedFiles = (query.changedFiles ?? [])
      .map((value) => normalizePath(value))
      .filter((value) => value.length > 0);
    const boundedLimit = clampInteger(query.limit, 1, 1_000, 20);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const boundedMinSize = clampInteger(query.minSize, 1, 10_000, 2);
    const includeMembers = Boolean(query.includeMembers);
    const boundedMemberLimit = clampInteger(query.memberLimit, 1, 500, 25);
    const symbolSet = new Set(symbols);
    const changedFileSet = new Set(changedFiles);
    const graph = await this.readGraph();
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const seeds = dedupeNodes(
      graph.nodes.filter((node) => {
        if (node.kind !== "symbol" && node.kind !== "external") {
          return false;
        }
        if (symbolSet.has(node.id) || symbolSet.has(node.name)) {
          return true;
        }
        if (!node.filePath) {
          return false;
        }
        return changedFileSet.has(normalizePath(node.filePath));
      })
    ).sort((left, right) => left.id.localeCompare(right.id));
    const seedIds = new Set(seeds.map((node) => node.id));

    const { clusterRows, memberRows } = await this.withDatabase(async (db) => {
      await this.ensureSchema(db);
      const clusterRows = await db.all<{
        id: string;
        representative: string;
        size: number;
        internal_edges: number;
        density: number;
      }[]>(`SELECT id, representative, size, internal_edges, density FROM clusters ORDER BY representative, id`);
      const memberRows = await db.all<{ cluster_id: string; symbol_qualified: string }[]>(
        `SELECT cluster_id, symbol_qualified FROM cluster_members ORDER BY cluster_id, symbol_qualified`
      );
      return { clusterRows, memberRows };
    });

    const membersByCluster = new Map<string, string[]>();
    for (const row of memberRows) {
      const members = membersByCluster.get(row.cluster_id) ?? [];
      members.push(row.symbol_qualified);
      membersByCluster.set(row.cluster_id, members);
    }

    const allClusters: RelatedClusterItem[] = [];
    for (const row of clusterRows) {
      const memberIds = membersByCluster.get(row.id) ?? [];
      if (memberIds.length < boundedMinSize) {
        continue;
      }

      const seedHits = memberIds.reduce((count, memberId) => count + (seedIds.has(memberId) ? 1 : 0), 0);
      if (seedIds.size > 0 && seedHits === 0) {
        continue;
      }

      const fileCounts = new Map<string, number>();
      for (const memberId of memberIds) {
        const memberNode = nodeById.get(memberId);
        if (!memberNode?.filePath) {
          continue;
        }
        const filePath = normalizePath(memberNode.filePath);
        fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1);
      }

      const members = includeMembers
        ? memberIds
            .map((memberId) => nodeById.get(memberId))
            .filter((node): node is GraphNode => node !== undefined)
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, boundedMemberLimit)
        : [];

      allClusters.push({
        clusterId: row.id,
        representative: row.representative,
        size: row.size,
        internalEdges: row.internal_edges,
        density: row.density,
        seedHits,
        files: Array.from(fileCounts.entries())
          .map(([filePath, hits]) => ({ filePath, hits }))
          .sort((left, right) => right.hits - left.hits || left.filePath.localeCompare(right.filePath)),
        members
      });
    }

    allClusters.sort((left, right) => {
      const seedDelta = right.seedHits - left.seedHits;
      if (seedDelta !== 0) {
        return seedDelta;
      }
      const sizeDelta = right.size - left.size;
      if (sizeDelta !== 0) {
        return sizeDelta;
      }
      const densityDelta = right.density - left.density;
      if (densityDelta !== 0) {
        return densityDelta;
      }
      return left.clusterId.localeCompare(right.clusterId);
    });

    const pagedClusters = allClusters.slice(boundedOffset, boundedOffset + boundedLimit);
    return {
      query: {
        symbols,
        changedFiles,
        limit: boundedLimit,
        offset: boundedOffset,
        minSize: boundedMinSize,
        includeMembers,
        memberLimit: boundedMemberLimit
      },
      summary: {
        seedCount: seeds.length,
        totalClusters: allClusters.length,
        returnedClusters: pagedClusters.length,
        hasMoreClusters: allClusters.length > boundedOffset + pagedClusters.length
      },
      seeds,
      clusters: pagedClusters
    };
  }

  public async getProcessFlow(query: ProcessFlowQueryOptions): Promise<ProcessFlowResult> {
    const boundedLimit = clampInteger(query.limit, 1, 1_000, 100);
    const boundedOffset = clampInteger(query.offset, 0, 100_000, 0);
    const boundedEdgeLimit = clampInteger(query.edgeLimit, 1, 2_000, 500);
    const includeStructural = Boolean(query.includeStructural);
    const entrySymbols = (query.entrySymbols ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const graph = await this.readGraph();

    let entrypointCandidates: GraphNode[];
    if (entrySymbols.length > 0) {
      const entrySet = new Set(entrySymbols);
      entrypointCandidates = graph.nodes.filter(
        (node) => node.kind === "symbol" && (entrySet.has(node.id) || entrySet.has(node.name))
      );
    } else {
      entrypointCandidates = graph.nodes.filter(
        (node) => node.kind === "symbol" && DEFAULT_ENTRYPOINT_NAMES.has(node.name)
      );
    }

    const entrypoints = dedupeNodes(entrypointCandidates).sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const entrypointIds = new Set(entrypoints.map((node) => node.id));
    const allowedEdgeKinds = includeStructural
      ? new Set<string>([...SEMANTIC_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS])
      : SEMANTIC_EDGE_KINDS;

    const outboundEdges = graph.edges
      .filter((edge) => allowedEdgeKinds.has(edge.type) && entrypointIds.has(edge.from))
      .sort((left, right) => edgeTraversalKey(left).localeCompare(edgeTraversalKey(right)));
    const pagedEdges = outboundEdges.slice(0, boundedEdgeLimit);

    const linkedNodeIds = new Set<string>(entrypoints.map((node) => node.id));
    for (const edge of outboundEdges) {
      linkedNodeIds.add(edge.from);
      linkedNodeIds.add(edge.to);
    }

    const allNodes = graph.nodes
      .filter((node) => linkedNodeIds.has(node.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const pagedNodes = allNodes.slice(boundedOffset, boundedOffset + boundedLimit);

    return {
      query: {
        entrySymbols,
        limit: boundedLimit,
        offset: boundedOffset,
        edgeLimit: boundedEdgeLimit,
        includeStructural
      },
      summary: {
        detectedEntrypoints: entrypoints.length,
        totalNodes: allNodes.length,
        returnedNodes: pagedNodes.length,
        hasMoreNodes: allNodes.length > boundedOffset + pagedNodes.length,
        totalEdges: outboundEdges.length,
        returnedEdges: pagedEdges.length,
        hasMoreEdges: outboundEdges.length > pagedEdges.length
      },
      entrypoints,
      nodes: pagedNodes,
      edges: pagedEdges
    };
  }

  public async readGraph(): Promise<GraphDocument> {
    return this.withDatabase(async (db) => {
      await this.ensureSchema(db);

      const symbolRows = await db.all<{
        qualified: string;
        kind: string;
        name: string;
        language: string;
        file_path: string;
        file_hash: string;
        signature: string | null;
        metadata_json: string | null;
      }[]>(
        `SELECT
           s.qualified,
           s.kind,
           s.name,
           f.language,
           f.path AS file_path,
           f.hash AS file_hash,
           s.signature,
           s.metadata_json
         FROM symbols s
         JOIN files f ON f.id = s.file_id`
      );

      const nodes: GraphNode[] = symbolRows.map((row) => ({
        id: row.qualified,
        kind: row.kind as GraphNode["kind"],
        name: row.name,
        language: row.language === "unknown" ? undefined : (row.language as GraphNode["language"]),
        filePath: isVirtualPath(row.file_path) ? undefined : row.file_path,
        sourceHash: row.file_hash.length > 0 ? row.file_hash : undefined,
        signature: row.signature ?? undefined,
        metadata: asMetadata(row.metadata_json)
      }));

      const refRows = await db.all<{
        kind: string;
        line: number;
        from_qualified: string;
        to_qualified: string;
        ref_file_path: string;
        metadata_json: string | null;
      }[]>(
        `SELECT
           r.kind,
           r.line,
           src.qualified AS from_qualified,
           dst.qualified AS to_qualified,
           f.path AS ref_file_path,
           r.metadata_json
         FROM refs r
         JOIN symbols src ON src.id = r.context_id
         JOIN symbols dst ON dst.id = r.symbol_id
         JOIN files f ON f.id = r.file_id`
      );

      const edges: GraphEdge[] = refRows.map((row) => ({
        type: row.kind as GraphEdge["type"],
        from: row.from_qualified,
        to: row.to_qualified,
        filePath: isVirtualPath(row.ref_file_path) ? undefined : row.ref_file_path,
        line: row.line > 0 ? row.line : undefined,
        metadata: asMetadata(row.metadata_json)
      }));

      return {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodes: dedupeNodes(nodes),
        edges: dedupeEdges(edges)
      };
    });
  }

  private findMatchingRoots(
    nodes: GraphNode[],
    symbol: string,
    matching: SymbolMatchingMode = "prefer_qualified"
  ): GraphNode[] {
    const normalized = symbol.trim();
    if (normalized.length === 0) {
      return [];
    }

    const exactQualified = nodes.filter((node) => node.id === normalized);
    if (exactQualified.length > 0 || matching === "qualified_only") {
      return exactQualified.sort((left, right) => left.id.localeCompare(right.id));
    }

    const byName = nodes.filter((node) => node.name === normalized);
    if (byName.length === 0) {
      return [];
    }

    const symbolMatches = byName.filter((node) => node.kind === "symbol");
    if (symbolMatches.length > 0) {
      return symbolMatches.sort((left, right) => left.id.localeCompare(right.id));
    }

    if (matching === "name") {
      return byName.sort((left, right) => left.id.localeCompare(right.id));
    }

    return [];
  }

  private expandReferenceTargetIds(
    graph: GraphDocument,
    initialTargetIds: Set<string>
  ): Set<string> {
    const expanded = new Set(initialTargetIds);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const symbolNameCounts = buildSymbolNameCounts(graph.nodes);
    const anchoredExternalIds = new Set(
      [...initialTargetIds].filter((targetId) =>
        isExternalAliasOfUniqueInRepoSymbol(nodeById.get(targetId), symbolNameCounts)
      )
    );

    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of graph.edges) {
        if (edge.type !== EdgeKind.DependsOn) {
          continue;
        }

        const fromNode = nodeById.get(edge.from);
        const toNode = nodeById.get(edge.to);
        const fromIsAnchoredExternal =
          fromNode?.kind === "external" && anchoredExternalIds.has(edge.from);
        const toIsAnchoredExternal = toNode?.kind === "external" && anchoredExternalIds.has(edge.to);

        if (
          expanded.has(edge.to) &&
          (isExternalAliasOfUniqueInRepoSymbol(fromNode, symbolNameCounts) ||
            (fromNode?.kind === "external" && toIsAnchoredExternal))
        ) {
          const previousSize = expanded.size;
          expanded.add(edge.from);
          changed = changed || expanded.size !== previousSize;
        }
        if (
          expanded.has(edge.from) &&
          (isExternalAliasOfUniqueInRepoSymbol(toNode, symbolNameCounts) ||
            (toNode?.kind === "external" && fromIsAnchoredExternal))
        ) {
          const previousSize = expanded.size;
          expanded.add(edge.to);
          changed = changed || expanded.size !== previousSize;
        }
      }
    }

    return expanded;
  }

  private toReferenceItem(
    edge: GraphEdge,
    nodeById: Map<string, GraphNode>,
    flow: "inbound" | "outbound",
    aliasExpandedOnlyIds: Set<string>
  ): SymbolReferenceItem {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    const fromFilePath = fromNode?.filePath ? normalizePath(fromNode.filePath) : undefined;
    const toFilePath = toNode?.filePath ? normalizePath(toNode.filePath) : undefined;
    const edgeFilePath = edge.filePath ? normalizePath(edge.filePath) : undefined;
    let sourceFilePath: string | undefined;
    let derivedFrom: "edge" | "from" | "to" | "unknown" = "unknown";
    if (edgeFilePath) {
      sourceFilePath = edgeFilePath;
      derivedFrom = "edge";
    } else if (flow === "inbound" && fromFilePath) {
      sourceFilePath = fromFilePath;
      derivedFrom = "from";
    } else if (flow === "outbound" && toFilePath) {
      sourceFilePath = toFilePath;
      derivedFrom = "to";
    } else if (fromFilePath) {
      sourceFilePath = fromFilePath;
      derivedFrom = "from";
    } else if (toFilePath) {
      sourceFilePath = toFilePath;
      derivedFrom = "to";
    }

    let resolution: SymbolReferenceItem["resolution"] = "resolved";
    let resolutionReason: string | undefined;
    const resolutionModeRaw = asString(edge.metadata?.resolverMode);
    const resolutionMode =
      resolutionModeRaw === "strict" || resolutionModeRaw === "ranked" ? resolutionModeRaw : undefined;
    const resolutionDecision = asString(edge.metadata?.resolverDecision);
    const resolutionConfidence = asNumber(edge.metadata?.resolverConfidence);
    const resolutionConfidenceBandRaw = asString(edge.metadata?.resolverConfidenceBand);
    const resolutionConfidenceBand =
      resolutionConfidenceBandRaw === "high" ||
      resolutionConfidenceBandRaw === "medium" ||
      resolutionConfidenceBandRaw === "low"
        ? resolutionConfidenceBandRaw
        : undefined;
    const resolutionCandidateCountRaw = asNumber(edge.metadata?.resolverCandidateCount);
    const resolutionCandidateCount =
      resolutionCandidateCountRaw === undefined ? undefined : Math.max(0, Math.trunc(resolutionCandidateCountRaw));
    const resolutionCandidates = parseResolutionCandidates(edge.metadata?.resolverTopCandidates);
    if (aliasExpandedOnlyIds.has(edge.to)) {
      resolution = "alias_expanded";
      resolutionReason = "Matched via dependency alias expansion.";
    } else if (toNode?.kind === "external") {
      resolution = "unresolved";
      resolutionReason = "Target symbol is external and not directly resolved to an in-repository symbol.";
      if (resolutionDecision === "ranked_candidates_only") {
        resolutionReason = "Target remains unresolved: medium-confidence ranked candidates are available.";
      } else if (resolutionDecision === "ranked_low_confidence") {
        resolutionReason = "Target remains unresolved: ranked confidence is below the medium threshold.";
      } else if (resolutionDecision === "ranked_no_candidates") {
        resolutionReason = "Target remains unresolved: no in-repository ranked candidates were found.";
      } else if (resolutionDecision === "strict_unresolved_tie") {
        resolutionReason = "Target remains unresolved: strict mode found an unresolved candidate tie.";
      } else if (resolutionDecision === "strict_unresolved_no_candidates") {
        resolutionReason = "Target remains unresolved: strict mode found no in-repository candidates.";
      }
    } else if (resolutionDecision === "ranked_auto_resolved") {
      resolutionReason = "Resolved automatically using ranked-confidence policy.";
    } else if (resolutionDecision === "strict_resolved") {
      resolutionReason = "Resolved automatically using strict deterministic policy.";
    }

    return {
      kind: edge.type,
      line: edge.line,
      filePath: sourceFilePath,
      fromId: edge.from,
      fromName: fromNode?.name ?? edge.from,
      fromKind: fromNode?.kind ?? "unknown",
      fromFilePath,
      toId: edge.to,
      toName: toNode?.name ?? edge.to,
      toKind: toNode?.kind ?? "unknown",
      toFilePath,
      flow,
      resolution,
      resolutionReason,
      resolutionMode,
      resolutionDecision,
      resolutionConfidence,
      resolutionConfidenceBand,
      resolutionCandidateCount,
      resolutionCandidates,
      sourceLocation: {
        filePath: sourceFilePath,
        line: edge.line,
        derivedFrom
      }
    };
  }

  private buildAdjacency(
    edges: GraphEdge[],
    direction: QueryDirection,
    allowedEdgeKinds: Set<string>
  ): Map<string, NeighborLink[]> {
    const adjacency = new Map<string, NeighborLink[]>();
    const pushNeighbor = (source: string, target: string, edge: GraphEdge): void => {
      const neighbors = adjacency.get(source) ?? [];
      neighbors.push({ nodeId: target, edge });
      adjacency.set(source, neighbors);
    };

    for (const edge of edges) {
      if (!allowedEdgeKinds.has(edge.type)) {
        continue;
      }
      if (direction === "both" || direction === "outbound") {
        pushNeighbor(edge.from, edge.to, edge);
      }
      if (direction === "both" || direction === "inbound") {
        pushNeighbor(edge.to, edge.from, edge);
      }
    }
    return adjacency;
  }

  private buildTraversalView(
    graph: GraphDocument,
    query: {
      symbol: string;
      depth: number;
      direction: QueryDirection;
      includeStructural: boolean;
      traversalLimit: number;
    }
  ): TraversalView | null {
    const roots = this.findMatchingRoots(graph.nodes, query.symbol);
    const root = roots[0];
    if (!root) {
      return null;
    }

    const allowedEdgeKinds = query.includeStructural
      ? new Set<string>([...SEMANTIC_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS])
      : SEMANTIC_EDGE_KINDS;
    const adjacency = this.buildAdjacency(graph.edges, query.direction, allowedEdgeKinds);
    const visitedNodeIds = new Set<string>([root.id]);
    const traversedEdgeSet = new Set<string>();
    const queue: Array<{ id: string; hops: number }> = [{ id: root.id, hops: 0 }];
    let traversalCapped = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      if (current.hops >= query.depth) {
        continue;
      }
      for (const neighbor of adjacency.get(current.id) ?? []) {
        traversedEdgeSet.add(edgeTraversalKey(neighbor.edge));
        if (!visitedNodeIds.has(neighbor.nodeId)) {
          if (visitedNodeIds.size >= query.traversalLimit) {
            traversalCapped = true;
            break;
          }
          visitedNodeIds.add(neighbor.nodeId);
          queue.push({ id: neighbor.nodeId, hops: current.hops + 1 });
        }
      }
      if (traversalCapped) {
        break;
      }
    }

    return {
      root,
      matchedRoots: roots,
      visitedNodeIds,
      traversedEdgeSet,
      traversalCapped
    };
  }

  private async rebuildClusterIndex(): Promise<void> {
    const graph = await this.readGraph();
    const computedClusters = computeSemanticClusters(graph);
    const indexedAt = Math.trunc(Date.now() / 1000);

    await this.withDatabase(async (db) => {
      await this.ensureSchema(db);
      await db.exec("BEGIN IMMEDIATE TRANSACTION;");
      try {
        await db.exec("DELETE FROM cluster_members; DELETE FROM clusters;");
        for (let index = 0; index < computedClusters.length; index += 1) {
          const cluster = computedClusters[index];
          const clusterId = `cluster:${index + 1}`;
          await db.run(
            `INSERT INTO clusters (id, representative, size, internal_edges, density, indexed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            clusterId,
            cluster.representative,
            cluster.memberIds.length,
            cluster.internalEdges,
            cluster.density,
            indexedAt
          );
          for (const memberId of cluster.memberIds) {
            await db.run(
              `INSERT INTO cluster_members (cluster_id, symbol_qualified) VALUES (?, ?)`,
              clusterId,
              memberId
            );
          }
        }
        await db.exec("COMMIT;");
      } catch (error) {
        await db.exec("ROLLBACK;");
        throw error;
      }
    });
  }

  private async deleteChangedFileContributions(db: Database, changedFiles: string[]): Promise<void> {
    if (changedFiles.length === 0) {
      return;
    }

    const placeholders = changedFiles.map(() => "?").join(", ");
    const changedFileRows = await db.all<{ id: number }[]>(
      `SELECT id FROM files WHERE path IN (${placeholders})`,
      ...changedFiles
    );
    const changedFileIds = changedFileRows.map((row) => row.id);
    if (changedFileIds.length === 0) {
      return;
    }

    const filePlaceholders = changedFileIds.map(() => "?").join(", ");
    const removedSymbolRows = await db.all<{ id: number }[]>(
      `SELECT id FROM symbols WHERE file_id IN (${filePlaceholders})`,
      ...changedFileIds
    );
    const removedSymbolIds = removedSymbolRows.map((row) => row.id);

    if (removedSymbolIds.length > 0) {
      const symbolPlaceholders = removedSymbolIds.map(() => "?").join(", ");
      await db.run(
        `DELETE FROM refs
         WHERE symbol_id IN (${symbolPlaceholders})
            OR context_id IN (${symbolPlaceholders})`,
        ...removedSymbolIds,
        ...removedSymbolIds
      );
    }

    await db.run(`DELETE FROM refs WHERE file_id IN (${filePlaceholders})`, ...changedFileIds);
    await db.run(`DELETE FROM symbols WHERE file_id IN (${filePlaceholders})`, ...changedFileIds);
    await db.run(`DELETE FROM files WHERE id IN (${filePlaceholders})`, ...changedFileIds);
    await db.run(
      `DELETE FROM files
       WHERE id NOT IN (SELECT DISTINCT file_id FROM symbols)
         AND id NOT IN (SELECT DISTINCT file_id FROM refs)`
    );
  }

  private async upsertFileRow(
    db: Database,
    path: string,
    language: string,
    hash: string,
    indexedAt: number,
    cache: Map<string, number>
  ): Promise<number> {
    const cached = cache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    await db.run(
      `INSERT INTO files(path, language, hash, indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         language = excluded.language,
         hash = excluded.hash,
         indexed_at = excluded.indexed_at`,
      path,
      language,
      hash,
      indexedAt
    );

    const row = await db.get<{ id: number }>("SELECT id FROM files WHERE path = ?", path);
    if (!row) {
      throw new Error(`Failed to persist file row for path: ${path}`);
    }

    cache.set(path, row.id);
    return row.id;
  }

  private async getSymbolLookup(
    db: Database,
    qualified: string,
    cache: Map<string, SymbolLookup>
  ): Promise<SymbolLookup | undefined> {
    const cached = cache.get(qualified);
    if (cached) {
      return cached;
    }

    const row = await db.get<{ id: number; file_id: number }>(
      "SELECT id, file_id FROM symbols WHERE qualified = ?",
      qualified
    );

    if (!row) {
      return undefined;
    }

    const lookup: SymbolLookup = { id: row.id, fileId: row.file_id };
    cache.set(qualified, lookup);
    return lookup;
  }

  private async ensureSchema(db: Database): Promise<void> {
    await db.exec(
      `PRAGMA foreign_keys = ON;
       CREATE TABLE IF NOT EXISTS files (
         id INTEGER PRIMARY KEY,
         path TEXT NOT NULL UNIQUE,
         language TEXT NOT NULL,
         hash TEXT NOT NULL,
         indexed_at INTEGER NOT NULL
       );

       CREATE TABLE IF NOT EXISTS symbols (
         id INTEGER PRIMARY KEY,
         file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
         name TEXT NOT NULL,
         kind TEXT NOT NULL,
         qualified TEXT NOT NULL UNIQUE,
         parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
         start_line INTEGER NOT NULL,
         start_col INTEGER NOT NULL,
         end_line INTEGER NOT NULL,
         end_col INTEGER NOT NULL,
         signature TEXT,
         docstring TEXT,
         metadata_json TEXT
       );

       CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
       CREATE INDEX IF NOT EXISTS idx_symbols_qualified ON symbols(qualified);
       CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
       CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);

        CREATE TABLE IF NOT EXISTS refs (
          id INTEGER PRIMARY KEY,
          symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
          file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          context_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
          line INTEGER NOT NULL,
          col INTEGER NOT NULL,
          metadata_json TEXT
        );

       CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_id);
       CREATE INDEX IF NOT EXISTS idx_refs_context ON refs(context_id);
       CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_unique
          ON refs(symbol_id, file_id, kind, context_id, line, col);

        CREATE TABLE IF NOT EXISTS clusters (
          id TEXT PRIMARY KEY,
          representative TEXT NOT NULL,
          size INTEGER NOT NULL,
          internal_edges INTEGER NOT NULL,
          density REAL NOT NULL,
          indexed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cluster_members (
          cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
          symbol_qualified TEXT NOT NULL REFERENCES symbols(qualified) ON DELETE CASCADE,
          PRIMARY KEY(cluster_id, symbol_qualified)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_cluster_members_symbol
          ON cluster_members(symbol_qualified);
        CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster
          ON cluster_members(cluster_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
          name, qualified, docstring,
         content='symbols', content_rowid='id'
       );

       CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
         INSERT INTO symbols_fts(rowid, name, qualified, docstring)
         VALUES (new.id, new.name, new.qualified, new.docstring);
       END;

       CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
         INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified, docstring)
         VALUES ('delete', old.id, old.name, old.qualified, old.docstring);
       END;

       CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
         INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified, docstring)
         VALUES ('delete', old.id, old.name, old.qualified, old.docstring);
         INSERT INTO symbols_fts(rowid, name, qualified, docstring)
         VALUES (new.id, new.name, new.qualified, new.docstring);
        END;`
    );

    const refsColumns = await db.all<{ name: string }[]>("PRAGMA table_info(refs)");
    if (!refsColumns.some((column) => column.name === "metadata_json")) {
      await db.exec("ALTER TABLE refs ADD COLUMN metadata_json TEXT");
    }
  }

  private async withDatabase<T>(action: (db: Database) => Promise<T>): Promise<T> {
    const storage = resolveStoragePaths(this.repoPath, this.storeDir);
    const db = await open({
      filename: storage.dbPath,
      driver: sqlite3.Database
    });

    try {
      return await action(db);
    } finally {
      await db.close();
    }
  }
}
