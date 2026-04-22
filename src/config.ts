import path from "node:path";
import { CodeLanguage } from "./types/graph.js";

export type ResolverMode = "strict" | "ranked";
export type ResolverLanguageScope = "csharp-and-typescript" | "all-current-languages";

export interface ResolverPolicyOptions {
  mode?: ResolverMode;
  languageScope?: ResolverLanguageScope;
  highConfidenceThreshold?: number;
  mediumConfidenceThreshold?: number;
  maxAlternatives?: number;
}

export interface IndexCommandOptions {
  repoPath: string;
  languages: CodeLanguage[];
  changedFiles?: string[];
  storeDir?: string;
  resolverPolicy?: ResolverPolicyOptions;
}

export interface QueryCommandOptions {
  repoPath: string;
  storeDir?: string;
}

export interface StoragePaths {
  storeDir: string;
  dbPath: string;
}

export function parseLanguages(raw: string): CodeLanguage[] {
  const map: Record<string, CodeLanguage> = {
    ts: CodeLanguage.TypeScript,
    typescript: CodeLanguage.TypeScript,
    js: CodeLanguage.JavaScript,
    javascript: CodeLanguage.JavaScript,
    cs: CodeLanguage.CSharp,
    csharp: CodeLanguage.CSharp
  };

  const parsed = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .map((value) => map[value]);

  if (parsed.length === 0 || parsed.some((value) => value === undefined)) {
    throw new Error(`Unsupported language list: "${raw}"`);
  }

  return Array.from(new Set(parsed));
}

export function resolveRepoPath(repoPath: string): string {
  const trimmed = repoPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Repository path is required.");
  }

  return path.resolve(trimmed);
}

export function resolveStoragePaths(repoPath: string, explicitStoreDir?: string): StoragePaths {
  const root = resolveRepoPath(repoPath);
  const storeDir = path.resolve(explicitStoreDir ?? path.join(root, ".yggdrasil"));
  return {
    storeDir,
    dbPath: path.join(storeDir, "graph.db")
  };
}

export function parseResolverMode(raw: string): ResolverMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "strict" || normalized === "ranked") {
    return normalized;
  }
  throw new Error(`Unsupported resolver mode: "${raw}". Expected "strict" or "ranked".`);
}

export function parseResolverLanguageScope(raw: string): ResolverLanguageScope {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "csharp-and-typescript" || normalized === "all-current-languages") {
    return normalized;
  }
  throw new Error(
    `Unsupported resolver language scope: "${raw}". Expected "csharp-and-typescript" or "all-current-languages".`
  );
}
