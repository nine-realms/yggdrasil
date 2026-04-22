import { GraphEdge, GraphNode } from "../types/graph.js";

export type QueryDirection = "outbound" | "inbound" | "both";
export type QueryOutputMode = "full" | "files_only";
export type SymbolMatchingMode = "prefer_qualified" | "qualified_only" | "name";
export type ReferenceFlow = "inbound" | "outbound";
export type ReferenceResolution = "resolved" | "unresolved" | "alias_expanded";
export type ResolverConfidenceBand = "high" | "medium" | "low";

export interface SymbolNeighborhoodQueryOptions {
  symbol: string;
  depth: number;
  limit: number;
  offset?: number;
  edgeLimit?: number;
  direction?: QueryDirection;
  includeStructural?: boolean;
}

export interface SymbolNeighborhoodResult {
  query: Required<SymbolNeighborhoodQueryOptions>;
  summary: {
    matchedRoots: number;
    selectedRoot: string | null;
    totalNodes: number;
    returnedNodes: number;
    hasMoreNodes: boolean;
    totalEdges: number;
    returnedEdges: number;
    hasMoreEdges: boolean;
    truncated: boolean;
  };
  root: GraphNode | null;
  matchedRoots: GraphNode[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SymbolReferencesQueryOptions {
  symbol: string;
  limit: number;
  offset?: number;
  includeStructural?: boolean;
  matching?: SymbolMatchingMode;
  includeExternalNameMatches?: boolean;
  includeAliasExpansion?: boolean;
  outputMode?: QueryOutputMode;
  excludeSelf?: boolean;
  testOnly?: boolean;
}

export interface ReferenceSourceLocation {
  filePath?: string;
  line?: number;
  derivedFrom: "edge" | "from" | "to" | "unknown";
}

export interface SymbolReferenceItem {
  kind: string;
  line?: number;
  filePath?: string;
  fromId: string;
  fromName: string;
  fromKind: string;
  fromFilePath?: string;
  toId: string;
  toName: string;
  toKind: string;
  toFilePath?: string;
  flow: ReferenceFlow;
  resolution: ReferenceResolution;
  resolutionReason?: string;
  resolutionMode?: "strict" | "ranked";
  resolutionDecision?: string;
  resolutionConfidence?: number;
  resolutionConfidenceBand?: ResolverConfidenceBand;
  resolutionCandidateCount?: number;
  resolutionCandidates?: Array<{
    id: string;
    name: string;
    confidence: number;
    fullyQualifiedName?: string;
  }>;
  sourceLocation: ReferenceSourceLocation;
}

export interface SymbolReferencesResult {
  query: Required<SymbolReferencesQueryOptions>;
  summary: {
    matchedRoots: number;
    totalReferences: number;
    returnedReferences: number;
    hasMore: boolean;
  };
  roots: GraphNode[];
  references: SymbolReferenceItem[];
  files: Array<{
    filePath: string;
    references: number;
  }>;
}

export interface MethodUsageQueryOptions {
  symbol: string;
  limit?: number;
  offset?: number;
  includeStructural?: boolean;
  includeExternalNameMatches?: boolean;
  includeAliasExpansion?: boolean;
  outputMode?: QueryOutputMode;
  excludeSelf?: boolean;
  testOnly?: boolean;
}

export interface MethodUsageResult {
  query: Required<MethodUsageQueryOptions> & {
    methodName: string;
  };
  strategy: {
    fallbackUsed: boolean;
    attempts: Array<{
      symbol: string;
      matching: SymbolMatchingMode;
      matchedRoots: number;
      totalReferences: number;
    }>;
  };
  summary: {
    matchedRoots: number;
    totalReferences: number;
    returnedReferences: number;
    hasMore: boolean;
    totalFiles: number;
    returnedFiles: number;
    hasMoreFiles: boolean;
  };
  roots: GraphNode[];
  references: SymbolReferenceItem[];
  files: Array<{
    filePath: string;
    references: number;
  }>;
}

export interface FileReferencesQueryOptions {
  filePath: string;
  direction?: QueryDirection;
  limit?: number;
  offset?: number;
  includeStructural?: boolean;
  includeExternalNameMatches?: boolean;
  includeAliasExpansion?: boolean;
  outputMode?: QueryOutputMode;
  excludeSelf?: boolean;
  testOnly?: boolean;
}

export interface FileReferencesResult {
  query: Required<FileReferencesQueryOptions>;
  summary: {
    totalFiles: number;
    returnedFiles: number;
    hasMoreFiles: boolean;
    totalReferences: number;
    returnedReferences: number;
    hasMoreReferences: boolean;
  };
  files: Array<{
    filePath: string;
    inbound: number;
    outbound: number;
    references: number;
  }>;
  references: SymbolReferenceItem[];
}

export interface ImpactFromDiffQueryOptions {
  changedFiles?: string[];
  symbols?: string[];
  depth?: number;
  limit?: number;
  offset?: number;
  edgeLimit?: number;
  direction?: QueryDirection;
  includeStructural?: boolean;
  includeExternalTouchpoints?: boolean;
  outputMode?: QueryOutputMode;
}

export interface ImpactExternalTouchpointItem {
  symbolId: string;
  symbol: string;
  references: number;
  inbound: number;
  outbound: number;
  files: Array<{
    filePath: string;
    references: number;
  }>;
}

export interface ImpactFromDiffResult {
  query: Required<ImpactFromDiffQueryOptions>;
  summary: {
    seedCount: number;
    totalNodes: number;
    returnedNodes: number;
    hasMoreNodes: boolean;
    totalEdges: number;
    returnedEdges: number;
    hasMoreEdges: boolean;
    totalFiles: number;
    returnedFiles: number;
    hasMoreFiles: boolean;
    totalExternalTouchpoints: number;
    returnedExternalTouchpoints: number;
    hasMoreExternalTouchpoints: boolean;
    truncated: boolean;
  };
  seeds: GraphNode[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: Array<{
    filePath: string;
    hits: number;
  }>;
  impactedFiles: Array<{
    filePath: string;
    hits: number;
  }>;
  externalTouchpoints: ImpactExternalTouchpointItem[];
}

export interface HybridSearchQueryOptions {
  query: string;
  limit?: number;
  offset?: number;
  depth?: number;
  includeStructural?: boolean;
  outputMode?: QueryOutputMode;
}

export interface HybridSearchHit {
  node: GraphNode;
  score: number;
  lexicalScore: number;
  proximityScore: number;
  semanticScore: number;
}

export interface HybridSearchResult {
  query: Required<HybridSearchQueryOptions>;
  summary: {
    totalMatches: number;
    returnedMatches: number;
    hasMoreMatches: boolean;
    totalFiles: number;
    returnedFiles: number;
    hasMoreFiles: boolean;
  };
  seeds: GraphNode[];
  hits: HybridSearchHit[];
  files: Array<{
    filePath: string;
    hits: number;
    maxScore: number;
  }>;
}

export interface RelatedClustersQueryOptions {
  symbols?: string[];
  changedFiles?: string[];
  limit?: number;
  offset?: number;
  minSize?: number;
  includeMembers?: boolean;
  memberLimit?: number;
}

export interface RelatedClusterItem {
  clusterId: string;
  representative: string;
  size: number;
  internalEdges: number;
  density: number;
  seedHits: number;
  files: Array<{
    filePath: string;
    hits: number;
  }>;
  members: GraphNode[];
}

export interface RelatedClustersResult {
  query: Required<RelatedClustersQueryOptions>;
  summary: {
    seedCount: number;
    totalClusters: number;
    returnedClusters: number;
    hasMoreClusters: boolean;
  };
  seeds: GraphNode[];
  clusters: RelatedClusterItem[];
}

export interface ProcessFlowQueryOptions {
  entrySymbols?: string[];
  limit?: number;
  offset?: number;
  edgeLimit?: number;
  includeStructural?: boolean;
}

export interface ProcessFlowResult {
  query: Required<ProcessFlowQueryOptions>;
  summary: {
    detectedEntrypoints: number;
    totalNodes: number;
    returnedNodes: number;
    hasMoreNodes: boolean;
    totalEdges: number;
    returnedEdges: number;
    hasMoreEdges: boolean;
  };
  entrypoints: GraphNode[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
