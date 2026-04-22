import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryWatchService, SourceEventType, WatchBatchEvent, WatchSource } from "../src/runtime/watch-service.js";

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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("watch-service", () => {
  async function createTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(process.cwd(), prefix));
    tempDirs.push(directory);
    return directory;
  }

  it("normalizes changed files and excludes outside or ignored paths", async () => {
    const repoDir = await createTempDir(".yggdrasil-watch-");
    const outsideDir = await createTempDir(".yggdrasil-watch-outside-");

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await mkdir(path.join(repoDir, "worktrees", "feature", "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(repoDir, "worktrees", "feature", "src", "skip.ts"), "export const skip = 1;\n", "utf8");
    await writeFile(path.join(outsideDir, "external.ts"), "export const out = 1;\n", "utf8");

    const source = new FakeWatchSource();
    const batches: WatchBatchEvent[] = [];
    const watchService = createRepositoryWatchService({
      repoPath: repoDir,
      debounceMs: 20,
      watchSource: source,
      onBatch: (batch) => {
        batches.push(batch);
      }
    });

    await watchService.start();
    await source.emit(path.join(repoDir, "src", "a.ts"), "change");
    await source.emit(path.join(repoDir, "..", "outside.ts"), "rename");
    await source.emit(path.join(repoDir, "worktrees", "feature", "src", "skip.ts"), "change");
    await source.emit(path.join(outsideDir, "external.ts"), "change");

    await vi.advanceTimersByTimeAsync(20);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.changedFiles).toEqual(["src/a.ts"]);

    await watchService.stop();
  });

  it("debounces and batches multiple changes into one sorted changed-file set", async () => {
    const repoDir = await createTempDir(".yggdrasil-watch-");

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(repoDir, "src", "b.ts"), "export const b = 1;\n", "utf8");

    const source = new FakeWatchSource();
    const batches: WatchBatchEvent[] = [];
    const watchService = createRepositoryWatchService({
      repoPath: repoDir,
      debounceMs: 50,
      watchSource: source,
      onBatch: (batch) => {
        batches.push(batch);
      }
    });

    await watchService.start();
    await source.emit(path.join(repoDir, "src", "b.ts"), "change");
    await vi.advanceTimersByTimeAsync(30);
    await source.emit(path.join(repoDir, "src", "a.ts"), "change");
    await source.emit(path.join(repoDir, "src", "b.ts"), "change");

    await vi.advanceTimersByTimeAsync(49);
    expect(batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);

    await watchService.stop();
  });

  it("records deleted files in changed-file batches", async () => {
    const repoDir = await createTempDir(".yggdrasil-watch-");

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const deletedFile = path.join(repoDir, "src", "deleted.ts");
    await writeFile(deletedFile, "export const deleted = true;\n", "utf8");

    const source = new FakeWatchSource();
    const batches: WatchBatchEvent[] = [];
    const watchService = createRepositoryWatchService({
      repoPath: repoDir,
      debounceMs: 0,
      watchSource: source,
      onBatch: (batch) => {
        batches.push(batch);
      }
    });

    await watchService.start();
    await unlink(deletedFile);
    await source.emit(deletedFile, "rename");
    await vi.runAllTimersAsync();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.changedFiles).toEqual(["src/deleted.ts"]);
    expect(batches[0]?.deletedFiles).toEqual(["src/deleted.ts"]);
    expect(batches[0]?.events).toEqual([{ filePath: "src/deleted.ts", type: "delete" }]);

    await watchService.stop();
  });

  it("records added files in changed-file batches", async () => {
    const repoDir = await createTempDir(".yggdrasil-watch-");

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const addedFile = path.join(repoDir, "src", "added.ts");
    await writeFile(addedFile, "export const added = true;\n", "utf8");

    const source = new FakeWatchSource();
    const batches: WatchBatchEvent[] = [];
    const watchService = createRepositoryWatchService({
      repoPath: repoDir,
      debounceMs: 0,
      watchSource: source,
      onBatch: (batch) => {
        batches.push(batch);
      }
    });

    await watchService.start();
    await source.emit(addedFile, "rename");
    await vi.runAllTimersAsync();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.changedFiles).toEqual(["src/added.ts"]);
    expect(batches[0]?.deletedFiles).toEqual([]);
    expect(batches[0]?.events).toEqual([{ filePath: "src/added.ts", type: "add" }]);

    await watchService.stop();
  });

  it("reports onBatch failures through onError", async () => {
    const repoDir = await createTempDir(".yggdrasil-watch-");

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    const trackedFile = path.join(repoDir, "src", "tracked.ts");
    await writeFile(trackedFile, "export const tracked = true;\n", "utf8");

    const source = new FakeWatchSource();
    const expectedError = new Error("flush failed");
    const onError = vi.fn();
    const watchService = createRepositoryWatchService({
      repoPath: repoDir,
      debounceMs: 0,
      watchSource: source,
      onBatch: () => {
        throw expectedError;
      },
      onError
    });

    await watchService.start();
    await source.emit(trackedFile, "change");
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expectedError);
    await watchService.stop();
  });
});
