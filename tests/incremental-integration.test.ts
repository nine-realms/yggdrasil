import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFile } from "../src/adapters/index.js";
import { createGraphStore } from "../src/graph/graph-store.js";
import { BoundedParseAdapterCache } from "../src/indexer/parse-adapter-cache.js";
import { indexRepository } from "../src/indexer/index-repository.js";
import { createWatchDrivenIncrementalIntegration, IncrementalUpdateCoordinator } from "../src/runtime/incremental-integration.js";
import { SourceEventType, WatchSource } from "../src/runtime/watch-service.js";
import { CodeLanguage, NodeKind } from "../src/types/graph.js";

class FakeWatchSource implements WatchSource {
  private handler: ((event: { absolutePath: string; eventType: SourceEventType }) => Promise<void> | void) | null = null;

  public async start(
    onEvent: (event: { absolutePath: string; eventType: SourceEventType }) => Promise<void> | void
  ): Promise<void> {
    this.handler = onEvent;
  }

  public async stop(): Promise<void> {
    this.handler = null;
  }

  public async emit(absolutePath: string, eventType: SourceEventType): Promise<void> {
    if (!this.handler) {
      return;
    }

    await this.handler({ absolutePath, eventType });
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(
  condition: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for runtime condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForNextSuccessfulUpdate(
  coordinator: IncrementalUpdateCoordinator,
  previousSuccessAtMs: number | null
): Promise<void> {
  await waitFor(() => {
    const snapshot = coordinator.getStatusSnapshot();
    if (snapshot.pending.state !== "idle") {
      return false;
    }

    if (snapshot.lastSuccessfulUpdateAtMs === null) {
      return false;
    }

    return previousSuccessAtMs === null || snapshot.lastSuccessfulUpdateAtMs > previousSuccessAtMs;
  });
}

describe("incremental integration", () => {
  it("wires watch batches into incremental graph persistence", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-integration-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export function oldFn() {}\n", "utf8");
    await writeFile(path.join(repoDir, "src", "b.ts"), "export function stay() {}\n", "utf8");

    await indexRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript]
    });

    const source = new FakeWatchSource();
    const integration = createWatchDrivenIncrementalIntegration({
      indexOptions: {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      watchDebounceMs: 0,
      watchSource: source
    });

    await integration.watchService.start();
    const previousSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await writeFile(path.join(repoDir, "src", "a.ts"), "export function newFn() {}\n", "utf8");
    await source.emit(path.join(repoDir, "src", "a.ts"), "change");
    await waitForNextSuccessfulUpdate(integration.coordinator, previousSuccessfulUpdateAtMs);
    await integration.watchService.stop();

    const graph = await createGraphStore(repoDir).readGraph();
    const symbolNames = graph.nodes.filter((node) => node.kind === NodeKind.Symbol).map((node) => node.name);

    expect(symbolNames).toContain("newFn");
    expect(symbolNames).toContain("stay");
    expect(symbolNames).not.toContain("oldFn");
    expect(integration.coordinator.getState().lifecycle).toBe("running");
  });

  it("removes deleted file contributions during watch-driven updates", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-integration-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const deletedFile = path.join(repoDir, "src", "deleted.ts");
    await writeFile(deletedFile, "export function removed() {}\n", "utf8");
    await writeFile(path.join(repoDir, "src", "keep.ts"), "export function keep() {}\n", "utf8");

    await indexRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript]
    });

    const source = new FakeWatchSource();
    const integration = createWatchDrivenIncrementalIntegration({
      indexOptions: {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      watchDebounceMs: 0,
      watchSource: source
    });

    await integration.watchService.start();
    const previousSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await unlink(deletedFile);
    await source.emit(deletedFile, "rename");
    await waitForNextSuccessfulUpdate(integration.coordinator, previousSuccessfulUpdateAtMs);
    await integration.watchService.stop();

    const graph = await createGraphStore(repoDir).readGraph();
    const symbolNames = graph.nodes.filter((node) => node.kind === NodeKind.Symbol).map((node) => node.name);
    expect(symbolNames).toContain("keep");
    expect(symbolNames).not.toContain("removed");
  });

  it("reuses parse cache across watch-driven incremental batches", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-integration-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const trackedFile = path.join(repoDir, "src", "stable.ts");
    await writeFile(trackedFile, "export function stable() {}\n", "utf8");

    const source = new FakeWatchSource();
    const parseAdapterCache = new BoundedParseAdapterCache(8);
    let adaptCalls = 0;
    const integration = createWatchDrivenIncrementalIntegration({
      indexOptions: {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      parseAdapterCache,
      adaptFileFn: (file) => {
        adaptCalls += 1;
        return adaptFile(file);
      },
      watchDebounceMs: 0,
      watchSource: source
    });

    await integration.watchService.start();
    const firstSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await source.emit(trackedFile, "change");
    await waitForNextSuccessfulUpdate(integration.coordinator, firstSuccessfulUpdateAtMs);
    const secondSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await source.emit(trackedFile, "change");
    await waitForNextSuccessfulUpdate(integration.coordinator, secondSuccessfulUpdateAtMs);
    await integration.watchService.stop();

    expect(adaptCalls).toBe(1);
  });

  it("indexes newly added files during watch-driven updates", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-integration-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "existing.ts"), "export function existing() {}\n", "utf8");

    await indexRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript]
    });

    const source = new FakeWatchSource();
    const integration = createWatchDrivenIncrementalIntegration({
      indexOptions: {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      watchDebounceMs: 0,
      watchSource: source
    });

    const addedFile = path.join(repoDir, "src", "added.ts");
    await writeFile(addedFile, "export function added() {}\n", "utf8");

    await integration.watchService.start();
    const previousSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await source.emit(addedFile, "rename");
    await waitForNextSuccessfulUpdate(integration.coordinator, previousSuccessfulUpdateAtMs);
    await integration.watchService.stop();

    const graph = await createGraphStore(repoDir).readGraph();
    const symbolNames = graph.nodes.filter((node) => node.kind === NodeKind.Symbol).map((node) => node.name);
    expect(symbolNames).toContain("existing");
    expect(symbolNames).toContain("added");
  });

  it("invalidates parse cache when watched file content changes", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-integration-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const trackedFile = path.join(repoDir, "src", "tracked.ts");
    await writeFile(trackedFile, "export function tracked() { return 1; }\n", "utf8");

    const source = new FakeWatchSource();
    const parseAdapterCache = new BoundedParseAdapterCache(8);
    let adaptCalls = 0;
    const integration = createWatchDrivenIncrementalIntegration({
      indexOptions: {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      parseAdapterCache,
      adaptFileFn: (file) => {
        adaptCalls += 1;
        return adaptFile(file);
      },
      watchDebounceMs: 0,
      watchSource: source
    });

    await integration.watchService.start();
    const firstSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await source.emit(trackedFile, "change");
    await waitForNextSuccessfulUpdate(integration.coordinator, firstSuccessfulUpdateAtMs);

    const secondSuccessfulUpdateAtMs = integration.coordinator.getStatusSnapshot().lastSuccessfulUpdateAtMs;
    await writeFile(trackedFile, "export function tracked() { return 2; }\n", "utf8");
    await source.emit(trackedFile, "change");
    await waitForNextSuccessfulUpdate(integration.coordinator, secondSuccessfulUpdateAtMs);
    await integration.watchService.stop();

    expect(adaptCalls).toBe(2);
  });

  it("merges queued runtime changes and flushes after debounce window", async () => {
    let nowMs = 1_000;
    const observedChangedFiles: string[][] = [];
    const coordinator = new IncrementalUpdateCoordinator({
      indexOptions: {
        repoPath: process.cwd(),
        languages: [CodeLanguage.TypeScript]
      },
      runtimeDebounceMs: 100,
      nowMs: () => nowMs,
      indexRepositoryFn: async (options) => {
        observedChangedFiles.push([...(options.changedFiles ?? [])]);
        return {
          repoPath: options.repoPath,
          storeDir: "memory",
          fileCount: options.changedFiles?.length ?? 0,
          nodeCount: 0,
          edgeCount: 0
        };
      }
    });

    const first = await coordinator.applyWatchBatch({
      changedFiles: ["src/a.ts"],
      deletedFiles: [],
      events: [{ filePath: "src/a.ts", type: "change" }],
      detectedAtMs: 1_000
    });
    expect(first).toBeNull();
    expect(observedChangedFiles).toEqual([]);

    nowMs = 1_050;
    const second = await coordinator.applyWatchBatch({
      changedFiles: ["src/b.ts"],
      deletedFiles: [],
      events: [{ filePath: "src/b.ts", type: "change" }],
      detectedAtMs: 1_050
    });
    expect(second).toBeNull();
    expect(observedChangedFiles).toEqual([]);

    nowMs = 1_200;
    const third = await coordinator.applyWatchBatch({
      changedFiles: ["src/b.ts"],
      deletedFiles: [],
      events: [{ filePath: "src/b.ts", type: "change" }],
      detectedAtMs: 1_050
    });
    expect(third).not.toBeNull();
    expect(observedChangedFiles).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("surfaces incremental failures and recovers on the next watch batch", async () => {
    let invocation = 0;
    const coordinator = new IncrementalUpdateCoordinator({
      indexOptions: {
        repoPath: process.cwd(),
        languages: [CodeLanguage.TypeScript]
      },
      runtimeDebounceMs: 0,
      indexRepositoryFn: async (options) => {
        invocation += 1;
        if (invocation === 1) {
          throw new Error("indexing failed");
        }

        return {
          repoPath: options.repoPath,
          storeDir: "memory",
          fileCount: options.changedFiles?.length ?? 0,
          nodeCount: 0,
          edgeCount: 0
        };
      }
    });

    await expect(
      coordinator.applyWatchBatch({
        changedFiles: ["src/retry.ts"],
        deletedFiles: [],
        events: [{ filePath: "src/retry.ts", type: "change" }],
        detectedAtMs: 100
      })
    ).rejects.toThrow("indexing failed");
    expect(coordinator.getState().lifecycle).toBe("failed");
    expect(coordinator.getState().lastError).toBe("indexing failed");

    const recovered = await coordinator.applyWatchBatch({
      changedFiles: ["src/retry.ts"],
      deletedFiles: [],
      events: [{ filePath: "src/retry.ts", type: "change" }],
      detectedAtMs: 110
    });

    expect(recovered).not.toBeNull();
    expect(coordinator.getState().lifecycle).toBe("running");
    expect(coordinator.getState().lastError).toBeNull();
    expect(invocation).toBe(2);
  });

  it("publishes coherent runtime freshness and queue status snapshots", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-integration-"));
    tempDirs.push(repoDir);

    let nowMs = 1_000;
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const coordinator = new IncrementalUpdateCoordinator({
      indexOptions: {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      runtimeDebounceMs: 100,
      nowMs: () => nowMs,
      indexRepositoryFn: async (options) => ({
        repoPath: options.repoPath,
        storeDir: "memory",
        fileCount: options.changedFiles?.length ?? 0,
        nodeCount: 0,
        edgeCount: 0
      })
    });

    const initialBatch = {
      changedFiles: ["src/a.ts"],
      deletedFiles: [],
      events: [{ filePath: "src/a.ts", type: "change" as const }],
      detectedAtMs: nowMs
    };

    const queuedResult = await coordinator.applyWatchBatch(initialBatch);
    expect(queuedResult).toBeNull();

    const debouncingStatus = coordinator.getStatusSnapshot(1_050);
    expect(debouncingStatus.pending.state).toBe("debouncing");
    expect(debouncingStatus.pending.queueSize).toBe(1);
    expect(debouncingStatus.lastQueuedChangeAtMs).toBe(1_000);
    expect(debouncingStatus.lastSuccessfulUpdateAtMs).toBeNull();

    nowMs = 1_200;
    const completedResult = await coordinator.applyWatchBatch({
      ...initialBatch,
      detectedAtMs: initialBatch.detectedAtMs
    });

    expect(completedResult).not.toBeNull();
    const completedStatus = coordinator.getStatusSnapshot(nowMs);
    expect(completedStatus.pending.state).toBe("idle");
    expect(completedStatus.pending.queueSize).toBe(0);
    expect(completedStatus.lastAttemptedUpdateAtMs).toBe(1_200);
    expect(completedStatus.lastSuccessfulUpdateAtMs).toBe(1_200);
    expect(completedStatus.freshnessStatus).toBe("fresh");
  });
});
