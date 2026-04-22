import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { CodeLanguage, ScannedFile, normalizePath } from "../types/graph.js";

const FILE_GLOB = "**/*.{ts,tsx,js,jsx,cs}";
export const DEFAULT_SCANNER_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/coverage/**",
  "worktrees/**",
  ".worktrees/**"
];

export interface ScanOptions {
  repoPath: string;
  languages: CodeLanguage[];
  changedFiles?: string[];
}

function languageFromPath(filePath: string): CodeLanguage {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".tsx":
      return CodeLanguage.TypeScript;
    case ".js":
    case ".jsx":
      return CodeLanguage.JavaScript;
    case ".cs":
      return CodeLanguage.CSharp;
    default:
      return CodeLanguage.Unknown;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isWithinRepository(repoPath: string, candidatePath: string): boolean {
  const relative = path.relative(repoPath, candidatePath);
  if (relative.length === 0 || relative === ".") {
    return false;
  }

  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function isIgnoredRelativePath(value: string): boolean {
  const normalized = normalizePath(value).replace(/^\.\//, "");
  const firstSegment = normalized.split("/")[0];

  return (
    firstSegment === "node_modules" ||
    firstSegment === "dist" ||
    firstSegment === ".git" ||
    firstSegment === "coverage" ||
    firstSegment === "worktrees" ||
    firstSegment === ".worktrees"
  );
}

export function normalizeChangedFilePath(repoPath: string, filePath: string): string | null {
  const absoluteRepoPath = path.resolve(repoPath);
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedInput = normalizePath(trimmed);
  const platformPath = normalizedInput.split("/").join(path.sep);
  const absoluteCandidate = path.isAbsolute(platformPath)
    ? path.resolve(platformPath)
    : path.resolve(absoluteRepoPath, platformPath);
  if (!isWithinRepository(absoluteRepoPath, absoluteCandidate)) {
    return null;
  }

  const relativePath = normalizePath(path.relative(absoluteRepoPath, absoluteCandidate));
  if (isIgnoredRelativePath(relativePath)) {
    return null;
  }

  return relativePath;
}

export function normalizeChangedFiles(repoPath: string, changedFiles: string[]): string[] {
  const normalized = new Set<string>();

  for (const value of changedFiles) {
    const normalizedPath = normalizeChangedFilePath(repoPath, value);
    if (normalizedPath) {
      normalized.add(normalizedPath);
    }
  }

  return Array.from(normalized);
}

export async function scanRepository(options: ScanOptions): Promise<ScannedFile[]> {
  const absoluteRepoPath = path.resolve(options.repoPath);
  const isIncrementalUpdate = options.changedFiles !== undefined;
  const normalizedChangedFiles = isIncrementalUpdate
    ? normalizeChangedFiles(absoluteRepoPath, options.changedFiles ?? [])
    : undefined;
  const candidateFiles =
    isIncrementalUpdate
      ? (normalizedChangedFiles ?? []).map((value) => path.resolve(absoluteRepoPath, value))
      : await fg(FILE_GLOB, {
          cwd: absoluteRepoPath,
          absolute: true,
          onlyFiles: true,
          ignore: DEFAULT_SCANNER_IGNORES,
          followSymbolicLinks: false
        });

  const files: ScannedFile[] = [];

  for (const filePath of candidateFiles) {
    if (!isWithinRepository(absoluteRepoPath, filePath)) {
      continue;
    }

    const relativePath = normalizePath(path.relative(absoluteRepoPath, filePath));
    if (isIgnoredRelativePath(relativePath)) {
      continue;
    }

    const language = languageFromPath(filePath);
    if (!options.languages.includes(language)) {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (normalizedChangedFiles && (code === "ENOENT" || code === "ENOTDIR")) {
        continue;
      }

      throw error;
    }

    files.push({
      absolutePath: filePath,
      relativePath,
      language,
      contentHash: hashContent(content),
      content
    });
  }

  return files;
}
