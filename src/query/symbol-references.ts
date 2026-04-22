import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { SymbolReferencesQueryOptions, SymbolReferencesResult } from "./query-contracts.js";

export interface SymbolReferencesQuery extends QueryCommandOptions, SymbolReferencesQueryOptions {}

export async function querySymbolReferences(query: SymbolReferencesQuery): Promise<SymbolReferencesResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.findSymbolReferences(query);
}
