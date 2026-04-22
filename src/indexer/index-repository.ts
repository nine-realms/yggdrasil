import { adaptFile } from "../adapters/index.js";
import { IndexCommandOptions, resolveRepoPath, resolveStoragePaths } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import {
  buildParseAdapterCacheKey,
  getIncrementalParseAdapterCache,
  ParseAdapterCache
} from "./parse-adapter-cache.js";
import { buildGraphDocument } from "../relationship/relationship-engine.js";
import { normalizeChangedFiles, scanRepository } from "../scanner/repository-scanner.js";
import { AdapterOutput, ScannedFile } from "../types/graph.js";

export interface IndexResult {
  repoPath: string;
  storeDir: string;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
}

export interface IndexRepositoryRuntimeOptions {
  adaptFileFn?: (file: ScannedFile) => AdapterOutput;
  parseAdapterCache?: ParseAdapterCache;
}

export async function indexRepository(
  options: IndexCommandOptions,
  runtimeOptions: IndexRepositoryRuntimeOptions = {}
): Promise<IndexResult> {
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

  const adaptFileFn = runtimeOptions.adaptFileFn ?? adaptFile;
  const parseAdapterCache = runtimeOptions.parseAdapterCache ?? getIncrementalParseAdapterCache();
  const adapterOutputs = scannedFiles.map((file) => {
    const cacheKey = buildParseAdapterCacheKey(file);
    if (isIncrementalUpdate) {
      const cached = parseAdapterCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const adapted = adaptFileFn(file);
    parseAdapterCache.set(cacheKey, adapted);
    return adapted;
  });
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
