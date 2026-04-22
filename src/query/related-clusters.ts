import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { RelatedClustersQueryOptions, RelatedClustersResult } from "./query-contracts.js";

export interface RelatedClustersQuery extends QueryCommandOptions, RelatedClustersQueryOptions {}

export async function queryRelatedClusters(query: RelatedClustersQuery): Promise<RelatedClustersResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.getRelatedClusters(query);
}
