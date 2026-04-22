import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { ProcessFlowQueryOptions, ProcessFlowResult } from "./query-contracts.js";

export interface ProcessFlowQuery extends QueryCommandOptions, ProcessFlowQueryOptions {}

export async function queryProcessFlow(query: ProcessFlowQuery): Promise<ProcessFlowResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.getProcessFlow(query);
}
