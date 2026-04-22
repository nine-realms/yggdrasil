import {
  AdapterOutput,
  CodeLanguage,
  EdgeKind,
  GRAPH_SCHEMA_VERSION,
  GraphDocument,
  GraphEdge,
  GraphNode,
  NodeKind,
  ScannedFile,
  fileNodeId,
  normalizePath,
  repoNodeId
} from "../types/graph.js";
import { ResolverLanguageScope, ResolverMode, ResolverPolicyOptions } from "../config.js";

function mergeNodes(nodes: GraphNode[]): GraphNode[] {
  const merged = new Map<string, GraphNode>();

  for (const node of nodes) {
    const existing = merged.get(node.id);
    if (!existing) {
      merged.set(node.id, {
        ...node,
        metadata: node.metadata ?? {}
      });
      continue;
    }

    merged.set(node.id, {
      ...existing,
      ...node,
      metadata: {
        ...(existing.metadata ?? {}),
        ...(node.metadata ?? {})
      }
    });
  }

  return Array.from(merged.values());
}

function mergeEdges(edges: GraphEdge[]): GraphEdge[] {
  const deduped = new Map<string, GraphEdge>();

  for (const edge of edges) {
    const key = `${edge.type}|${edge.from}|${edge.to}|${edge.filePath ?? ""}|${edge.line ?? ""}`;
    if (!deduped.has(key)) {
      deduped.set(key, edge);
    }
  }

  return Array.from(deduped.values());
}

function stripGenericArguments(raw: string): string {
  let depth = 0;
  let normalized = "";
  for (const char of raw) {
    if (char === "<") {
      depth += 1;
      continue;
    }
    if (char === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      normalized += char;
    }
  }
  return normalized;
}

function normalizeExternalName(raw: string): string {
  return stripGenericArguments(raw)
    .replace(/\[\]/g, "")
    .replace(/\?/g, "")
    .trim();
}

function externalNameVariants(raw: string): string[] {
  const normalized = normalizeExternalName(raw);
  if (!normalized) {
    return [];
  }
  const variants = new Set<string>([normalized]);
  const rightmost = normalized.split(".").filter((segment) => segment.length > 0).pop();
  if (rightmost && rightmost !== normalized) {
    variants.add(rightmost);
  }
  return [...variants];
}

