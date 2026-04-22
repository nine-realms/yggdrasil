import { adaptFile } from "../adapters/index.js";
import { IndexCommandOptions, resolveRepoPath, resolveStoragePaths } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { buildGraphDocument } from "../relationship/relationship-engine.js";
import { normalizeChangedFiles, scanRepository } from "../scanner/repository-scanner.js";

export interface IndexResult {
  repoPath: string;
  storeDir: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
}

export async function indexRepository(options: IndexCommandOptions): Promise<IndexResult> {
  const repoPath = resolveRepoPath(options.repoPath);
  const isIncrementalUpdate = options.changedFiles !== undefined;
  const changedFiles = isIncrementalUpdate
    ? normalizeChangedFiles(repoPath, options.changedFiles ?? [])
    : undefined;

  const scannedFiles = await scanRepository({
    repoPath,
    languages: options.languages,
    changedFiles
  });

  const adapterOutputs = scannedFiles.map((file) => adaptFile(file));
  const graph = buildGraphDocument(repoPath, scannedFiles, adapterOutputs, options.resolverPolicy);

  const storagePaths = resolveStoragePaths(repoPath, options.storeDir);
  const store = createGraphStore(repoPath, storagePaths.storeDir);
  await store.upsertGraph(graph, changedFiles);

  return {
    repoPath,
    storeDir: storagePaths.storeDir,
    fileCount: scannedFiles.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length
  };
}
