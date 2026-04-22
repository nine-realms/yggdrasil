import { deriveMethodName } from "../query/method-usage.js";

function fail(tool: string, message: string, hint: string): never {
  throw new Error(`${tool}: ${message} Hint: ${hint}`);
}

function hasIdentifier(value: string): boolean {
  return /[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function looksQualifiedSymbol(value: string): boolean {
  return value.includes(":") || value.includes("#") || value.includes(".");
}

function looksLikeFilePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[a-zA-Z0-9]+$/.test(value);
}

function looksExactSymbolQuery(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("symbol:") || trimmed.startsWith("external:") || trimmed.startsWith("module:")) {
    return true;
  }
  if (trimmed.includes("#") && trimmed.includes("@")) {
    return true;
  }
  return /^[A-Za-z_][A-Za-z0-9_.]*\([^)]*\)$/.test(trimmed);
}

function requireRepoPath(tool: string, repoPath: string): void {
  if (repoPath.trim().length === 0) {
    fail(tool, '"repoPath" is required.', 'Provide the indexed repository root path, e.g. "C:\\\\repo".');
  }
}

export function validateSymbolReferencesArgs(args: {
  repoPath: string;
  symbol: string;
  matching?: "prefer_qualified" | "qualified_only" | "name";
}): void {
  requireRepoPath("symbol_references", args.repoPath);
  const symbol = args.symbol.trim();
  if (symbol.length === 0) {
    fail(
      "symbol_references",
      '"symbol" is required.',
      'Provide a symbol id/name, e.g. {"symbol":"PrimaryService","matching":"prefer_qualified"}.'
    );
  }

  if (args.matching === "qualified_only" && !looksQualifiedSymbol(symbol)) {
    fail(
      "symbol_references",
      '"matching" was "qualified_only" but the symbol looked unqualified.',
      'Try matching="prefer_qualified" or matching="name" for symbols like "PrimaryService".'
    );
  }
}

export function validateMethodUsageArgs(args: { repoPath: string; symbol: string }): void {
  requireRepoPath("method_usage", args.repoPath);
  const symbol = args.symbol.trim();
  if (symbol.length === 0) {
    fail(
      "method_usage",
      '"symbol" is required.',
      'Provide a method name/id, e.g. "GetOrderDetails" or "Service.GetOrderDetails".'
    );
  }
  if (looksLikeFilePath(symbol)) {
    fail(
      "method_usage",
      '"symbol" looked like a file path.',
      'Use references_for_file for file-centric lookups, or pass a method symbol/name to method_usage.'
    );
  }
  const derived = deriveMethodName(symbol);
  if (!hasIdentifier(derived)) {
    fail(
      "method_usage",
      'Unable to derive a method name from "symbol".',
      'Use a method-like symbol such as "GetOrderDetails" or "Namespace.Service.GetOrderDetails".'
    );
  }
}

export function validateImpactFromDiffArgs(args: {
  repoPath: string;
  changedFiles: string[];
  symbols: string[];
}): void {
  requireRepoPath("impact_from_diff", args.repoPath);
  if (args.changedFiles.length === 0 && args.symbols.length === 0) {
    fail(
      "impact_from_diff",
      'Provide at least one seed via "changedFiles" or "symbols".',
      'Example: {"changedFiles":["src\\\\services\\\\order-service.ts"],"depth":2,"outputMode":"files_only"}.'
    );
  }
}

export function validateHybridSearchArgs(args: { repoPath: string; query: string }): void {
  requireRepoPath("hybrid_search", args.repoPath);
  const query = args.query.trim();
  if (query.length === 0) {
    fail(
      "hybrid_search",
      '"query" is required.',
      'Provide free-text search terms, e.g. {"query":"order processing","depth":1,"outputMode":"files_only"}.'
    );
  }
  if (looksExactSymbolQuery(query)) {
    fail(
      "hybrid_search",
      '"query" looked like an exact symbol identity.',
      'Use symbol_references for exact symbols or method_usage for method callsites.'
    );
  }
}