function nodeNamespace(node: GraphNode): string | undefined {
  const value = node.metadata?.namespace;
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function namespaceMatchesImport(symbolNamespace: string, importNamespace: string): boolean {
  return (
    symbolNamespace === importNamespace ||
    symbolNamespace.startsWith(`${importNamespace}.`) ||
    importNamespace.startsWith(`${symbolNamespace}.`)
  );
}

interface ImportContext {
  namespaces: Set<string>;
  aliasMap: Map<string, string>;
  staticImports: Set<string>;
}

interface CandidateScore {
  qualifiedMatch: number;
  aliasQualifiedMatch: number;
  sameFile: number;
  sameContainingType: number;
  receiverTypeMatch: number;
  exactNamespaceImport: number;
  namespacePrefixLength: number;
  staticImportMatch: number;
  signatureScore: number;
  projectProximity: number;
}

interface RankedCandidate {
  candidate: GraphNode;
  score: CandidateScore;
}

type ResolverConfidenceBand = "high" | "medium" | "low";

type ResolverDecisionCode =
  | "strict_resolved"
  | "strict_unresolved_tie"
  | "strict_unresolved_no_candidates"
  | "ranked_auto_resolved"
  | "ranked_candidates_only"
  | "ranked_low_confidence"
  | "ranked_no_candidates";

interface ResolutionDecision {
  mode: ResolverMode;
  code: ResolverDecisionCode;
  confidenceBand: ResolverConfidenceBand;
  confidence: number;
  selectedCandidate?: GraphNode;
  candidateCount: number;
}

interface EffectiveResolverPolicy {
  mode: ResolverMode;
  languageScope: ResolverLanguageScope;
  highConfidenceThreshold: number;
  mediumConfidenceThreshold: number;
  maxAlternatives: number;
}

const DEFAULT_RESOLVER_POLICY: EffectiveResolverPolicy = {
  mode: "ranked",
  languageScope: "csharp-and-typescript",
  highConfidenceThreshold: 0.85,
  mediumConfidenceThreshold: 0.6,
  maxAlternatives: 3
};

const MAX_RESOLUTION_ALTERNATIVES = 10;
const scorePriorityOrder: Array<keyof CandidateScore> = [
  "qualifiedMatch",
  "aliasQualifiedMatch",
  "sameFile",
  "sameContainingType",
  "receiverTypeMatch",
  "exactNamespaceImport",
  "namespacePrefixLength",
  "staticImportMatch",
  "signatureScore",
  "projectProximity"
];

function normalizeQualifiedName(value: string): string {
  return value.replace(/\s+/g, "").replace(/\bglobal::/g, "").trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function normalizeResolverPolicy(policy?: ResolverPolicyOptions): EffectiveResolverPolicy {
  const mode = policy?.mode ?? DEFAULT_RESOLVER_POLICY.mode;
  const languageScope = policy?.languageScope ?? DEFAULT_RESOLVER_POLICY.languageScope;
  const highConfidenceThreshold = clampNumber(
    policy?.highConfidenceThreshold ?? DEFAULT_RESOLVER_POLICY.highConfidenceThreshold,
    0,
    1
  );
  const mediumConfidenceThreshold = clampNumber(
    policy?.mediumConfidenceThreshold ?? DEFAULT_RESOLVER_POLICY.mediumConfidenceThreshold,
    0,
    1
  );
  if (mediumConfidenceThreshold > highConfidenceThreshold) {
    throw new Error("Resolver policy requires medium confidence threshold to be less than or equal to high threshold.");
  }
  const maxAlternatives = clampInteger(
    policy?.maxAlternatives ?? DEFAULT_RESOLVER_POLICY.maxAlternatives,
    1,
    MAX_RESOLUTION_ALTERNATIVES
  );
  return {
    mode,
    languageScope,
    highConfidenceThreshold,
    mediumConfidenceThreshold,
    maxAlternatives
  };
}

function emptyImportContext(): ImportContext {
  return {
    namespaces: new Set<string>(),
    aliasMap: new Map<string, string>(),
    staticImports: new Set<string>()
  };
}

function mergeImportContexts(base: ImportContext, next: ImportContext): ImportContext {
  const merged = emptyImportContext();
  for (const value of base.namespaces) {
    merged.namespaces.add(value);
  }
  for (const value of next.namespaces) {
    merged.namespaces.add(value);
  }
  for (const [alias, target] of base.aliasMap.entries()) {
    merged.aliasMap.set(alias, target);
  }
  for (const [alias, target] of next.aliasMap.entries()) {
    merged.aliasMap.set(alias, target);
  }
  for (const value of base.staticImports) {
    merged.staticImports.add(value);
  }
  for (const value of next.staticImports) {
    merged.staticImports.add(value);
  }
  return merged;
}

function splitPathSegments(value: string): string[] {
  return normalizePath(value)
    .split("/")
    .filter((segment) => segment.length > 0);
}

function commonPathPrefixLength(leftPath: string | undefined, rightPath: string | undefined): number {
  if (!leftPath || !rightPath) {
    return 0;
  }
  const leftSegments = splitPathSegments(leftPath);
  const rightSegments = splitPathSegments(rightPath);
  const limit = Math.min(leftSegments.length, rightSegments.length);
  let count = 0;
  while (count < limit && leftSegments[count] === rightSegments[count]) {
    count += 1;
  }
  return count;
}

function candidateNamespacePrefixLength(candidateNamespace: string | undefined, imports: Set<string>): number {
  if (!candidateNamespace || imports.size === 0) {
    return 0;
  }

  let best = 0;
  for (const imported of imports) {
    if (namespaceMatchesImport(candidateNamespace, imported)) {
      best = Math.max(best, imported.length);
    }
  }
  return best;
}

function expandAliasQualifiedNames(externalName: string, aliasMap: Map<string, string>): string[] {
  const normalized = normalizeQualifiedName(externalName);
  const dotIndex = normalized.indexOf(".");
  if (dotIndex <= 0) {
    return [];
  }

  const alias = normalized.slice(0, dotIndex);
  const remainder = normalized.slice(dotIndex + 1);
  const target = aliasMap.get(alias);
  if (!target || !remainder) {
    return [];
  }
  return [`${target}.${remainder}`];
}

function fullyQualifiedName(node: GraphNode): string | undefined {
  const value = asString(node.metadata?.fullyQualifiedName);
  return value ? normalizeQualifiedName(value) : undefined;
}

function containingTypeName(node: GraphNode): string | undefined {
  return asString(node.metadata?.containingType);
}

function symbolArity(node: GraphNode): number | undefined {
  return asNumber(node.metadata?.arity);
}

function symbolParameterCount(node: GraphNode): number | undefined {
  return asNumber(node.metadata?.parameterCount);
}

function symbolMemberKind(node: GraphNode): string | undefined {
  return asString(node.metadata?.memberKind);
}

function scoreCandidate(
  candidate: GraphNode,
  edge: GraphEdge,
  edgeFilePath: string | undefined,
  callerContainingType: string | undefined,
  importContext: ImportContext,
  externalQualifiedNames: Set<string>,
  aliasQualifiedNames: Set<string>
): CandidateScore {
  const candidateFile = candidate.filePath ? normalizePath(candidate.filePath) : undefined;
  const candidateNamespace = nodeNamespace(candidate);
  const candidateContainingType = containingTypeName(candidate);
  const candidateFullyQualifiedName = fullyQualifiedName(candidate);
  const receiverType = asString(edge.metadata?.receiverType);

  const exactNamespaceImport =
    candidateNamespace && importContext.namespaces.has(candidateNamespace) ? 1 : 0;
  const namespacePrefixLength = candidateNamespacePrefixLength(candidateNamespace, importContext.namespaces);

  const staticImportMatch = (() => {
    if (importContext.staticImports.size === 0 || !candidateFullyQualifiedName || !candidateContainingType) {
      return 0;
    }
    const ownerQualified = candidateFullyQualifiedName.slice(
      0,
      Math.max(0, candidateFullyQualifiedName.length - candidate.name.length - 1)
    );
    return importContext.staticImports.has(ownerQualified) ? 1 : 0;
  })();

  const signatureScore = (() => {
    let score = 0;
    const edgeMemberKind = asString(edge.metadata?.memberKind);
    if (edgeMemberKind && symbolMemberKind(candidate) === edgeMemberKind) {
      score += 1;
    }

    const edgeGenericArity = asNumber(edge.metadata?.genericArity);
    if (edgeGenericArity !== undefined) {
      const candidateArity = symbolArity(candidate);
      if (candidateArity !== undefined && candidateArity === edgeGenericArity) {
        score += 1;
      }
    }

    const edgeArgCount = asNumber(edge.metadata?.argCount);
    if (edgeArgCount !== undefined) {
      const candidateParameterTotal = symbolParameterCount(candidate);
      if (candidateParameterTotal !== undefined && candidateParameterTotal === edgeArgCount) {
        score += 1;
      }
    }

    return score;
  })();

  return {
    qualifiedMatch:
      candidateFullyQualifiedName && externalQualifiedNames.has(candidateFullyQualifiedName) ? 1 : 0,
    aliasQualifiedMatch:
      candidateFullyQualifiedName && aliasQualifiedNames.has(candidateFullyQualifiedName) ? 1 : 0,
    sameFile: edgeFilePath && candidateFile === edgeFilePath ? 1 : 0,
    sameContainingType:
      callerContainingType && candidateContainingType === callerContainingType ? 1 : 0,
    receiverTypeMatch:
      receiverType &&
      (candidateContainingType === receiverType ||
        (candidateFullyQualifiedName?.includes(`${receiverType}.`) ?? false))
        ? 1
        : 0,
    exactNamespaceImport,
    namespacePrefixLength,
    staticImportMatch,
    signatureScore,
    projectProximity: commonPathPrefixLength(edgeFilePath, candidateFile)
  };
}

function compareCandidateScore(left: CandidateScore, right: CandidateScore): number {
  for (const key of scorePriorityOrder) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function leadingEqualScoreKeys(left: CandidateScore, right: CandidateScore): number {
  let equalCount = 0;
  for (const key of scorePriorityOrder) {
    if (left[key] === right[key]) {
      equalCount += 1;
      continue;
    }
    break;
  }
  return equalCount;
}

function firstDifferingScoreKeyIndex(left: CandidateScore, right: CandidateScore): number {
  for (let index = 0; index < scorePriorityOrder.length; index += 1) {
    const key = scorePriorityOrder[index]!;
    if (left[key] !== right[key]) {
      return index;
    }
  }
  return -1;
}

function scoreMagnitude(score: CandidateScore): number {
  const namespaceSignal = clampNumber(score.namespacePrefixLength / 40, 0, 1);
  const proximitySignal = clampNumber(score.projectProximity / 8, 0, 1);
  const signatureSignal = clampNumber(score.signatureScore / 3, 0, 1);
  const weighted =
    0.15 +
    score.qualifiedMatch * 0.3 +
    score.aliasQualifiedMatch * 0.18 +
    score.sameFile * 0.12 +
    score.sameContainingType * 0.07 +
    score.receiverTypeMatch * 0.1 +
    score.exactNamespaceImport * 0.06 +
    namespaceSignal * 0.04 +
    score.staticImportMatch * 0.04 +
    signatureSignal * 0.07 +
    proximitySignal * 0.03;
  return clampNumber(weighted, 0, 1);
}

function confidenceBandFor(confidence: number, policy: EffectiveResolverPolicy): ResolverConfidenceBand {
  if (confidence >= policy.highConfidenceThreshold) {
    return "high";
  }
  if (confidence >= policy.mediumConfidenceThreshold) {
    return "medium";
  }
  return "low";
}

function computeConfidence(
  best: RankedCandidate,
  second: RankedCandidate | undefined,
  policy: EffectiveResolverPolicy
): { confidence: number; band: ResolverConfidenceBand } {
  if (!second) {
    const confidence = Math.max(policy.highConfidenceThreshold, scoreMagnitude(best.score));
    return { confidence: round(confidence), band: "high" };
  }
  const compare = compareCandidateScore(best.score, second.score);
  const leadingTieCount = leadingEqualScoreKeys(best.score, second.score);
  const firstDiffIndex = firstDifferingScoreKeyIndex(best.score, second.score);
  const penalty = leadingTieCount * 0.025;
  let confidence = clampNumber(scoreMagnitude(best.score) - penalty, 0, 1);
  const projectProximityIndex = scorePriorityOrder.indexOf("projectProximity");
  const decisiveBeforeProximity =
    compare > 0 &&
    firstDiffIndex >= 0 &&
    firstDiffIndex < projectProximityIndex;
  if (decisiveBeforeProximity) {
    confidence = Math.max(confidence, policy.highConfidenceThreshold);
  }
  return { confidence: round(confidence), band: confidenceBandFor(confidence, policy) };
}

interface ResolverIndexes {
  nodeById: Map<string, GraphNode>;
  symbolCandidatesByName: Map<string, GraphNode[]>;
  symbolCandidatesByQualifiedName: Map<string, GraphNode[]>;
  importedContextByFile: Map<string, ImportContext>;
  globalImports: ImportContext;
}

interface CandidateCollectionContext {
  candidates: GraphNode[];
  normalizedFilePath?: string;
  callerContainingType?: string;
  importContext: ImportContext;
  externalQualifiedNames: Set<string>;
  aliasQualifiedNames: Set<string>;
}

function buildResolverIndexes(nodes: GraphNode[], edges: GraphEdge[]): ResolverIndexes {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const symbolCandidatesByName = new Map<string, GraphNode[]>();
  const symbolCandidatesByQualifiedName = new Map<string, GraphNode[]>();
  const importedContextByFile = new Map<string, ImportContext>();
  const globalImports = emptyImportContext();

  for (const node of nodes) {
    if (node.kind !== NodeKind.Symbol) {
      continue;
    }

    const byName = symbolCandidatesByName.get(node.name) ?? [];
    byName.push(node);
    symbolCandidatesByName.set(node.name, byName);

    const qualifiedName = fullyQualifiedName(node);
    if (qualifiedName) {
      const byQualifiedName = symbolCandidatesByQualifiedName.get(qualifiedName) ?? [];
      byQualifiedName.push(node);
      symbolCandidatesByQualifiedName.set(qualifiedName, byQualifiedName);
    }
  }

  for (const edge of edges) {
    if (edge.type !== EdgeKind.Imports || !edge.filePath) {
      continue;
    }
    const moduleNode = nodeById.get(edge.to);
    if (moduleNode?.kind !== NodeKind.Module || moduleNode.name.length === 0) {
      continue;
    }
    const normalizedFile = normalizePath(edge.filePath);
    const importContext = importedContextByFile.get(normalizedFile) ?? emptyImportContext();
    const normalizedModuleName = normalizeQualifiedName(moduleNode.name);
    importContext.namespaces.add(normalizedModuleName);

    const alias = asString(edge.metadata?.alias);
    if (alias) {
      importContext.aliasMap.set(alias, normalizedModuleName);
    }
    if (edge.metadata?.staticImport === true) {
      importContext.staticImports.add(normalizedModuleName);
    }

    importedContextByFile.set(normalizedFile, importContext);

    if (edge.metadata?.globalUsing === true) {
      globalImports.namespaces.add(normalizedModuleName);
      if (alias) {
        globalImports.aliasMap.set(alias, normalizedModuleName);
      }
      if (edge.metadata?.staticImport === true) {
        globalImports.staticImports.add(normalizedModuleName);
      }
    }
  }

  return {
    nodeById,
    symbolCandidatesByName,
    symbolCandidatesByQualifiedName,
    importedContextByFile,
    globalImports
  };
}

function isRankedLanguageEligible(
  edge: GraphEdge,
  nodeById: Map<string, GraphNode>,
  policy: EffectiveResolverPolicy
): boolean {
  if (policy.mode !== "ranked") {
    return false;
  }
  if (policy.languageScope === "all-current-languages") {
    return true;
  }

  const fromLanguage = nodeById.get(edge.from)?.language;
  const toLanguage = nodeById.get(edge.to)?.language;
  if (fromLanguage === CodeLanguage.CSharp || toLanguage === CodeLanguage.CSharp) {
    return true;
  }
  if (fromLanguage === CodeLanguage.TypeScript || toLanguage === CodeLanguage.TypeScript) {
    return true;
  }
  const normalizedPath = edge.filePath ? normalizePath(edge.filePath) : "";
  return /\.cs$/i.test(normalizedPath) || /\.tsx?$/i.test(normalizedPath);
}

function collectCandidatesForEdge(edge: GraphEdge, indexes: ResolverIndexes): CandidateCollectionContext {
  const externalNode = indexes.nodeById.get(edge.to);
  const externalNameRaw = externalNode?.name ?? edge.to.slice("external:".length);
  const candidateNames = externalNameVariants(externalNameRaw);
  const normalizedFilePath = edge.filePath ? normalizePath(edge.filePath) : undefined;
  const fileImports = normalizedFilePath ? indexes.importedContextByFile.get(normalizedFilePath) : undefined;
  const importContext = mergeImportContexts(indexes.globalImports, fileImports ?? emptyImportContext());
  const aliasQualifiedNames = new Set(expandAliasQualifiedNames(externalNameRaw, importContext.aliasMap));
  const externalQualifiedNames = new Set(
    candidateNames.filter((candidateName) => candidateName.includes(".")).map((value) => normalizeQualifiedName(value))
  );
  const candidateNodes = new Map<string, GraphNode>();
  for (const candidateName of candidateNames) {
    const normalizedCandidate = normalizeQualifiedName(candidateName);
    const byQualifiedName = indexes.symbolCandidatesByQualifiedName.get(normalizedCandidate) ?? [];
    for (const candidate of byQualifiedName) {
      candidateNodes.set(candidate.id, candidate);
    }

    const byName = indexes.symbolCandidatesByName.get(candidateName) ?? [];
    for (const candidate of byName) {
      candidateNodes.set(candidate.id, candidate);
    }
  }
  for (const aliasQualifiedName of aliasQualifiedNames) {
    const aliasCandidates = indexes.symbolCandidatesByQualifiedName.get(aliasQualifiedName) ?? [];
    for (const candidate of aliasCandidates) {
      candidateNodes.set(candidate.id, candidate);
    }
  }

  const callerNode = indexes.nodeById.get(edge.from);
  const callerContainingType = asString(callerNode?.metadata?.containingType);

  return {
    candidates: [...candidateNodes.values()],
    normalizedFilePath,
    callerContainingType,
    importContext,
    externalQualifiedNames,
    aliasQualifiedNames
  };
}

function scoreCandidatesForEdge(edge: GraphEdge, context: CandidateCollectionContext): RankedCandidate[] {
  const scoredCandidates = context.candidates.map((candidate) => ({
    candidate,
    score: scoreCandidate(
      candidate,
      edge,
      context.normalizedFilePath,
      context.callerContainingType,
      context.importContext,
      context.externalQualifiedNames,
      context.aliasQualifiedNames
    )
  }));
  scoredCandidates.sort((left, right) => {
    const scoreCompare = compareCandidateScore(right.score, left.score);
    if (scoreCompare !== 0) {
      return scoreCompare;
    }
    return left.candidate.id.localeCompare(right.candidate.id);
  });
  return scoredCandidates;
}

function resolutionCandidatePayload(
  rankedCandidates: RankedCandidate[],
  policy: EffectiveResolverPolicy
): Array<{ id: string; name: string; confidence: number; fullyQualifiedName?: string }> {
  return rankedCandidates.slice(0, policy.maxAlternatives).map((entry) => ({
    id: entry.candidate.id,
    name: entry.candidate.name,
    confidence: round(scoreMagnitude(entry.score)),
    fullyQualifiedName: asNonEmptyString(entry.candidate.metadata?.fullyQualifiedName)
  }));
}

function attachResolutionMetadata(
  edge: GraphEdge,
  decision: ResolutionDecision,
  rankedCandidates: RankedCandidate[],
  policy: EffectiveResolverPolicy
): GraphEdge {
  const topCandidates = resolutionCandidatePayload(rankedCandidates, policy);
  return {
    ...edge,
    metadata: {
      ...(edge.metadata ?? {}),
      resolverMode: decision.mode,
      resolverDecision: decision.code,
      resolverConfidence: decision.confidence,
      resolverConfidenceBand: decision.confidenceBand,
      resolverCandidateCount: decision.candidateCount,
      resolverHighThreshold: policy.highConfidenceThreshold,
      resolverMediumThreshold: policy.mediumConfidenceThreshold,
      resolverSelectedCandidateId: decision.selectedCandidate?.id ?? null,
      resolverTopCandidates: JSON.stringify(topCandidates)
    }
  };
}

function resolveStrict(scoredCandidates: RankedCandidate[]): ResolutionDecision {
  const [best, second] = scoredCandidates;
  if (!best) {
    return {
      mode: "strict",
      code: "strict_unresolved_no_candidates",
      confidenceBand: "low",
      confidence: 0,
      candidateCount: 0
    };
  }

  if (!second || compareCandidateScore(best.score, second.score) > 0) {
    return {
      mode: "strict",
      code: "strict_resolved",
      confidenceBand: "high",
      confidence: 1,
      selectedCandidate: best.candidate,
      candidateCount: scoredCandidates.length
    };
  }

  return {
    mode: "strict",
    code: "strict_unresolved_tie",
    confidenceBand: "low",
    confidence: 0,
    candidateCount: scoredCandidates.length
  };
}

function resolveRanked(scoredCandidates: RankedCandidate[], policy: EffectiveResolverPolicy): ResolutionDecision {
  const [best, second] = scoredCandidates;
  if (!best) {
    return {
      mode: "ranked",
      code: "ranked_no_candidates",
      confidenceBand: "low",
      confidence: 0,
      candidateCount: 0
    };
  }
  const confidence = computeConfidence(best, second, policy);
  const hasDistinctBest = !second || compareCandidateScore(best.score, second.score) > 0;
  if (confidence.band === "high" && hasDistinctBest) {
    return {
      mode: "ranked",
      code: "ranked_auto_resolved",
      confidenceBand: confidence.band,
      confidence: confidence.confidence,
      selectedCandidate: best.candidate,
      candidateCount: scoredCandidates.length
    };
  }
  if (confidence.band === "medium") {
    return {
      mode: "ranked",
      code: "ranked_candidates_only",
      confidenceBand: confidence.band,
      confidence: confidence.confidence,
      candidateCount: scoredCandidates.length
    };
  }
  return {
    mode: "ranked",
    code: "ranked_low_confidence",
    confidenceBand: confidence.band,
    confidence: confidence.confidence,
    candidateCount: scoredCandidates.length
  };
}

function resolveExternalTargets(
  nodes: GraphNode[],
  edges: GraphEdge[],
  resolverPolicy?: ResolverPolicyOptions
): GraphEdge[] {
  const policy = normalizeResolverPolicy(resolverPolicy);
  const indexes = buildResolverIndexes(nodes, edges);

  return edges.map((edge) => {
    if ((edge.type !== EdgeKind.Calls && edge.type !== EdgeKind.DependsOn) || !edge.to.startsWith("external:")) {
      return edge;
    }

    const context = collectCandidatesForEdge(edge, indexes);
    const scoredCandidates = scoreCandidatesForEdge(edge, context);
    const modeForEdge: ResolverMode = isRankedLanguageEligible(edge, indexes.nodeById, policy) ? "ranked" : "strict";
    const decision = modeForEdge === "ranked" ? resolveRanked(scoredCandidates, policy) : resolveStrict(scoredCandidates);
    const withMetadata = attachResolutionMetadata(edge, decision, scoredCandidates, policy);
    if (decision.selectedCandidate) {
      return {
        ...withMetadata,
        to: decision.selectedCandidate.id
      };
    }
    return withMetadata;
  });
}

export function buildGraphDocument(
  repoPath: string,
  scannedFiles: ScannedFile[],
  outputs: AdapterOutput[],
  resolverPolicy?: ResolverPolicyOptions
): GraphDocument {
  const repoId = repoNodeId(repoPath);
  const nodes: GraphNode[] = [
    {
      id: repoId,
      kind: NodeKind.Repository,
      name: repoPath,
      metadata: {
        schemaVersion: GRAPH_SCHEMA_VERSION
      }
    }
  ];
  const edges: GraphEdge[] = [];

  for (const output of outputs) {
    nodes.push(...output.nodes);
    edges.push(...output.edges);
  }

  for (const file of scannedFiles) {
    edges.push({
      type: EdgeKind.Contains,
      from: repoId,
      to: fileNodeId(file.relativePath),
      filePath: file.relativePath
    });
  }

  const mergedNodes = mergeNodes(nodes);
  const mergedEdges = mergeEdges(edges);
  const resolvedEdges = resolveExternalTargets(mergedNodes, mergedEdges, resolverPolicy);

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes: mergedNodes,
    edges: mergeEdges(resolvedEdges)
  };
}
