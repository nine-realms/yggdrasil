import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFile } from "../src/adapters/index.js";
import { createGraphStore } from "../src/graph/graph-store.js";
import { indexRepository } from "../src/indexer/index-repository.js";
import {
  BoundedParseAdapterCache,
  resetIncrementalParseAdapterCacheForTests
} from "../src/indexer/parse-adapter-cache.js";
import { CodeLanguage, EdgeKind, NodeKind } from "../src/types/graph.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetIncrementalParseAdapterCacheForTests();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("indexRepository", () => {
  it("normalizes absolute changed paths so incremental updates replace old symbols", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export function oldFn() {}\n", "utf8");
    await writeFile(path.join(repoDir, "src", "b.ts"), "export function stay() {}\n", "utf8");

    await indexRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript]
    });

    await writeFile(path.join(repoDir, "src", "a.ts"), "export function newFn() {}\n", "utf8");
    await indexRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript],
      changedFiles: [path.join(repoDir, "src", "a.ts")]
    });

    const graph = await createGraphStore(repoDir).readGraph();
    const symbolNames = graph.nodes
      .filter((node) => node.kind === NodeKind.Symbol)
      .map((node) => node.name);

    expect(symbolNames).not.toContain("oldFn");
    expect(symbolNames).toContain("newFn");
    expect(symbolNames).toContain("stay");
  });

  it("indexes C# DI/type references so symbol references can include registrations", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(
      path.join(repoDir, "src", "PrimaryService.cs"),
      "public class PrimaryService { public void Run() {} }\n",
      "utf8"
    );
    await writeFile(
      path.join(repoDir, "src", "Startup.cs"),
      `
        public class Startup {
          public void ConfigureServices(IServiceCollection services) {
            services.AddScoped<IPrimaryService, PrimaryService>();
          }
        }
      `,
      "utf8"
    );

    await indexRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.CSharp]
    });

    const refs = await createGraphStore(repoDir).findSymbolReferences({
      symbol: "PrimaryService",
      limit: 200,
      includeExternalNameMatches: true
    });
    const graph = await createGraphStore(repoDir).readGraph();

    expect(refs.summary.totalReferences).toBeGreaterThan(0);
    expect(refs.files.some((file) => file.filePath === "src/Startup.cs")).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === "external:IPrimaryService" &&
          edge.type === EdgeKind.DependsOn &&
          edge.to.includes("#PrimaryService@")
      )
    ).toBe(true);
  });

  it("reuses cached adapter output for unchanged incremental file content", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export function stable() {}\n", "utf8");

    const cache = new BoundedParseAdapterCache(8);
    let adaptCalls = 0;

    await indexRepository(
      {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      {
        parseAdapterCache: cache,
        adaptFileFn: (file) => {
          adaptCalls += 1;
          return adaptFile(file);
        }
      }
    );

    await indexRepository(
      {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript],
        changedFiles: ["src/a.ts"]
      },
      {
        parseAdapterCache: cache,
        adaptFileFn: (file) => {
          adaptCalls += 1;
          return adaptFile(file);
        }
      }
    );

    expect(adaptCalls).toBe(1);
  });

  it("re-runs adapter when incremental content hash changes", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export function first() {}\n", "utf8");

    const cache = new BoundedParseAdapterCache(8);
    let adaptCalls = 0;

    await indexRepository(
      {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript]
      },
      {
        parseAdapterCache: cache,
        adaptFileFn: (file) => {
          adaptCalls += 1;
          return adaptFile(file);
        }
      }
    );

    await writeFile(path.join(repoDir, "src", "a.ts"), "export function second() {}\n", "utf8");

    await indexRepository(
      {
        repoPath: repoDir,
        languages: [CodeLanguage.TypeScript],
        changedFiles: ["src/a.ts"]
      },
      {
        parseAdapterCache: cache,
        adaptFileFn: (file) => {
          adaptCalls += 1;
          return adaptFile(file);
        }
      }
    );

    expect(adaptCalls).toBe(2);
  });
});
