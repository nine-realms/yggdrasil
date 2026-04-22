import { IndexCommandOptions } from "../config.js";
import { indexRepository, IndexResult } from "../indexer/index-repository.js";

export async function updateFromDiff(options: IndexCommandOptions): Promise<IndexResult> {
  if (!options.changedFiles || options.changedFiles.length === 0) {
    throw new Error("Incremental update requires --changed with one or more file paths.");
  }

  return indexRepository(options);
}
