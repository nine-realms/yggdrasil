import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { ImpactFromDiffQueryOptions, ImpactFromDiffResult } from "./query-contracts.js";

export interface ImpactFromDiffQuery extends QueryCommandOptions, ImpactFromDiffQueryOptions {}

export async function queryImpactFromDiff(query: ImpactFromDiffQuery): Promise<ImpactFromDiffResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.getImpactFromDiff(query);
}
