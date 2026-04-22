import { QueryCommandOptions } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { FileReferencesQueryOptions, FileReferencesResult } from "./query-contracts.js";

export interface FileReferencesQuery extends QueryCommandOptions, FileReferencesQueryOptions {}

export async function queryReferencesForFile(query: FileReferencesQuery): Promise<FileReferencesResult> {
  const store = createGraphStore(query.repoPath, query.storeDir);
  return store.getReferencesForFile(query);
}
