import { IndexCommandOptions } from "../config.js";
import { IndexRepositoryRuntimeOptions, IndexResult, indexRepository } from "../indexer/index-repository.js";
import { getIncrementalParseAdapterCache } from "../indexer/parse-adapter-cache.js";
import { normalizeChangedFiles } from "../scanner/repository-scanner.js";
import {
  ActiveRuntimeState,
  beginIncrementalUpdate,
  completeIncrementalUpdate,
  createActiveRuntimeState,
  enqueueRuntimeChanges,
  RuntimeStatusSnapshot,
  runtimeStatusSnapshotAt,
  scheduleDebouncedIncrementalUpdate,
  shouldRunIncrementalUpdate,
  transitionLifecycle
} from "./active-runtime-contract.js";
import {
  createRepositoryWatchService,
  RepositoryWatchService,
  WatchBatchEvent,
  WatchServiceOptions,
  WatchSource
} from "./watch-service.js";

type IncrementalIndexOptions = Omit<IndexCommandOptions, "changedFiles">;

export interface IncrementalUpdateCoordinatorOptions {
  indexOptions: IncrementalIndexOptions;
  runtimeDebounceMs?: number;
  nowMs?: () => number;
  indexRepositoryFn?: (
    options: IndexCommandOptions,
    runtimeOptions?: IndexRepositoryRuntimeOptions
  ) => Promise<IndexResult>;
  parseAdapterCache?: IndexRepositoryRuntimeOptions["parseAdapterCache"];
  adaptFileFn?: IndexRepositoryRuntimeOptions["adaptFileFn"];
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeBatchChangedFiles(repoPath: string, batch: WatchBatchEvent): string[] {
  const mergedCandidates = [
    ...batch.changedFiles,
    ...batch.deletedFiles,
    ...batch.events.map((event) => event.filePath)
  ];

  return normalizeChangedFiles(repoPath, mergedCandidates);
}

export class IncrementalUpdateCoordinator {
  private readonly indexOptions: IncrementalIndexOptions;
  private readonly runtimeDebounceMs: number;
  private readonly nowMs: () => number;
  private readonly indexRepositoryFn: (
    options: IndexCommandOptions,
    runtimeOptions?: IndexRepositoryRuntimeOptions
  ) => Promise<IndexResult>;
  private readonly runtimeIndexOptions: IndexRepositoryRuntimeOptions;
  private state: ActiveRuntimeState;
  private updateQueue: Promise<void> = Promise.resolve();

  public constructor(options: IncrementalUpdateCoordinatorOptions) {
    this.indexOptions = options.indexOptions;
    this.runtimeDebounceMs = Math.max(0, Math.trunc(options.runtimeDebounceMs ?? 0));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.indexRepositoryFn = options.indexRepositoryFn ?? indexRepository;
    this.runtimeIndexOptions = {
      parseAdapterCache: options.parseAdapterCache ?? getIncrementalParseAdapterCache(),
      adaptFileFn: options.adaptFileFn
    };
    this.state = createActiveRuntimeState({ lifecycle: "running" });
  }

  public getState(): ActiveRuntimeState {
    return this.state;
  }

  public getStatusSnapshot(atMs: number = this.nowMs()): RuntimeStatusSnapshot {
    return runtimeStatusSnapshotAt(this.state, atMs);
  }

  public async applyWatchBatch(batch: WatchBatchEvent): Promise<IndexResult | null> {
    const queued = this.updateQueue.then(() => this.processWatchBatch(batch));
    this.updateQueue = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private ensureLifecycleReady(atMs: number): void {
    if (this.state.lifecycle === "failed") {
      this.state = transitionLifecycle(this.state, "starting", atMs);
      this.state = transitionLifecycle(this.state, "running", atMs);
      return;
    }

    if (this.state.lifecycle === "stopped") {
      this.state = transitionLifecycle(this.state, "starting", atMs);
      this.state = transitionLifecycle(this.state, "running", atMs);
    }
  }

  private async processWatchBatch(batch: WatchBatchEvent): Promise<IndexResult | null> {
    this.ensureLifecycleReady(batch.detectedAtMs);
    const changedFiles = normalizeBatchChangedFiles(this.indexOptions.repoPath, batch);
    if (changedFiles.length === 0) {
      return null;
    }

    this.state = enqueueRuntimeChanges(this.state, changedFiles, batch.detectedAtMs);
    this.state = scheduleDebouncedIncrementalUpdate(this.state, {
      nowMs: batch.detectedAtMs,
      debounceMs: this.runtimeDebounceMs
    });

    let latestResult: IndexResult | null = null;
    while (shouldRunIncrementalUpdate(this.state, this.nowMs())) {
      const startAttempt = beginIncrementalUpdate(this.state, this.nowMs());
      if (!startAttempt) {
        break;
      }

      this.state = startAttempt.state;
      try {
        latestResult = await this.indexRepositoryFn(
          {
            ...this.indexOptions,
            changedFiles: startAttempt.changedFiles
          },
          this.runtimeIndexOptions
        );
        this.state = completeIncrementalUpdate(this.state, {
          completedAtMs: this.nowMs(),
          success: true
        });
      } catch (error) {
        const failedAtMs = this.nowMs();
        this.state = completeIncrementalUpdate(this.state, {
          completedAtMs: failedAtMs,
          success: false,
          errorMessage: asErrorMessage(error)
        });
        this.state = enqueueRuntimeChanges(this.state, startAttempt.changedFiles, failedAtMs);
        throw error;
      }
    }

    return latestResult;
  }
}

export interface WatchDrivenIncrementalIntegrationOptions
  extends Omit<IncrementalUpdateCoordinatorOptions, "indexOptions"> {
  indexOptions: IncrementalIndexOptions;
  watchDebounceMs: number;
  watchSource?: WatchSource;
  onError?: WatchServiceOptions["onError"];
}

export interface WatchDrivenIncrementalIntegration {
  coordinator: IncrementalUpdateCoordinator;
  watchService: RepositoryWatchService;
}

export function createWatchDrivenIncrementalIntegration(
  options: WatchDrivenIncrementalIntegrationOptions
): WatchDrivenIncrementalIntegration {
  const coordinator = new IncrementalUpdateCoordinator({
    indexOptions: options.indexOptions,
    runtimeDebounceMs: options.runtimeDebounceMs,
    nowMs: options.nowMs,
    parseAdapterCache: options.parseAdapterCache,
    adaptFileFn: options.adaptFileFn,
    indexRepositoryFn: options.indexRepositoryFn
  });

  const watchService = createRepositoryWatchService({
    repoPath: options.indexOptions.repoPath,
    debounceMs: options.watchDebounceMs,
    nowMs: options.nowMs,
    watchSource: options.watchSource,
    onError: options.onError,
    onBatch: async (batch) => {
      await coordinator.applyWatchBatch(batch);
    }
  });

  return {
    coordinator,
    watchService
  };
}
