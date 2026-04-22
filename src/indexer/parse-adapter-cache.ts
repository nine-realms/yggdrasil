import { AdapterOutput, CodeLanguage } from "../types/graph.js";

export interface ParseAdapterCache {
  get(key: string): AdapterOutput | undefined;
  set(key: string, value: AdapterOutput): void;
  clear(): void;
}

const DEFAULT_MAX_CACHE_ENTRIES = 512;

function readMaxEntriesFromEnv(): number {
  const raw = process.env.YGGDRASIL_PARSE_CACHE_MAX_ENTRIES;
  if (!raw) {
    return DEFAULT_MAX_CACHE_ENTRIES;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_CACHE_ENTRIES;
  }

  return Math.trunc(parsed);
}

export function buildParseAdapterCacheKey(file: {
  relativePath: string;
  language: CodeLanguage;
  contentHash: string;
}): string {
  return `${file.language}:${file.relativePath}:${file.contentHash}`;
}

export class BoundedParseAdapterCache implements ParseAdapterCache {
  private readonly entries = new Map<string, AdapterOutput>();

  public constructor(private readonly maxEntries: number) {}

  public get(key: string): AdapterOutput | undefined {
    const value = this.entries.get(key);
    if (!value) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  public set(key: string, value: AdapterOutput): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, value);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}

const incrementalParseAdapterCache = new BoundedParseAdapterCache(readMaxEntriesFromEnv());

export function getIncrementalParseAdapterCache(): ParseAdapterCache {
  return incrementalParseAdapterCache;
}

export function resetIncrementalParseAdapterCacheForTests(): void {
  incrementalParseAdapterCache.clear();
}
