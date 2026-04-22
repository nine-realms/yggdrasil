import { promises as fs } from "node:fs";
import path from "node:path";
import { QueryCommandOptions, resolveRepoPath, resolveStoragePaths } from "../config.js";
import { createGraphStore } from "../graph/graph-store.js";
import { GraphDocument, GraphEdge, GraphNode } from "../types/graph.js";

export interface VisualizationNode {
  id: string;
  name: string;
  kind: string;
  language?: string;
  filePath?: string;
  degree: number;
}

export interface VisualizationEdge {
  source: string;
  target: string;
  type: string;
  filePath?: string;
  line?: number;
}

export interface VisualizationPayload {
  metadata: {
    schemaVersion: string;
    generatedAt: string;
    truncated: boolean;
    totalNodeCount: number;
    totalEdgeCount: number;
    renderedNodeCount: number;
    renderedEdgeCount: number;
  };
  focusNodeIds: string[];
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
}

export interface RenderGraphPageCommand extends QueryCommandOptions {
  outputPath?: string;
  maxNodes: number;
  queryApiBase?: string;
  embedAllNodes?: boolean;
}

export interface RenderGraphPageResult {
  repoPath: string;
  storeDir: string;
  outputPath: string;
  totalNodeCount: number;
  totalEdgeCount: number;
  renderedNodeCount: number;
  renderedEdgeCount: number;
  truncated: boolean;
}

function clampInteger(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  const value = Math.trunc(raw);
  return Math.max(min, Math.min(max, value));
}

function buildDegreeIndex(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const degreeByNode = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degreeByNode.set(edge.from, (degreeByNode.get(edge.from) ?? 0) + 1);
    degreeByNode.set(edge.to, (degreeByNode.get(edge.to) ?? 0) + 1);
  }
  return degreeByNode;
}

export function sampleGraph(
  graph: GraphDocument,
  maxNodes: number,
  embedAllNodes = true
): VisualizationPayload {
  const boundedMaxNodes = clampInteger(maxNodes, 25, 5000, 400);
  const degreeByNode = buildDegreeIndex(graph.nodes, graph.edges);
  const sortedNodes = [...graph.nodes].sort((left, right) => {
    const degreeDelta = (degreeByNode.get(right.id) ?? 0) - (degreeByNode.get(left.id) ?? 0);
    if (degreeDelta !== 0) {
      return degreeDelta;
    }
    return left.id.localeCompare(right.id);
  });

  const focusNodes = sortedNodes.slice(0, boundedMaxNodes);
  const focusNodeIds = focusNodes.map((node) => node.id);
  const focusNodeIdSet = new Set(focusNodeIds);
  const focusEdges = graph.edges.filter(
    (edge) => focusNodeIdSet.has(edge.from) && focusNodeIdSet.has(edge.to)
  );

  return {
    metadata: {
      schemaVersion: graph.schemaVersion,
      generatedAt: new Date().toISOString(),
      truncated: focusNodes.length < graph.nodes.length,
      totalNodeCount: graph.nodes.length,
      totalEdgeCount: graph.edges.length,
      renderedNodeCount: focusNodes.length,
      renderedEdgeCount: focusEdges.length
    },
    focusNodeIds,
    nodes: (embedAllNodes ? graph.nodes : focusNodes).map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      language: node.language,
      filePath: node.filePath,
      degree: degreeByNode.get(node.id) ?? 0
    })),
    edges: (embedAllNodes ? graph.edges : focusEdges).map((edge) => ({
      source: edge.from,
      target: edge.to,
      type: edge.type,
      filePath: edge.filePath,
      line: edge.line
    }))
  };
}

