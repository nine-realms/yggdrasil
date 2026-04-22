import { QueryCommandOptions } from "../config.js";
import { SymbolReferenceItem, SymbolReferencesResult } from "./query-contracts.js";
import { MethodUsageQueryOptions, MethodUsageResult } from "./query-contracts.js";
import { querySymbolReferences } from "./symbol-references.js";

export interface MethodUsageQuery extends QueryCommandOptions, MethodUsageQueryOptions {}

const INTERNAL_LOOKUP_LIMIT = 1_000;

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.trunc(numeric);
  if (rounded < minimum) {
    return minimum;
  }
  if (rounded > maximum) {
    return maximum;
  }
  return rounded;
}

export function deriveMethodName(symbol: string): string {
  const trimmed = symbol.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  let candidate = trimmed;
  const hashIndex = candidate.lastIndexOf("#");
  if (hashIndex >= 0 && hashIndex < candidate.length - 1) {
    candidate = candidate.slice(hashIndex + 1);
  }

  const atIndex = candidate.indexOf("@");
  if (atIndex > 0) {
    candidate = candidate.slice(0, atIndex);
  }

  const parameterIndex = candidate.indexOf("(");
  if (parameterIndex > 0) {
    candidate = candidate.slice(0, parameterIndex);
  }

  const dotIndex = candidate.lastIndexOf(".");
  if (dotIndex >= 0 && dotIndex < candidate.length - 1) {
    candidate = candidate.slice(dotIndex + 1);
  }

  const normalized = candidate.replace(/<[^>]+>/g, "").trim();
  if (normalized.length === 0) {
    return trimmed;
  }

  const identifiers = normalized.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (identifiers && identifiers.length > 0) {
    const methodLike = identifiers.filter((token) => /[A-Z]/.test(token.slice(1)));
    if (methodLike.length > 0) {
      return methodLike[methodLike.length - 1];
    }
    return identifiers[identifiers.length - 1];
  }

  return normalized;
}

function referenceSort(left: SymbolReferenceItem, right: SymbolReferenceItem): number {
  const leftPath = left.filePath ?? left.fromFilePath ?? left.toFilePath ?? "";
  const rightPath = right.filePath ?? right.fromFilePath ?? right.toFilePath ?? "";
  if (leftPath !== rightPath) {
    return leftPath.localeCompare(rightPath);
  }
  const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
  if (leftLine !== rightLine) {
    return leftLine - rightLine;
  }
  if (left.fromId !== right.fromId) {
    return left.fromId.localeCompare(right.fromId);
  }
  if (left.toId !== right.toId) {
    return left.toId.localeCompare(right.toId);
  }
  return left.kind.localeCompare(right.kind);
}

function referenceKey(reference: SymbolReferenceItem): string {
  return [
    reference.kind,
    reference.filePath ?? "",
    String(reference.line ?? ""),
    reference.fromId,
    reference.toId,
    reference.flow,
    reference.resolution
  ].join("|");
}

function mergeReferenceResults(results: SymbolReferencesResult[]): {
  roots: SymbolReferencesResult["roots"];
  references: SymbolReferenceItem[];
  files: Array<{ filePath: string; references: number }>;
} {
  const rootsById = new Map<string, SymbolReferencesResult["roots"][number]>();
  const referencesByKey = new Map<string, SymbolReferenceItem>();

  for (const result of results) {
    for (const root of result.roots) {
      rootsById.set(root.id, root);
    }
    for (const reference of result.references) {
      referencesByKey.set(referenceKey(reference), reference);
    }
  }

  const mergedReferences = Array.from(referencesByKey.values()).sort(referenceSort);
  const fileCounts = new Map<string, number>();
  for (const reference of mergedReferences) {
    const filePath = reference.filePath ?? reference.fromFilePath ?? reference.toFilePath;
    if (!filePath) {
      continue;
    }
    fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1);
  }

  const files = Array.from(fileCounts.entries())
    .map(([filePath, references]) => ({ filePath, references }))
    .sort((left, right) => right.references - left.references || left.filePath.localeCompare(right.filePath));

  return {
    roots: Array.from(rootsById.values()),
    references: mergedReferences,
    files
  };
}

export async function queryMethodUsage(query: MethodUsageQuery): Promise<MethodUsageResult> {
  const rawSymbol = query.symbol.trim();
  if (rawSymbol.length === 0) {
    throw new Error("method_usage requires a non-empty symbol value.");
  }

  const limit = clampInteger(query.limit, 1, 1_000, 200);
  const offset = clampInteger(query.offset, 0, 100_000, 0);
  const includeStructural = Boolean(query.includeStructural);
  const includeExternalNameMatches = query.includeExternalNameMatches ?? true;
  const includeAliasExpansion = query.includeAliasExpansion ?? true;
  const outputMode = query.outputMode === "files_only" ? "files_only" : "full";
  const excludeSelf = Boolean(query.excludeSelf);
  const testOnly = Boolean(query.testOnly);
  const methodName = deriveMethodName(rawSymbol);

  const attempts: MethodUsageResult["strategy"]["attempts"] = [];
  const attemptResults: SymbolReferencesResult[] = [];
  const primary = await querySymbolReferences({
    repoPath: query.repoPath,
    storeDir: query.storeDir,
    symbol: methodName,
    limit: INTERNAL_LOOKUP_LIMIT,
    offset: 0,
    includeStructural,
    matching: "name",
    includeExternalNameMatches,
    includeAliasExpansion,
    outputMode: "full",
    excludeSelf,
    testOnly
  });
  attemptResults.push(primary);
  attempts.push({
    symbol: methodName,
    matching: "name",
    matchedRoots: primary.summary.matchedRoots,
    totalReferences: primary.summary.totalReferences
  });

  let fallbackUsed = false;
  if ((primary.summary.matchedRoots === 0 || primary.summary.totalReferences === 0) && methodName !== rawSymbol) {
    const fallback = await querySymbolReferences({
      repoPath: query.repoPath,
      storeDir: query.storeDir,
      symbol: rawSymbol,
      limit: INTERNAL_LOOKUP_LIMIT,
      offset: 0,
      includeStructural,
      matching: "prefer_qualified",
      includeExternalNameMatches,
      includeAliasExpansion,
      outputMode: "full",
      excludeSelf,
      testOnly
    });
    fallbackUsed = true;
    attemptResults.push(fallback);
    attempts.push({
      symbol: rawSymbol,
      matching: "prefer_qualified",
      matchedRoots: fallback.summary.matchedRoots,
      totalReferences: fallback.summary.totalReferences
    });
  }

  const merged = mergeReferenceResults(attemptResults);
  const pagedReferences =
    outputMode === "files_only" ? [] : merged.references.slice(offset, offset + limit);

  return {
    query: {
      symbol: rawSymbol,
      methodName,
      limit,
      offset,
      includeStructural,
      includeExternalNameMatches,
      includeAliasExpansion,
      outputMode,
      excludeSelf,
      testOnly
    },
    strategy: {
      fallbackUsed,
      attempts
    },
    summary: {
      matchedRoots: merged.roots.length,
      totalReferences: merged.references.length,
      returnedReferences: pagedReferences.length,
      hasMore: outputMode === "files_only" ? false : merged.references.length > offset + pagedReferences.length,
      totalFiles: merged.files.length,
      returnedFiles: merged.files.length,
      hasMoreFiles: false
    },
    roots: merged.roots,
    references: pagedReferences,
    files: merged.files
  };
}
