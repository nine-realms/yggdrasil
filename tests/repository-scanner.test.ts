import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeChangedFiles, scanRepository } from "../src/scanner/repository-scanner.js";
import { CodeLanguage } from "../src/types/graph.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("repository-scanner", () => {
  it("normalizes changed file paths and excludes files outside repo root", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-outside-"));
    tempDirs.push(repoDir, outsideDir);

    const insideAbsolute = path.join(repoDir, "src", "a.ts");
    const outsideAbsolute = path.join(outsideDir, "external.ts");

    const normalized = normalizeChangedFiles(repoDir, [
      "src\\a.ts",
      insideAbsolute,
      outsideAbsolute,
      "..\\outside\\b.ts",
      "worktrees\\feature\\src\\leak.ts"
    ]);

    expect(normalized).toEqual(["src/a.ts"]);
  });

  it("skips deleted files during incremental scans", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const scanned = await scanRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript],
      changedFiles: ["src/a.ts", "src/deleted.ts"]
    });

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.relativePath).toBe("src/a.ts");
  });

  it("treats empty changed-file lists as no-op incremental scans", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const scanned = await scanRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript],
      changedFiles: []
    });

    expect(scanned).toHaveLength(0);
  });

  it("excludes top-level worktrees from full repository scans", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "yggdrasil-repo-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await mkdir(path.join(repoDir, "worktrees", "feature", "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "main.ts"), "export const main = 1;\n", "utf8");
    await writeFile(
      path.join(repoDir, "worktrees", "feature", "src", "leak.ts"),
      "export const leak = 1;\n",
      "utf8"
    );

    const scanned = await scanRepository({
      repoPath: repoDir,
      languages: [CodeLanguage.TypeScript]
    });

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.relativePath).toBe("src/main.ts");
  });
});
