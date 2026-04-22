import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { HybridSearchQueryOptions, HybridSearchResult } from "./query-contracts.js";

export interface HybridSearchQuery extends QueryCommandOptions, HybridSearchQueryOptions {}

export async function queryHybridSearch(query: HybridSearchQuery): Promise<HybridSearchResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.getHybridSearch(query);
}
