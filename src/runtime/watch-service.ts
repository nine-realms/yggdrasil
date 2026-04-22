import { FSWatcher, promises as fsPromises, watch } from "node:fs";
import path from "node:path";
import { isIgnoredRelativePath, normalizeChangedFilePath } from "../scanner/repository-scanner.js";
import { normalizePath } from "../types/graph.js";

export type WatchChangeType = "add" | "change" | "delete";
export type SourceEventType = "rename" | "change";

export interface WatchSourceEvent {
  absolutePath: string;
  eventType: SourceEventType;
}

export interface WatchBatchEvent {
  changedFiles: string[];
  deletedFiles: string[];
  events: Array<{ filePath: string; type: WatchChangeType }>;
  detectedAtMs: number;
}

export interface WatchSource {
  start(onEvent: (event: WatchSourceEvent) => Promise<void> | void): Promise<void> | void;
  stop(): Promise<void> | void;
  ensureWatchingDirectory?(absolutePath: string): Promise<void> | void;
}

export interface WatchServiceOptions {
  repoPath: string;
  debounceMs: number;
  onBatch: (event: WatchBatchEvent) => Promise<void> | void;
  watchSource?: WatchSource;
  nowMs?: () => number;
  onError?: (error: unknown) => void;
}

function mergeChange(existing: WatchChangeType | undefined, next: WatchChangeType): WatchChangeType {
  if (next === "delete") {
    return "delete";
  }

  if (existing === "delete") {
    return "change";
  }

  return next;
}

class NodeFsWatchSource implements WatchSource {
  private readonly repoPath: string;
  private readonly watchers = new Map<string, FSWatcher>();
  private onEvent: ((event: WatchSourceEvent) => Promise<void> | void) | null = null;

  public constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
  }

  public async start(onEvent: (event: WatchSourceEvent) => Promise<void> | void): Promise<void> {
    this.onEvent = onEvent;
    await this.ensureWatchingDirectory(this.repoPath);
  }

  public async stop(): Promise<void> {
    const closing = Array.from(this.watchers.values()).map(
      (watcher) =>
        new Promise<void>((resolve) => {
          watcher.once("close", resolve);
          watcher.close();
        })
    );
    this.watchers.clear();
    await Promise.all(closing);
  }

  public async ensureWatchingDirectory(absolutePath: string): Promise<void> {
    const resolvedPath = path.resolve(absolutePath);
    const relativePath = normalizePath(path.relative(this.repoPath, resolvedPath));
    if (relativePath.length > 0 && isIgnoredRelativePath(relativePath)) {
      return;
    }

    let stats;
    try {
      stats = await fsPromises.stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      return;
    }

    await this.watchDirectoryTree(resolvedPath);
  }

  private async watchDirectoryTree(directoryPath: string): Promise<void> {
    const resolvedPath = path.resolve(directoryPath);
    if (this.watchers.has(resolvedPath)) {
      return;
    }

    const watcher = watch(resolvedPath, { persistent: false }, (eventType, filename) => {
      if (!filename || this.onEvent === null) {
        return;
      }

      void this.onEvent({
        absolutePath: path.resolve(resolvedPath, filename.toString()),
        eventType
      });
    });
    this.watchers.set(resolvedPath, watcher);

    let entries;
    try {
      entries = await fsPromises.readdir(resolvedPath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }

      const childPath = path.join(resolvedPath, entry.name);
      const relativePath = normalizePath(path.relative(this.repoPath, childPath));
      if (relativePath.length > 0 && isIgnoredRelativePath(relativePath)) {
        continue;
      }

      await this.watchDirectoryTree(childPath);
    }
  }
}

export class RepositoryWatchService {
  private readonly repoPath: string;
  private readonly debounceMs: number;
  private readonly nowMs: () => number;
  private readonly onBatch: (event: WatchBatchEvent) => Promise<void> | void;
  private readonly onError: (error: unknown) => void;
  private readonly watchSource: WatchSource;

  private running = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges = new Map<string, WatchChangeType>();

  public constructor(options: WatchServiceOptions) {
    this.repoPath = path.resolve(options.repoPath);
    this.debounceMs = Math.max(0, Math.trunc(options.debounceMs));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.onBatch = options.onBatch;
    this.onError = options.onError ?? (() => {});
    this.watchSource = options.watchSource ?? new NodeFsWatchSource(this.repoPath);
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.watchSource.start(async (event) => {
        try {
          await this.handleSourceEvent(event);
        } catch (error) {
          this.onError(error);
        }
      });
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.pendingChanges.size > 0) {
      await this.flushPendingChanges();
    }

    await this.watchSource.stop();
  }

  public async handleSourceEvent(event: WatchSourceEvent): Promise<void> {
    if (!this.running) {
      return;
    }

    const normalizedPath = normalizeChangedFilePath(this.repoPath, event.absolutePath);
    if (!normalizedPath) {
      return;
    }

    const changeType = await this.resolveChangeType(event);
    this.pendingChanges.set(normalizedPath, mergeChange(this.pendingChanges.get(normalizedPath), changeType));
    this.scheduleFlush();
  }

  private async resolveChangeType(event: WatchSourceEvent): Promise<WatchChangeType> {
    try {
      const stats = await fsPromises.stat(event.absolutePath);
      if (stats.isDirectory()) {
        await this.watchSource.ensureWatchingDirectory?.(event.absolutePath);
      }
      return event.eventType === "change" ? "change" : "add";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return "delete";
      }
      throw error;
    }
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.flushPendingChanges().catch((error) => this.onError(error));
    }, this.debounceMs);
  }

  private async flushPendingChanges(): Promise<void> {
    if (!this.running || this.pendingChanges.size === 0) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const events = Array.from(this.pendingChanges.entries())
      .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
      .map(([filePath, type]) => ({ filePath, type }));
    this.pendingChanges = new Map();

    await this.onBatch({
      changedFiles: events.map((event) => event.filePath),
      deletedFiles: events.filter((event) => event.type === "delete").map((event) => event.filePath),
      events,
      detectedAtMs: this.nowMs()
    });
  }
}

export function createRepositoryWatchService(options: WatchServiceOptions): RepositoryWatchService {
  return new RepositoryWatchService(options);
}