export function buildHtml(
  payload: VisualizationPayload,
  options: { queryApiBase?: string } = {}
): string {
  const serialized = JSON.stringify(payload).replace(/</g, "\\u003c");
  const queryApiBase = JSON.stringify(options.queryApiBase ?? "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Yggdrasil Graph Viewer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f111a;
      --surface: #1a1d2a;
      --surface-border: #2c3144;
      --text: #eef1ff;
      --muted: #a8b0d0;
      --accent: #7aa2ff;
      --danger: #ff7a90;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.4 Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .layout {
      --sidebar-width: clamp(400px, 34vw, 560px);
      --details-height: minmax(220px, 36vh);
      height: 100vh;
      display: grid;
      grid-template-columns: var(--sidebar-width) 8px minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) 8px var(--details-height);
    }
    .sidebar {
      grid-column: 1;
      grid-row: 1 / 4;
      border-right: 1px solid var(--surface-border);
      background: var(--surface);
      padding: 16px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .resizer {
      background: rgba(255, 255, 255, 0.05);
      position: relative;
      z-index: 3;
      touch-action: none;
      user-select: none;
    }
    .resizer::after {
      content: "";
      position: absolute;
      inset: 0;
      background: transparent;
      transition: background 120ms ease-out;
    }
    .resizer:hover::after,
    .resizer.active::after {
      background: rgba(122, 162, 255, 0.35);
    }
    .resizer-vertical {
      grid-column: 2;
      grid-row: 1 / 4;
      cursor: col-resize;
    }
    .resizer-horizontal {
      grid-column: 3;
      grid-row: 2;
      cursor: row-resize;
    }
    body.resizing-col {
      cursor: col-resize;
      user-select: none;
    }
    body.resizing-row {
      cursor: row-resize;
      user-select: none;
    }
    .panel {
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.02);
    }
    .title {
      margin: 0 0 8px 0;
      font-size: 16px;
      color: var(--accent);
    }
    .stat {
      display: flex;
      justify-content: space-between;
      margin: 4px 0;
    }
    .muted { color: var(--muted); }
    .warning {
      color: var(--danger);
      font-weight: 600;
    }
    .controls { display: grid; gap: 10px; }
    .control-group { display: grid; gap: 4px; }
    .control-label { color: var(--muted); font-size: 12px; }
    .search,
    .select {
      width: 100%;
      border: 1px solid var(--surface-border);
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
      background: #0f1322;
    }
    .hint { margin-top: 8px; font-size: 12px; color: var(--muted); }
    .checkbox-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 8px;
      max-height: 132px;
      overflow: auto;
      border: 1px solid var(--surface-border);
      border-radius: 6px;
      padding: 8px;
      background: #0f1322;
    }
    .checkbox-grid label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text);
    }
    .button-row { display: flex; gap: 8px; }
    .button-row.wrap { flex-wrap: wrap; }
    .button-row.wrap button { flex: 1 1 auto; min-width: 130px; }
    .status-line {
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
      min-height: 16px;
    }
    .query-results {
      margin: 8px 0 0 0;
      min-height: 72px;
      max-height: 200px;
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid var(--surface-border);
      border-radius: 6px;
      padding: 8px;
      background: #0f1322;
      font-size: 12px;
      line-height: 1.35;
      color: var(--text);
    }
    .legend-section { margin-top: 8px; }
    .legend-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 10px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text);
      min-width: 0;
    }
    .legend-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .legend-swatch {
      display: inline-block;
      flex: 0 0 auto;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .legend-swatch.node {
      width: 11px;
      height: 11px;
      border-radius: 50%;
    }
    .legend-swatch.edge {
      width: 16px;
      height: 4px;
      border-radius: 3px;
    }
    button {
      border: 1px solid var(--surface-border);
      border-radius: 6px;
      padding: 7px 10px;
      color: var(--text);
      background: #121a32;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    .details {
      white-space: pre-wrap;
      margin: 0;
      color: var(--text);
      font-size: 12px;
      line-height: 1.35;
      overflow: auto;
      overflow-wrap: anywhere;
      word-break: break-word;
      flex: 1 1 auto;
      min-height: 0;
    }
    .canvas-wrap {
      grid-column: 3;
      grid-row: 1;
      position: relative;
      overflow: hidden;
      min-height: 0;
    }
    .details-dock {
      grid-column: 3;
      grid-row: 3;
      background: var(--surface);
      border-top: 1px solid var(--surface-border);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    #graph {
      width: 100%;
      height: 100%;
      display: block;
      background: radial-gradient(circle at center, #161b2b 0%, #0d1018 100%);
      cursor: grab;
    }
    #graph.panning { cursor: grabbing; }
    .edge { stroke-width: 1; stroke-opacity: 0.24; }
    .node { stroke: #f8fbff; stroke-width: 1.2; cursor: pointer; }
    .node.selected { stroke-width: 2.8; }
    .node.query-highlight { stroke: #ffd166; stroke-width: 3.4; }
    .label {
      fill: #d8e0ff;
      font-size: 10px;
      pointer-events: none;
      text-shadow: 0 1px 2px rgba(0,0,0,0.7);
    }
    .hover-popover {
      position: fixed;
      z-index: 40;
      max-width: 340px;
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 8px 10px;
      background: rgba(15, 19, 34, 0.96);
      color: var(--text);
      font-size: 12px;
      line-height: 1.35;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      pointer-events: none;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
      opacity: 0;
      transform: translateY(2px);
      transition: opacity 80ms ease-out, transform 80ms ease-out;
    }
    .hover-popover.visible {
      opacity: 1;
      transform: translateY(0);
    }
    @media (max-width: 980px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: auto 1fr minmax(180px, 40vh);
      }
      .sidebar {
        grid-column: 1;
        grid-row: 1;
        border-right: 0;
        border-bottom: 1px solid var(--surface-border);
      }
      .resizer {
        display: none;
      }
      .canvas-wrap {
        grid-column: 1;
        grid-row: 2;
      }
      .details-dock {
        grid-column: 1;
        grid-row: 3;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="panel">
        <h1 class="title">Yggdrasil Graph Viewer</h1>
        <div class="stat"><span class="muted">Schema</span><span id="schema-version"></span></div>
        <div class="stat"><span class="muted">Nodes</span><span id="node-count"></span></div>
        <div class="stat"><span class="muted">Edges</span><span id="edge-count"></span></div>
        <div class="stat"><span class="muted">Rendered nodes</span><span id="rendered-node-count"></span></div>
        <div class="stat"><span class="muted">Rendered edges</span><span id="rendered-edge-count"></span></div>
        <div class="stat"><span class="muted">Visible nodes</span><span id="visible-node-count"></span></div>
        <div class="stat"><span class="muted">Visible edges</span><span id="visible-edge-count"></span></div>
        <div id="truncated-flag" class="warning" hidden>Large graph detected: showing sampled nodes.</div>
      </div>
      <div class="panel">
        <div class="controls">
          <div class="control-group">
            <label for="view-select" class="control-label">View</label>
            <select id="view-select" class="select">
              <option value="code">Code graph</option>
              <option value="module">Module dependency map</option>
            </select>
          </div>
          <div class="control-group">
            <label for="layout-select" class="control-label">Layout</label>
            <select id="layout-select" class="select">
              <option value="auto">Auto</option>
              <option value="force">Force</option>
              <option value="flow">Flow (hierarchical)</option>
            </select>
          </div>
          <div class="control-group">
            <label for="depth-select" class="control-label">Selection depth</label>
            <select id="depth-select" class="select">
              <option value="0">Connected component</option>
              <option value="1">1 hop from selected</option>
              <option value="2">2 hops from selected</option>
              <option value="3">3 hops from selected</option>
            </select>
          </div>
          <div class="control-group">
            <label for="search-input" class="control-label">Search (name, id, file path)</label>
            <input id="search-input" class="search" type="text" placeholder="processOrder, src/order.ts, symbol:..." />
          </div>
          <div class="control-group">
            <span class="control-label">Node kinds</span>
            <div id="kind-filters" class="checkbox-grid"></div>
          </div>
          <div class="control-group">
            <span class="control-label">Edge types</span>
            <div id="edge-filters" class="checkbox-grid"></div>
          </div>
          <div class="control-group">
            <span class="control-label">Languages</span>
            <div id="language-filters" class="checkbox-grid"></div>
          </div>
          <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
            <input id="include-external" type="checkbox" checked />
            Include external symbols
          </label>
          <div class="button-row">
            <button id="relayout-button" type="button">Re-layout</button>
            <button id="fit-button" type="button">Fit view</button>
          </div>
        </div>
        <div class="hint">
          Click a node to focus connections. Use <strong>Module dependency map</strong> to collapse detail by module.
        </div>
      </div>
      <div class="panel">
        <h2 class="title" style="font-size: 14px;">Local graph queries</h2>
        <div class="controls">
          <div class="control-group">
            <label for="query-symbol-input" class="control-label">Symbol</label>
            <input id="query-symbol-input" class="search" type="text" placeholder="processOrder" />
          </div>
          <div class="button-row wrap">
            <button id="query-symbol-references-button" type="button">Symbol references</button>
            <button id="query-symbol-neighborhood-button" type="button">Symbol neighborhood</button>
            <button id="query-selected-related-button" type="button">Related to selected</button>
            <button id="query-clear-button" type="button">Clear highlight</button>
          </div>
          <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
            <input id="query-filter-results" type="checkbox" checked />
            Filter graph to query results
          </label>
          <div id="query-status-line" class="status-line">Run local queries against the loaded graph snapshot.</div>
          <pre id="query-results" class="query-results muted">No local query executed yet.</pre>
        </div>
      </div>
      <div class="panel">
        <h2 class="title" style="font-size: 14px;">Legend</h2>
        <div class="legend-section">
          <div class="control-label">Node colors</div>
          <div id="node-legend" class="legend-list"></div>
        </div>
        <div class="legend-section">
          <div class="control-label">Edge colors</div>
          <div id="edge-legend" class="legend-list"></div>
        </div>
      </div>
    </aside>
    <div
      id="sidebar-resizer"
      class="resizer resizer-vertical"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
    ></div>
    <main class="canvas-wrap">
      <svg id="graph" viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid meet" aria-label="Graph visualization">
        <g id="edge-layer"></g>
        <g id="node-layer"></g>
        <g id="label-layer"></g>
      </svg>
    </main>
    <div
      id="details-resizer"
      class="resizer resizer-horizontal"
      role="separator"
      aria-label="Resize selected node panel"
      aria-orientation="horizontal"
    ></div>
    <section class="details-dock">
      <h2 class="title" style="font-size: 14px;">Selected node</h2>
      <pre id="details" class="details muted">No node selected.</pre>
    </section>
  </div>
  <div id="hover-popover" class="hover-popover" aria-hidden="true"></div>
  <script>
    const graphData = ${serialized};
    const queryApiBase = ${queryApiBase};

    const WIDTH = 1400;
    const HEIGHT = 900;
    const MIN_VIEWPORT_WIDTH = WIDTH * 0.1;
    const MIN_VIEWPORT_HEIGHT = HEIGHT * 0.1;
    const MAX_VIEWPORT_WIDTH = WIDTH * 10;
    const MAX_VIEWPORT_HEIGHT = HEIGHT * 10;
    const SIDEBAR_MIN_WIDTH = 400;
    const SIDEBAR_MAX_WIDTH = 560;
    const DETAILS_MIN_HEIGHT = 220;
    const DETAILS_MAX_HEIGHT_FACTOR = 0.36;
    const MOBILE_BREAKPOINT_QUERY = '(max-width: 980px)';

    const KIND_COLORS = {
      repository: '#f9c74f',
      file: '#43aa8b',
      module: '#4cc9f0',
      symbol: '#7b8cff',
      external: '#f9844a'
    };
    const EDGE_COLORS = {
      contains: '#8bd3dd',
      defines: '#80ffdb',
      imports: '#ffd166',
      calls: '#ff8fab',
      depends_on: '#cdb4db'
    };

    function hashString(value) {
      let hash = 0;
      for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
      }
      return Math.abs(hash);
    }

    function uniqueSorted(values) {
      return [...new Set(values)].sort((left, right) => left.localeCompare(right));
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function toDisplayLabel(value) {
      const withSpaces = String(value).replace(/_/g, ' ');
      return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
    }

    function renderLegend(container, entries, kind) {
      container.innerHTML = entries
        .map(
          ([name, color]) =>
            '<div class="legend-item">' +
            '<span class="legend-swatch ' +
            kind +
            '" style="background:' +
            color +
            ';"></span>' +
            '<span class="legend-text">' +
            toDisplayLabel(name) +
            '</span>' +
            '</div>'
        )
        .join('');
    }

    function moduleKeyFromPath(filePath) {
      if (!filePath) {
        return '(virtual)';
      }
      const normalized = String(filePath).replace(/\\\\/g, '/');
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length <= 1) {
        return '(root)';
      }
      return parts[0];
    }

    function buildModuleGraph(nodes, edges) {
      const moduleByNodeId = new Map(nodes.map((node) => [node.id, moduleKeyFromPath(node.filePath)]));
      const moduleNames = uniqueSorted([...moduleByNodeId.values()]);
      const moduleNodes = moduleNames.map((moduleName) => ({
        id: 'module:' + moduleName,
        name: moduleName,
        kind: 'module',
        language: '',
        filePath: '',
        degree: 0,
        module: moduleName
      }));
      const byId = new Map(moduleNodes.map((node) => [node.id, node]));
      const edgeMap = new Map();
      let edgeIndex = 0;
      for (const edge of edges) {
        const sourceModule = moduleByNodeId.get(edge.source);
        const targetModule = moduleByNodeId.get(edge.target);
        if (!sourceModule || !targetModule) {
          continue;
        }
        const key = sourceModule + '|' + targetModule + '|' + edge.type;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.weight += 1;
          continue;
        }
        edgeIndex += 1;
        edgeMap.set(key, {
          id: 'module-edge:' + edgeIndex,
          source: 'module:' + sourceModule,
          target: 'module:' + targetModule,
          type: edge.type,
          filePath: '',
          line: 0,
          weight: 1
        });
      }
      const moduleEdges = [...edgeMap.values()];
      for (const edge of moduleEdges) {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        if (source) {
          source.degree += edge.weight;
        }
        if (target) {
          target.degree += edge.weight;
        }
      }
      return { nodes: moduleNodes, edges: moduleEdges };
    }

    function buildAdjacency(edges) {
      const adjacency = new Map();
      for (const edge of edges) {
        if (!adjacency.has(edge.source)) {
          adjacency.set(edge.source, new Set());
        }
        if (!adjacency.has(edge.target)) {
          adjacency.set(edge.target, new Set());
        }
        adjacency.get(edge.source).add(edge.target);
        adjacency.get(edge.target).add(edge.source);
      }
      return adjacency;
    }

    function buildForceLayout(nodes) {
      const kinds = [...new Set(nodes.map((node) => node.kind))];
      const kindIndex = new Map(kinds.map((kind, index) => [kind, index]));
      const radiusStep = Math.max(60, Math.min(WIDTH, HEIGHT) * 0.34 / Math.max(kinds.length, 1));
      const centerX = WIDTH / 2;
      const centerY = HEIGHT / 2;
      const positions = new Map();

      nodes.forEach((node, index) => {
        const ring = kindIndex.get(node.kind) || 0;
        const angle = ((hashString(node.id) % 360) * Math.PI) / 180 + ((index % 17) / 17) * 0.4;
        const jitter = ((hashString(node.id + ':jitter') % 100) / 100 - 0.5) * radiusStep * 0.4;
        const radius = 90 + ring * radiusStep + jitter;
        positions.set(node.id, {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius
        });
      });

      return positions;
    }

    function buildFlowLayout(nodes, edges) {
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const indegree = new Map(nodes.map((node) => [node.id, 0]));
      const outgoing = new Map(nodes.map((node) => [node.id, []]));

      for (const edge of edges) {
        if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
          continue;
        }
        indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
        outgoing.get(edge.source).push(edge.target);
      }

      const queue = [];
      indegree.forEach((value, key) => {
        if (value === 0) {
          queue.push(key);
        }
      });
      if (queue.length === 0) {
        queue.push(...nodes.map((node) => node.id));
      }

      const levelByNode = new Map();
      while (queue.length > 0) {
        const current = queue.shift();
        const currentLevel = levelByNode.get(current) || 0;
        for (const next of outgoing.get(current) || []) {
          const nextLevel = Math.max(levelByNode.get(next) || 0, currentLevel + 1);
          levelByNode.set(next, nextLevel);
          indegree.set(next, (indegree.get(next) || 0) - 1);
          if ((indegree.get(next) || 0) <= 0) {
            queue.push(next);
          }
        }
      }
      nodes.forEach((node) => {
        if (!levelByNode.has(node.id)) {
          levelByNode.set(node.id, hashString(node.id) % 6);
        }
      });

      const levels = new Map();
      levelByNode.forEach((level, nodeId) => {
        if (!levels.has(level)) {
          levels.set(level, []);
        }
        levels.get(level).push(nodeId);
      });

      const sortedLevels = [...levels.keys()].sort((left, right) => left - right);
      const positions = new Map();
      const leftPad = 120;
      const rightPad = WIDTH - 120;
      const xStep = Math.max(140, (rightPad - leftPad) / Math.max(sortedLevels.length - 1, 1));

      sortedLevels.forEach((level, index) => {
        const nodeIds = levels.get(level).sort((left, right) => left.localeCompare(right));
        const yStep = (HEIGHT - 180) / Math.max(nodeIds.length - 1, 1);
        nodeIds.forEach((nodeId, yIndex) => {
          positions.set(nodeId, {
            x: leftPad + index * xStep,
            y: 90 + yIndex * yStep
          });
        });
      });

      return positions;
    }

    function renderCheckboxes(container, values, key) {
      container.innerHTML = values
        .map(
          (value) =>
            '<label><input type="checkbox" data-' +
            key +
            '="' +
            value +
            '" checked />' +
            value +
            '</label>'
        )
        .join('');
    }

    function selectedValues(container, attribute) {
      const checked = container.querySelectorAll('input[type="checkbox"]:checked');
      const values = new Set();
      checked.forEach((input) => {
        values.add(input.getAttribute(attribute) || '');
      });
      return values;
    }

    function makeSelectionSet(selectedNodeId, depth, adjacency) {
      if (!selectedNodeId) {
        return null;
      }
      if (!adjacency.has(selectedNodeId)) {
        return new Set([selectedNodeId]);
      }

      const visited = new Set([selectedNodeId]);
      let frontier = [selectedNodeId];
      if (depth <= 0) {
        while (frontier.length > 0) {
          const next = [];
          for (const current of frontier) {
            for (const neighbor of adjacency.get(current) || []) {
              if (!visited.has(neighbor)) {
                visited.add(neighbor);
                next.push(neighbor);
              }
            }
          }
          frontier = next;
        }
        return visited;
      }

      for (let level = 0; level < depth; level += 1) {
        const next = [];
        for (const current of frontier) {
          for (const neighbor of adjacency.get(current) || []) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              next.push(neighbor);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) {
          break;
        }
      }
      return visited;
    }

    function formatNodeDetails(node, neighbors, view) {
      return [
        'name: ' + node.name,
        'id: ' + node.id,
        'view: ' + view,
        'kind: ' + node.kind,
        'language: ' + (node.language || '-'),
        'filePath: ' + (node.filePath || '-'),
        'degree: ' + (node.degree || 0),
        'neighbors: ' + neighbors
      ].join('\\n');
    }

    function formatNodePreview(node, neighbors, view) {
      return [
        node.name,
        'kind: ' + node.kind + ' · view: ' + view,
        'file: ' + (node.filePath || '-'),
        'language: ' + (node.language || '-'),
        'neighbors: ' + neighbors
      ].join('\\n');
    }

    function normalizeFilePath(filePath) {
      return String(filePath || '').replace(/\\\\/g, '/').replace(/^\\.\\//, '');
    }

    function init() {
      const metadata = graphData.metadata;
      const rawCodeNodes = graphData.nodes;
      const rawCodeEdges = graphData.edges.map((edge, index) => ({
        ...edge,
        id: 'edge:code:' + (index + 1),
        weight: 1
      }));
      const initialFocusNodeIds = new Set(
        Array.isArray(graphData.focusNodeIds)
          ? graphData.focusNodeIds.filter((value) => typeof value === 'string')
          : []
      );
      const moduleGraph = buildModuleGraph(rawCodeNodes, rawCodeEdges);

      const schemaVersion = document.getElementById('schema-version');
      const nodeCount = document.getElementById('node-count');
      const edgeCount = document.getElementById('edge-count');
      const renderedNodeCount = document.getElementById('rendered-node-count');
      const renderedEdgeCount = document.getElementById('rendered-edge-count');
      const visibleNodeCount = document.getElementById('visible-node-count');
      const visibleEdgeCount = document.getElementById('visible-edge-count');
      const truncatedFlag = document.getElementById('truncated-flag');

      schemaVersion.textContent = metadata.schemaVersion;
      nodeCount.textContent = String(metadata.totalNodeCount);
      edgeCount.textContent = String(metadata.totalEdgeCount);
      renderedNodeCount.textContent = String(metadata.renderedNodeCount);
      renderedEdgeCount.textContent = String(metadata.renderedEdgeCount);
      if (metadata.truncated) {
        truncatedFlag.hidden = false;
      }

      const viewSelect = document.getElementById('view-select');
      const layoutSelect = document.getElementById('layout-select');
      const depthSelect = document.getElementById('depth-select');
      const searchInput = document.getElementById('search-input');
      const includeExternal = document.getElementById('include-external');
      const relayoutButton = document.getElementById('relayout-button');
      const fitButton = document.getElementById('fit-button');
      const kindFilters = document.getElementById('kind-filters');
      const edgeFilters = document.getElementById('edge-filters');
      const languageFilters = document.getElementById('language-filters');
      const nodeLegend = document.getElementById('node-legend');
      const edgeLegend = document.getElementById('edge-legend');
      const details = document.getElementById('details');
      const querySymbolInput = document.getElementById('query-symbol-input');
      const querySymbolReferencesButton = document.getElementById('query-symbol-references-button');
      const querySymbolNeighborhoodButton = document.getElementById('query-symbol-neighborhood-button');
      const querySelectedRelatedButton = document.getElementById('query-selected-related-button');
      const queryClearButton = document.getElementById('query-clear-button');
      const queryFilterResults = document.getElementById('query-filter-results');
      const queryStatusLine = document.getElementById('query-status-line');
      const queryResults = document.getElementById('query-results');
      const hoverPopover = document.getElementById('hover-popover');
      const svg = document.getElementById('graph');
      const layout = document.querySelector('.layout');
      const sidebar = document.querySelector('.sidebar');
      const detailsDock = document.querySelector('.details-dock');
      const sidebarResizer = document.getElementById('sidebar-resizer');
      const detailsResizer = document.getElementById('details-resizer');
      const edgeLayer = document.getElementById('edge-layer');
      const nodeLayer = document.getElementById('node-layer');
      const labelLayer = document.getElementById('label-layer');
      const defaultViewport = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
      let viewport = { ...defaultViewport };

      function applyViewport() {
        svg.setAttribute(
          'viewBox',
          viewport.x + ' ' + viewport.y + ' ' + viewport.width + ' ' + viewport.height
        );
      }

      function resetViewport() {
        viewport = { ...defaultViewport };
        applyViewport();
      }

      function clientToGraphPoint(clientX, clientY) {
        const rect = svg.getBoundingClientRect();
        const normalizedX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
        const normalizedY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;

        return {
          x: viewport.x + normalizedX * viewport.width,
          y: viewport.y + normalizedY * viewport.height
        };
      }

      function zoomAt(clientX, clientY, zoomFactor) {
        const point = clientToGraphPoint(clientX, clientY);
        const nextWidth = clamp(
          viewport.width * zoomFactor,
          MIN_VIEWPORT_WIDTH,
          MAX_VIEWPORT_WIDTH
        );
        const nextHeight = clamp(
          viewport.height * zoomFactor,
          MIN_VIEWPORT_HEIGHT,
          MAX_VIEWPORT_HEIGHT
        );
        const widthRatio = nextWidth / viewport.width;
        const heightRatio = nextHeight / viewport.height;

        viewport = {
          x: point.x - (point.x - viewport.x) * widthRatio,
          y: point.y - (point.y - viewport.y) * heightRatio,
          width: nextWidth,
          height: nextHeight
        };

        applyViewport();
      }

      const knownKinds = uniqueSorted(rawCodeNodes.map((node) => node.kind));
      const knownEdgeTypes = uniqueSorted(rawCodeEdges.map((edge) => edge.type));
      const knownLanguages = uniqueSorted(
        rawCodeNodes
          .map((node) => node.language || '')
          .filter((language) => language.length > 0)
      );

      renderCheckboxes(kindFilters, knownKinds, 'kind');
      renderCheckboxes(edgeFilters, knownEdgeTypes, 'edge');
      renderCheckboxes(languageFilters, knownLanguages, 'language');
      renderLegend(nodeLegend, Object.entries(KIND_COLORS), 'node');
      renderLegend(edgeLegend, Object.entries(EDGE_COLORS), 'edge');

      let selectedNodeId = null;
      let queryHighlightedNodeIds = new Set();
      let queryResultNodeIds = null;
      let queryResultGraph = null;
      let queryFilterToResults = Boolean(queryFilterResults.checked);
      let renderToken = 0;
      let isPanning = false;
      let panStartClientX = 0;
      let panStartClientY = 0;
      let panStartViewport = { ...viewport };
      let suppressSvgClick = false;
      let activeResize = null;

      function isDesktopLayout() {
        return !window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
      }

      function detailsMaxHeight() {
        return Math.max(DETAILS_MIN_HEIGHT, Math.round(window.innerHeight * DETAILS_MAX_HEIGHT_FACTOR));
      }

      function setSidebarWidth(width) {
        const clampedWidth = clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
        layout.style.setProperty('--sidebar-width', clampedWidth + 'px');
      }

      function setDetailsHeight(height) {
        const clampedHeight = clamp(height, DETAILS_MIN_HEIGHT, detailsMaxHeight());
        layout.style.setProperty('--details-height', clampedHeight + 'px');
      }

      function beginResize(type, event) {
        if (event.button !== 0 || !isDesktopLayout()) {
          return;
        }

        const sidebarWidth = sidebar.getBoundingClientRect().width;
        const detailsHeight = detailsDock.getBoundingClientRect().height;
        const activeHandle = type === 'sidebar' ? sidebarResizer : detailsResizer;
        activeResize = {
          type,
          startClientX: event.clientX,
          startClientY: event.clientY,
          startSidebarWidth: sidebarWidth,
          startDetailsHeight: detailsHeight,
          pointerId: event.pointerId,
          handle: activeHandle
        };
        document.body.classList.add(type === 'sidebar' ? 'resizing-col' : 'resizing-row');
        activeHandle.classList.add('active');
        if (typeof activeHandle.setPointerCapture === 'function') {
          activeHandle.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
      }

      function updateResize(event) {
        if (!activeResize) {
          return;
        }
        if (!isDesktopLayout()) {
          endResize();
          return;
        }

        if (activeResize.type === 'sidebar') {
          const deltaX = event.clientX - activeResize.startClientX;
          setSidebarWidth(activeResize.startSidebarWidth + deltaX);
        } else {
          const deltaY = event.clientY - activeResize.startClientY;
          setDetailsHeight(activeResize.startDetailsHeight - deltaY);
        }
        event.preventDefault();
      }

      function endResize() {
        if (!activeResize) {
          return;
        }

        const activeHandle = activeResize.handle || (activeResize.type === 'sidebar' ? sidebarResizer : detailsResizer);
        if (
          typeof activeHandle.releasePointerCapture === 'function' &&
          Number.isInteger(activeResize.pointerId) &&
          (
            typeof activeHandle.hasPointerCapture !== 'function' ||
            activeHandle.hasPointerCapture(activeResize.pointerId)
          )
        ) {
          activeHandle.releasePointerCapture(activeResize.pointerId);
        }
        activeHandle.classList.remove('active');
        activeResize = null;
        document.body.classList.remove('resizing-col');
        document.body.classList.remove('resizing-row');
      }

      function syncResizableBounds() {
        if (!isDesktopLayout()) {
          endResize();
          return;
        }

        if (layout.style.getPropertyValue('--sidebar-width').trim().length > 0) {
          setSidebarWidth(sidebar.getBoundingClientRect().width);
        }
        if (layout.style.getPropertyValue('--details-height').trim().length > 0) {
          setDetailsHeight(detailsDock.getBoundingClientRect().height);
        }
      }

      function setHoverPopoverPosition(clientX, clientY) {
        const margin = 12;
        const rect = hoverPopover.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        const left = clamp(clientX + 14, margin, maxLeft);
        const top = clamp(clientY + 14, margin, maxTop);
        hoverPopover.style.left = left + 'px';
        hoverPopover.style.top = top + 'px';
      }

      function hideHoverPreview() {
        hoverPopover.classList.remove('visible');
        hoverPopover.setAttribute('aria-hidden', 'true');
      }

      function showHoverPreview(node, neighbors, clientX, clientY) {
        hoverPopover.textContent = formatNodePreview(node, neighbors, viewSelect.value);
        hoverPopover.setAttribute('aria-hidden', 'false');
        hoverPopover.classList.add('visible');
        setHoverPopoverPosition(clientX, clientY);
      }

      function beginPan(event) {
        if (event.button !== 0) {
          return;
        }

        isPanning = true;
        panStartClientX = event.clientX;
        panStartClientY = event.clientY;
        panStartViewport = { ...viewport };
        svg.classList.add('panning');
        hideHoverPreview();
        event.preventDefault();
      }

      function updatePan(event) {
        if (!isPanning) {
          return;
        }

        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return;
        }

        const deltaX = event.clientX - panStartClientX;
        const deltaY = event.clientY - panStartClientY;
        if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
          suppressSvgClick = true;
        }

        viewport = {
          x: panStartViewport.x - (deltaX * panStartViewport.width) / rect.width,
          y: panStartViewport.y - (deltaY * panStartViewport.height) / rect.height,
          width: panStartViewport.width,
          height: panStartViewport.height
        };
        applyViewport();
        event.preventDefault();
      }

      function endPan() {
        if (!isPanning) {
          return;
        }

        isPanning = false;
        svg.classList.remove('panning');
      }

      function getViewGraph() {
        if (viewSelect.value === 'module') {
          return moduleGraph;
        }
        if (queryFilterToResults && queryResultGraph) {
          return queryResultGraph;
        }
        return {
          nodes: rawCodeNodes,
          edges: rawCodeEdges
        };
      }

      function updateDetails(nodesById, adjacency) {
        if (!selectedNodeId || !nodesById.has(selectedNodeId)) {
          details.textContent = 'No node selected.';
          details.classList.add('muted');
          return;
        }
        const node = nodesById.get(selectedNodeId);
        const neighbors = adjacency.get(selectedNodeId) ? adjacency.get(selectedNodeId).size : 0;
        details.textContent = formatNodeDetails(node, neighbors, viewSelect.value);
        details.classList.remove('muted');
      }

      function setQueryStatus(message, isError) {
        queryStatusLine.textContent = message;
        queryStatusLine.style.color = isError ? '#ff7a90' : '';
      }

      function renderQueryResult(label, summary, files, nodeIds) {
        const lines = [label];
        lines.push('highlighted nodes: ' + nodeIds.length);
        lines.push('filter mode: ' + (queryFilterToResults ? 'results only' : 'highlight only'));
        if (summary && typeof summary === 'object') {
          Object.entries(summary).forEach(([key, value]) => {
            lines.push(key + ': ' + value);
          });
        }
        if (files.length > 0) {
          lines.push('files:');
          files.slice(0, 50).forEach((filePath) => lines.push('  - ' + filePath));
          if (files.length > 50) {
            lines.push('  ... and ' + (files.length - 50) + ' more');
          }
        }
        queryResults.textContent = lines.join('\\n');
        queryResults.classList.remove('muted');
      }

      const codeNodesById = new Map(rawCodeNodes.map((node) => [node.id, node]));
      const nonStructuralCodeEdges = rawCodeEdges.filter(
        (edge) => edge.type !== 'contains' && edge.type !== 'defines'
      );
      const adjacency = buildAdjacency(nonStructuralCodeEdges);

      function nodeFilePath(nodeId, fallback) {
        const fromNode = codeNodesById.get(nodeId);
        const pathValue = fromNode ? fromNode.filePath : fallback;
        return normalizeFilePath(pathValue);
      }

      function localSymbolMatches(symbolQuery) {
        const query = String(symbolQuery || '').trim().toLowerCase();
        if (query.length === 0) {
          return [];
        }
        const symbolNodes = rawCodeNodes.filter((node) => node.kind === 'symbol');
        const exactMatches = symbolNodes.filter((node) => {
          const name = String(node.name || '').toLowerCase();
          const id = String(node.id || '').toLowerCase();
          return name === query || id === query;
        });
        if (exactMatches.length > 0) {
          return exactMatches;
        }
        return symbolNodes.filter((node) => {
          const name = String(node.name || '').toLowerCase();
          const id = String(node.id || '').toLowerCase();
          return name.includes(query) || id.includes(query);
        });
      }

      function buildQueryGraphFromNodeIds(nodeIds) {
        const nodeIdSet = new Set(nodeIds);
        return {
          nodes: rawCodeNodes.filter((node) => nodeIdSet.has(node.id)),
          edges: rawCodeEdges.filter(
            (edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target)
          )
        };
      }

      function normalizeQueryGraph(graph) {
        if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
          return null;
        }
        return {
          nodes: graph.nodes.map((node) => ({
            id: String(node.id || ''),
            name: String(node.name || ''),
            kind: String(node.kind || 'symbol'),
            language: typeof node.language === 'string' ? node.language : '',
            filePath: typeof node.filePath === 'string' ? node.filePath : '',
            degree: Number.isFinite(Number(node.degree)) ? Number(node.degree) : 0
          })),
          edges: graph.edges.map((edge, index) => ({
            source: String(edge.source || ''),
            target: String(edge.target || ''),
            type: String(edge.type || 'depends_on'),
            filePath: typeof edge.filePath === 'string' ? edge.filePath : '',
            line: Number.isFinite(Number(edge.line)) ? Number(edge.line) : 0,
            id: 'edge:query:' + (index + 1),
            weight: 1
          }))
        };
      }

      function applyQueryResult(label, summary, nodeIds, explicitFiles, queryGraph) {
        queryHighlightedNodeIds = new Set(nodeIds);
        queryResultNodeIds = new Set(nodeIds);
        selectedNodeId = null;
        queryResultGraph = normalizeQueryGraph(queryGraph) || buildQueryGraphFromNodeIds(nodeIds);
        queryFilterToResults = true;
        queryFilterResults.checked = true;
        const files = uniqueSorted(
          (Array.isArray(explicitFiles) && explicitFiles.length > 0
            ? explicitFiles.map((filePath) => normalizeFilePath(filePath))
            : [...queryHighlightedNodeIds]
                .map((nodeId) => normalizeFilePath(codeNodesById.get(nodeId)?.filePath))
          ).filter((value) => value.length > 0)
        );
        renderQueryResult(label, summary, files, [...queryHighlightedNodeIds]);
        if (viewSelect.value !== 'code') {
          viewSelect.value = 'code';
        }
        rerender();
        setQueryStatus('Loaded ' + label + '. Highlighted nodes: ' + queryHighlightedNodeIds.size + '.', false);
      }

      function applyLocalHighlights(label, summary, nodeIds) {
        applyQueryResult(label, summary, nodeIds, null, null);
      }

      async function runBridgeQuery(type, params) {
        if (queryApiBase.length === 0) {
          return false;
        }

        const search = new URLSearchParams();
        Object.entries(params || {}).forEach(([key, value]) => {
          if (value === undefined || value === null) {
            return;
          }
          const normalized = String(value).trim();
          if (normalized.length === 0) {
            return;
          }
          search.set(key, normalized);
        });

        const root = queryApiBase.endsWith('/') ? queryApiBase.slice(0, -1) : queryApiBase;
        const querySuffix = search.toString();
        const url = root + '/query/' + type + (querySuffix.length > 0 ? '?' + querySuffix : '');
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('Bridge query failed with status ' + response.status + '.');
        }

        const payload = await response.json();
        const nodeIds = Array.isArray(payload.nodeIds) ? payload.nodeIds.map((value) => String(value)) : [];
        const files = Array.isArray(payload.files) ? payload.files.map((value) => String(value)) : [];
        const label = typeof payload.label === 'string' && payload.label.length > 0
          ? payload.label
          : 'Bridge query';
        const summary = payload.summary && typeof payload.summary === 'object'
          ? payload.summary
          : {};
        applyQueryResult(label, summary, nodeIds, files, payload.graph);
        return true;
      }

      async function runLocalSymbolReferences() {
        const symbol = String(querySymbolInput.value || '').trim();
        if (symbol.length === 0) {
          setQueryStatus('Enter a symbol to query references.', true);
          return;
        }
        setQueryStatus(queryApiBase.length > 0 ? 'Running bridge symbol references…' : 'Running local symbol references…', false);
        if (queryApiBase.length > 0) {
          try {
            await runBridgeQuery('symbol-references', { symbol });
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Bridge query failed.';
            setQueryStatus(message, true);
            return;
          }
        }
        const matches = localSymbolMatches(symbol);
        if (matches.length === 0) {
          setQueryStatus('No symbol matches found in the loaded graph snapshot.', true);
          return;
        }
        const targetIds = new Set(matches.map((node) => node.id));
        const referenceEdges = nonStructuralCodeEdges.filter((edge) => targetIds.has(edge.target));
        const highlightSet = new Set(matches.map((node) => node.id));
        referenceEdges.forEach((edge) => {
          highlightSet.add(edge.source);
          highlightSet.add(edge.target);
        });
        applyLocalHighlights('Local symbol references', {
          matchedSymbols: matches.length,
          references: referenceEdges.length
        }, [...highlightSet]);
      }

      async function runLocalSymbolNeighborhood(depth) {
        const symbol = String(querySymbolInput.value || '').trim();
        if (symbol.length === 0) {
          setQueryStatus('Enter a symbol to query neighborhood.', true);
          return;
        }
        setQueryStatus(queryApiBase.length > 0 ? 'Running bridge symbol neighborhood…' : 'Running local symbol neighborhood…', false);
        if (queryApiBase.length > 0) {
          try {
            await runBridgeQuery('symbol-neighborhood', { symbol, depth });
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Bridge query failed.';
            setQueryStatus(message, true);
            return;
          }
        }
        const matches = localSymbolMatches(symbol);
        if (matches.length === 0) {
          setQueryStatus('No symbol matches found in the loaded graph snapshot.', true);
          return;
        }

        const queue = matches.map((node) => ({ id: node.id, depth: 0 }));
        const visited = new Set(matches.map((node) => node.id));

        while (queue.length > 0) {
          const current = queue.shift();
          if (!current || current.depth >= depth) {
            continue;
          }
          for (const neighbor of adjacency.get(current.id) || []) {
            if (visited.has(neighbor)) {
              continue;
            }
            visited.add(neighbor);
            queue.push({ id: neighbor, depth: current.depth + 1 });
          }
        }

        const neighborhoodEdges = nonStructuralCodeEdges.filter(
          (edge) => visited.has(edge.source) && visited.has(edge.target)
        );
        applyLocalHighlights('Local symbol neighborhood', {
          seeds: matches.length,
          depth,
          nodes: visited.size,
          edges: neighborhoodEdges.length
        }, [...visited]);
      }

      async function runLocalReferencesForFile(filePath, direction) {
        const targetFilePath = normalizeFilePath(filePath);
        if (targetFilePath.length === 0) {
          setQueryStatus('Select a file-backed node first.', true);
          return;
        }

        setQueryStatus(queryApiBase.length > 0 ? 'Running bridge file references…' : 'Running local file references…', false);
        if (queryApiBase.length > 0) {
          try {
            await runBridgeQuery('references-for-file', {
              filePath: targetFilePath,
              direction
            });
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Bridge query failed.';
            setQueryStatus(message, true);
            return;
          }
        }
        const relatedFiles = new Set([targetFilePath]);
        const highlightSet = new Set(
          rawCodeNodes
            .filter((node) => normalizeFilePath(node.filePath) === targetFilePath)
            .map((node) => node.id)
        );

        nonStructuralCodeEdges.forEach((edge) => {
          const sourcePath = nodeFilePath(edge.source, edge.filePath);
          const targetPath = nodeFilePath(edge.target, edge.filePath);
          const outboundMatch =
            sourcePath === targetFilePath && targetPath.length > 0 && targetPath !== targetFilePath;
          const inboundMatch =
            targetPath === targetFilePath && sourcePath.length > 0 && sourcePath !== targetFilePath;
          const include =
            direction === 'both' ? outboundMatch || inboundMatch :
            direction === 'outbound' ? outboundMatch :
            inboundMatch;
          if (!include) {
            return;
          }
          if (sourcePath.length > 0) {
            relatedFiles.add(sourcePath);
          }
          if (targetPath.length > 0) {
            relatedFiles.add(targetPath);
          }
          highlightSet.add(edge.source);
          highlightSet.add(edge.target);
        });

        rawCodeNodes.forEach((node) => {
          const normalizedPath = normalizeFilePath(node.filePath);
          if (relatedFiles.has(normalizedPath)) {
            highlightSet.add(node.id);
          }
        });

        applyLocalHighlights('Local file references', {
          filePath: targetFilePath,
          direction,
          relatedFiles: relatedFiles.size
        }, [...highlightSet]);
      }

      function resolveSelectedNodeForQuery() {
        if (!selectedNodeId) {
          return null;
        }
        const currentView = getViewGraph();
        return currentView.nodes.find((node) => node.id === selectedNodeId) || null;
      }

      function rerender() {
        renderToken += 1;
        const token = renderToken;

        const graph = getViewGraph();
        const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
        const activeKinds = selectedValues(kindFilters, 'data-kind');
        const activeEdgeTypes = selectedValues(edgeFilters, 'data-edge');
        const activeLanguages = selectedValues(languageFilters, 'data-language');
        const includeExternalNodes = includeExternal.checked;
        const query = String(searchInput.value || '').trim().toLowerCase();
        const depth = Number.parseInt(depthSelect.value, 10) || 0;
        const selectionEdges = graph.edges.filter((edge) => {
          if (activeEdgeTypes.size > 0 && !activeEdgeTypes.has(edge.type)) {
            return false;
          }
          if (viewSelect.value === 'code') {
            const sourceNode = nodesById.get(edge.source);
            if (edge.type === 'contains' && sourceNode && sourceNode.kind === 'repository') {
              return false;
            }
          }
          return true;
        });
        const adjacency = buildAdjacency(selectionEdges);
        const selectionSet = makeSelectionSet(selectedNodeId, depth, adjacency);
        const applyInitialFocus =
          viewSelect.value === 'code' &&
          initialFocusNodeIds.size > 0 &&
          query.length === 0 &&
          !selectionSet &&
          queryHighlightedNodeIds.size === 0 &&
          (!queryResultNodeIds || queryResultNodeIds.size === 0);

        const visibleNodes = graph.nodes.filter((node) => {
          let visible = true;
          if (viewSelect.value === 'code') {
            if (applyInitialFocus && !initialFocusNodeIds.has(node.id)) {
              visible = false;
            }
            if (activeKinds.size > 0 && !activeKinds.has(node.kind)) {
              visible = false;
            }
            if (node.kind === 'external' && !includeExternalNodes) {
              visible = false;
            }
            if (node.language && activeLanguages.size > 0 && !activeLanguages.has(node.language)) {
              visible = false;
            }
            if (
              queryFilterToResults &&
              queryResultNodeIds &&
              queryResultNodeIds.size > 0 &&
              !queryResultNodeIds.has(node.id)
            ) {
              visible = false;
            }
          }
          if (query.length > 0) {
            const text = [node.name, node.id, node.filePath || ''].join(' ').toLowerCase();
            if (!text.includes(query)) {
              visible = false;
            }
          }
          if (selectionSet && !selectionSet.has(node.id)) {
            visible = false;
          }
          return visible;
        });
        const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
        const visibleEdges = graph.edges.filter(
          (edge) =>
            visibleNodeIds.has(edge.source) &&
            visibleNodeIds.has(edge.target) &&
            (activeEdgeTypes.size === 0 || activeEdgeTypes.has(edge.type))
        );
        const visibleAdjacency = buildAdjacency(visibleEdges);
        if (selectedNodeId && !visibleNodeIds.has(selectedNodeId)) {
          selectedNodeId = null;
        }

        const layoutMode = layoutSelect.value === 'auto'
          ? (viewSelect.value === 'module' ? 'flow' : 'force')
          : layoutSelect.value;
        const positions = layoutMode === 'flow'
          ? buildFlowLayout(visibleNodes, visibleEdges)
          : buildForceLayout(visibleNodes);
        const showLabels = visibleNodes.length <= 180;

        edgeLayer.innerHTML = '';
        nodeLayer.innerHTML = '';
        labelLayer.innerHTML = '';

        for (const edge of visibleEdges) {
          const from = positions.get(edge.source);
          const to = positions.get(edge.target);
          if (!from || !to) {
            continue;
          }
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(from.x));
          line.setAttribute('y1', String(from.y));
          line.setAttribute('x2', String(to.x));
          line.setAttribute('y2', String(to.y));
          line.setAttribute('stroke', EDGE_COLORS[edge.type] || '#8f96b8');
          line.setAttribute('stroke-width', String(Math.min(6, Math.max(1, edge.weight || 1))));
          line.setAttribute('class', 'edge');
          edgeLayer.appendChild(line);
        }

        for (const node of visibleNodes) {
          const position = positions.get(node.id);
          if (!position) {
            continue;
          }
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', String(position.x));
          circle.setAttribute('cy', String(position.y));
          circle.setAttribute('r', String(Math.min(16, 5 + Math.sqrt(node.degree || 1))));
          circle.setAttribute('fill', KIND_COLORS[node.kind] || '#9ea7d8');
          const circleClass = ['node'];
          if (selectedNodeId === node.id) {
            circleClass.push('selected');
          }
          if (queryHighlightedNodeIds.has(node.id)) {
            circleClass.push('query-highlight');
          }
          circle.setAttribute('class', circleClass.join(' '));
          circle.addEventListener('click', (event) => {
            if (suppressSvgClick) {
              suppressSvgClick = false;
              return;
            }
            event.stopPropagation();
            selectedNodeId = node.id;
            if (token === renderToken) {
              rerender();
            }
          });
          circle.addEventListener('mouseenter', (event) => {
            if (isPanning) {
              return;
            }
            const neighborCount = visibleAdjacency.get(node.id) ? visibleAdjacency.get(node.id).size : 0;
            showHoverPreview(node, neighborCount, event.clientX, event.clientY);
          });
          circle.addEventListener('mousemove', (event) => {
            if (!hoverPopover.classList.contains('visible')) {
              return;
            }
            setHoverPopoverPosition(event.clientX, event.clientY);
          });
          circle.addEventListener('mouseleave', () => {
            hideHoverPreview();
          });
          nodeLayer.appendChild(circle);

          if (showLabels) {
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', String(position.x + 8));
            label.setAttribute('y', String(position.y - 6));
            label.setAttribute('class', 'label');
            label.textContent = node.name;
            labelLayer.appendChild(label);
          }
        }

        visibleNodeCount.textContent = String(visibleNodes.length);
        visibleEdgeCount.textContent = String(visibleEdges.length);
        updateDetails(nodesById, visibleAdjacency);
      }

      svg.addEventListener('click', () => {
        if (suppressSvgClick) {
          suppressSvgClick = false;
          return;
        }
        hideHoverPreview();
        selectedNodeId = null;
        rerender();
      });
      svg.addEventListener('mousedown', (event) => {
        const target = event.target;
        if (target && target.classList && target.classList.contains('node')) {
          return;
        }
        beginPan(event);
      });
      sidebarResizer.addEventListener('pointerdown', (event) => {
        beginResize('sidebar', event);
      });
      detailsResizer.addEventListener('pointerdown', (event) => {
        beginResize('details', event);
      });
      window.addEventListener('mousemove', updatePan);
      window.addEventListener('mouseup', endPan);
      window.addEventListener('pointermove', updateResize);
      window.addEventListener('pointerup', endResize);
      window.addEventListener('pointercancel', endResize);
      window.addEventListener('blur', endPan);
      window.addEventListener('blur', endResize);
      window.addEventListener('resize', syncResizableBounds);
      svg.addEventListener('mouseleave', hideHoverPreview);
      svg.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const zoomFactor = event.deltaY < 0 ? 0.9 : 1.1;
          zoomAt(event.clientX, event.clientY, zoomFactor);
        },
        { passive: false }
      );
      viewSelect.addEventListener('change', () => {
        selectedNodeId = null;
        rerender();
      });
      layoutSelect.addEventListener('change', rerender);
      depthSelect.addEventListener('change', rerender);
      searchInput.addEventListener('input', rerender);
      includeExternal.addEventListener('change', rerender);
      kindFilters.addEventListener('change', rerender);
      edgeFilters.addEventListener('change', rerender);
      languageFilters.addEventListener('change', rerender);
      relayoutButton.addEventListener('click', rerender);
      fitButton.addEventListener('click', () => {
        resetViewport();
        selectedNodeId = null;
        rerender();
      });
      querySymbolReferencesButton.addEventListener('click', () => {
        void runLocalSymbolReferences();
      });
      querySymbolNeighborhoodButton.addEventListener('click', () => {
        void runLocalSymbolNeighborhood(1);
      });
      querySelectedRelatedButton.addEventListener('click', () => {
        const selectedNode = resolveSelectedNodeForQuery();
        if (!selectedNode) {
          setQueryStatus('Select a node first or use symbol search.', true);
          return;
        }
        if (selectedNode.filePath) {
          void runLocalReferencesForFile(selectedNode.filePath, 'both');
          return;
        }
        querySymbolInput.value = selectedNode.name || '';
        void runLocalSymbolNeighborhood(1);
      });
      queryClearButton.addEventListener('click', () => {
        queryHighlightedNodeIds = new Set();
        queryResultNodeIds = null;
        queryResultGraph = null;
        queryResults.textContent = 'No local query executed yet.';
        queryResults.classList.add('muted');
        setQueryStatus('Cleared query highlights.', false);
        rerender();
      });
      queryFilterResults.addEventListener('change', () => {
        queryFilterToResults = Boolean(queryFilterResults.checked);
        rerender();
      });
      querySymbolInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
          return;
        }
        event.preventDefault();
        querySymbolReferencesButton.click();
      });

      resetViewport();
      rerender();
    }

    init();
  </script>
</body>
</html>
`;
}

export async function renderGraphPage(command: RenderGraphPageCommand): Promise<RenderGraphPageResult> {
  const repoPath = resolveRepoPath(command.repoPath);
  const storage = resolveStoragePaths(repoPath, command.storeDir);
  const outputPath = path.resolve(command.outputPath ?? path.join(storage.storeDir, "graph-view.html"));
  const store = createGraphStore(repoPath, command.storeDir);
  const graph = await store.readGraph();
  const payload = sampleGraph(graph, command.maxNodes, command.embedAllNodes ?? true);
  const html = buildHtml(payload, { queryApiBase: command.queryApiBase });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");

  return {
    repoPath,
    storeDir: storage.storeDir,
    outputPath,
    totalNodeCount: payload.metadata.totalNodeCount,
    totalEdgeCount: payload.metadata.totalEdgeCount,
    renderedNodeCount: payload.metadata.renderedNodeCount,
    renderedEdgeCount: payload.metadata.renderedEdgeCount,
    truncated: payload.metadata.truncated
  };
}

