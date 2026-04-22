import ts from "typescript";
import {
  AdapterOutput,
  CodeLanguage,
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  ScannedFile,
  externalNodeId,
  fileNodeId,
  moduleNodeId,
  symbolNodeId
} from "../types/graph.js";

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function pushEdge(edges: GraphEdge[], edge: GraphEdge): void {
  edges.push(edge);
}

function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name ? node.name.text : undefined;
  }

  if (ts.isMethodDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  return undefined;
}

function entityNameRightmost(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  return entityNameRightmost(name.right);
}

export function adaptTypeScript(file: ScannedFile): AdapterOutput {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const fileId = fileNodeId(file.relativePath);

  addNode(nodes, {
    id: fileId,
    kind: NodeKind.File,
    name: file.relativePath,
    language: file.language,
    filePath: file.relativePath,
    sourceHash: file.contentHash,
    metadata: {
      parser: "typescript"
    }
  });

  const source = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    file.language === CodeLanguage.TypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );

  const symbolScopeStack: string[] = [];

  const visit = (node: ts.Node): void => {
    const name = declarationName(node);
    let declaredSymbolId: string | undefined;

    if (name) {
      declaredSymbolId = symbolNodeId(file.relativePath, name, node.pos);
      addNode(nodes, {
        id: declaredSymbolId,
        kind: NodeKind.Symbol,
        name,
        language: file.language,
        filePath: file.relativePath,
        sourceHash: file.contentHash,
        metadata: {
          parser: "typescript",
          position: node.pos
        }
      });

      pushEdge(edges, {
        type: EdgeKind.Defines,
        from: fileId,
        to: declaredSymbolId,
        filePath: file.relativePath,
        line: source.getLineAndCharacterOfPosition(node.pos).line + 1
      });

      symbolScopeStack.push(declaredSymbolId);
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const moduleId = moduleNodeId(moduleName);

      addNode(nodes, {
        id: moduleId,
        kind: NodeKind.Module,
        name: moduleName,
        metadata: {
          parser: "typescript"
        }
      });

      pushEdge(edges, {
        type: EdgeKind.Imports,
        from: fileId,
        to: moduleId,
        filePath: file.relativePath,
        line: source.getLineAndCharacterOfPosition(node.moduleSpecifier.pos).line + 1
      });
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;
      const calleeId = externalNodeId(calleeName);
      const callerId = symbolScopeStack[symbolScopeStack.length - 1] ?? fileId;

      addNode(nodes, {
        id: calleeId,
        kind: NodeKind.External,
        name: calleeName,
        metadata: {
          parser: "typescript"
        }
      });

      pushEdge(edges, {
        type: EdgeKind.Calls,
        from: callerId,
        to: calleeId,
        filePath: file.relativePath,
        line: source.getLineAndCharacterOfPosition(node.expression.pos).line + 1
      });
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const typeName = node.expression.text;
      const typeId = externalNodeId(typeName);
      const callerId = symbolScopeStack[symbolScopeStack.length - 1] ?? fileId;

      addNode(nodes, {
        id: typeId,
        kind: NodeKind.External,
        name: typeName,
        metadata: {
          parser: "typescript"
        }
      });

      pushEdge(edges, {
        type: EdgeKind.DependsOn,
        from: callerId,
        to: typeId,
        filePath: file.relativePath,
        line: source.getLineAndCharacterOfPosition(node.expression.pos).line + 1
      });
    }

    if (ts.isTypeReferenceNode(node)) {
      const typeName = entityNameRightmost(node.typeName);
      const typeId = externalNodeId(typeName);
      const callerId = symbolScopeStack[symbolScopeStack.length - 1] ?? fileId;

      addNode(nodes, {
        id: typeId,
        kind: NodeKind.External,
        name: typeName,
        metadata: {
          parser: "typescript"
        }
      });

      pushEdge(edges, {
        type: EdgeKind.DependsOn,
        from: callerId,
        to: typeId,
        filePath: file.relativePath,
        line: source.getLineAndCharacterOfPosition(node.typeName.pos).line + 1
      });
    }

    if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) {
      const typeName = node.expression.text;
      const typeId = externalNodeId(typeName);
      const callerId = symbolScopeStack[symbolScopeStack.length - 1] ?? fileId;

      addNode(nodes, {
        id: typeId,
        kind: NodeKind.External,
        name: typeName,
        metadata: {
          parser: "typescript"
        }
      });

      pushEdge(edges, {
        type: EdgeKind.DependsOn,
        from: callerId,
        to: typeId,
        filePath: file.relativePath,
        line: source.getLineAndCharacterOfPosition(node.expression.pos).line + 1
      });
    }

    ts.forEachChild(node, visit);

    if (declaredSymbolId) {
      symbolScopeStack.pop();
    }
  };

  visit(source);

  return {
    nodes: Array.from(nodes.values()),
    edges
  };
}
