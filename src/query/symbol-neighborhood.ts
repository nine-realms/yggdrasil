import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import {
  SymbolNeighborhoodQueryOptions,
  SymbolNeighborhoodResult
} from "./query-contracts.js";

export interface SymbolNeighborhoodQuery extends QueryCommandOptions, SymbolNeighborhoodQueryOptions {}

export async function querySymbolNeighborhood(
  query: SymbolNeighborhoodQuery
): Promise<SymbolNeighborhoodResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.getSymbolNeighborhood(query);
}
