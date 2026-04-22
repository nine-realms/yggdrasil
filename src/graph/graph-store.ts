import { GraphDocument } from "../types/graph.js";
import {
  FileReferencesQueryOptions,
  FileReferencesResult,
  HybridSearchQueryOptions,
  HybridSearchResult,
  ImpactFromDiffQueryOptions,
  ImpactFromDiffResult,
  RelatedClustersQueryOptions,
  RelatedClustersResult,
  ProcessFlowQueryOptions,
  ProcessFlowResult,
  SymbolNeighborhoodQueryOptions,
  SymbolNeighborhoodResult,
  SymbolReferencesQueryOptions,
  SymbolReferencesResult
} from "../query/query-contracts.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";

export interface GraphStore {
  upsertGraph(graph: GraphDocument, changedFiles?: string[]): Promise<void>;
  getSymbolNeighborhood(query: SymbolNeighborhoodQueryOptions): Promise<SymbolNeighborhoodResult>;
  findSymbolReferences(query: SymbolReferencesQueryOptions): Promise<SymbolReferencesResult>;
  getReferencesForFile(query: FileReferencesQueryOptions): Promise<FileReferencesResult>;
  getHybridSearch(query: HybridSearchQueryOptions): Promise<HybridSearchResult>;
  getImpactFromDiff(query: ImpactFromDiffQueryOptions): Promise<ImpactFromDiffResult>;
  getRelatedClusters(query: RelatedClustersQueryOptions): Promise<RelatedClustersResult>;
  getProcessFlow(query: ProcessFlowQueryOptions): Promise<ProcessFlowResult>;
  readGraph(): Promise<GraphDocument>;
}

export function createGraphStore(repoPath: string, storeDir?: string): GraphStore {
  return new SqliteGraphStore(repoPath, storeDir);
}
