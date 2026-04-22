export const GRAPH_SCHEMA_VERSION = "1.0.0";

export type Primitive = string | number | boolean | null;
export type Metadata = Record<string, Primitive>;

export enum CodeLanguage {
  TypeScript = "typescript",
  JavaScript = "javascript",
  CSharp = "csharp",
  Unknown = "unknown"
}

export enum NodeKind {
  Repository = "repository",
  File = "file",
  Module = "module",
  Symbol = "symbol",
  External = "external"
}

export enum EdgeKind {
  Contains = "contains",
  Defines = "defines",
  Imports = "imports",
  Calls = "calls",
  DependsOn = "depends_on"
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  language?: CodeLanguage;
  filePath?: string;
  sourceHash?: string;
  signature?: string;
  metadata?: Metadata;
}

export interface GraphEdge {
  type: EdgeKind;
  from: string;
  to: string;
  filePath?: string;
  line?: number;
  metadata?: Metadata;
}

export interface GraphDocument {
  schemaVersion: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  language: CodeLanguage;
  contentHash: string;
  content: string;
}

export interface AdapterOutput {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function repoNodeId(repoPath: string): string {
  return `repo:${normalizePath(repoPath)}`;
}

export function fileNodeId(relativePath: string): string {
  return `file:${normalizePath(relativePath)}`;
}

export function symbolNodeId(relativePath: string, symbolName: string, position: number): string {
  return `symbol:${normalizePath(relativePath)}#${symbolName}@${position}`;
}

export function moduleNodeId(moduleName: string): string {
  return `module:${moduleName}`;
}

export function externalNodeId(name: string): string {
  return `external:${name}`;
}
