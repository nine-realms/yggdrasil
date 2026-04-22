import { describe, expect, it } from "vitest";
import {
  BoundedParseAdapterCache,
  buildParseAdapterCacheKey
} from "../src/indexer/parse-adapter-cache.js";
import { CodeLanguage, NodeKind } from "../src/types/graph.js";

describe("parse adapter cache", () => {
  it("returns cache misses before set and hits after set", () => {
    const cache = new BoundedParseAdapterCache(2);
    const key = buildParseAdapterCacheKey({
      relativePath: "src/a.ts",
      language: CodeLanguage.TypeScript,
      contentHash: "abc"
    });
    const output = { nodes: [{ id: "file:src/a.ts", kind: NodeKind.File, name: "src/a.ts" }], edges: [] };

    expect(cache.get(key)).toBeUndefined();
    cache.set(key, output);
    expect(cache.get(key)).toBe(output);
  });

  it("evicts least recently used entries when max size is exceeded", () => {
    const cache = new BoundedParseAdapterCache(2);
    cache.set("one", { nodes: [], edges: [] });
    cache.set("two", { nodes: [], edges: [] });

    expect(cache.get("one")).toBeDefined();
    cache.set("three", { nodes: [], edges: [] });

    expect(cache.get("one")).toBeDefined();
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("three")).toBeDefined();
  });
});
