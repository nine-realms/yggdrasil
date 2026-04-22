import Parser from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";
import {
  AdapterOutput,
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

type SyntaxNode = Parser.SyntaxNode;

const csharpParser = new Parser();
csharpParser.setLanguage(CSharp);

const RESERVED_CALL_NAMES = new Set(["if", "for", "foreach", "while", "switch", "catch", "nameof"]);
const DI_REGISTRATION_METHODS = new Set(["AddScoped", "AddSingleton", "AddTransient"]);
const CSHARP_IMPLICIT_USINGS = [
  "System",
  "System.Collections.Generic",
  "System.Linq",
  "System.Threading",
  "System.Threading.Tasks",
  "System.Net.Http"
] as const;
const IGNORE_TYPE_NAMES = new Set([
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "readonly",
  "const",
  "async",
  "await",
  "return",
  "void",
  "string",
  "int",
  "long",
  "short",
  "byte",
  "bool",
  "double",
  "float",
  "decimal",
  "object",
  "var",
  "new",
  "class",
  "interface",
  "record",
  "struct",
  "ref",
  "out",
  "in",
  "this",
  "params",
  "where",
  "true",
  "false",
  "null"
]);

type SymbolMemberKind = "type" | "method" | "constructor" | "local_function";
type UsingDirectiveKind = "namespace" | "alias" | "static" | "implicit";

interface UsingDirectiveDetails {
  moduleName: string;
  alias?: string;
  globalUsing?: boolean;
  staticImport?: boolean;
  kind: UsingDirectiveKind;
}

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function pushEdge(edges: GraphEdge[], edge: GraphEdge): void {
  edges.push(edge);
}

function lineFrom(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function isLikelyInterfaceName(name: string): boolean {
  return /^I[A-Z]/.test(name);
}

function extractTypeIdentifiers(raw: string): string[] {
  const unique = new Set<string>();
  const isIdentifierStart = (value: string): boolean => /[A-Za-z_]/.test(value);
  const isIdentifierChar = (value: string): boolean => /[A-Za-z0-9_]/.test(value);

  let index = 0;
  while (index < raw.length) {
    if (!isIdentifierStart(raw[index])) {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < raw.length && isIdentifierChar(raw[index])) {
      index += 1;
    }

    const value = raw.slice(start, index);
    if (!value || IGNORE_TYPE_NAMES.has(value)) {
      continue;
    }
    if (value[0] !== value[0].toUpperCase()) {
      continue;
    }
    if (value.length === 1) {
      continue;
    }

    let lookahead = index;
    while (lookahead < raw.length && /\s/.test(raw[lookahead])) {
      lookahead += 1;
    }
    const nextChar = raw[lookahead];
    const nextTwo = raw.slice(lookahead, lookahead + 2);
    if (nextChar === "." || nextTwo === "::") {
      continue;
    }

    unique.add(value);
  }
  return [...unique];
}

function extractIdentifierFromNode(node: SyntaxNode | null): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "generic_name") {
    const identifierChild = node.namedChildren.find((child) => child.type === "identifier");
    return identifierChild?.text;
  }
  const nameFieldNode = node.childForFieldName("name");
  if (nameFieldNode) {
    return extractIdentifierFromNode(nameFieldNode);
  }
  const nestedIdentifier = node.namedChildren.find(
    (child) => child.type === "identifier" || child.type === "generic_name"
  );
  return extractIdentifierFromNode(nestedIdentifier ?? null);
}

function findFirstNamedDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) {
      return child;
    }
    const nested = findFirstNamedDescendant(child, type);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function extractInvocationTargetName(functionNode: SyntaxNode | null): string | undefined {
  if (!functionNode) {
    return undefined;
  }
  if (functionNode.type === "identifier" || functionNode.type === "generic_name") {
    return extractIdentifierFromNode(functionNode);
  }
  if (functionNode.type === "member_access_expression") {
    const nameNode = functionNode.childForFieldName("name") ?? functionNode.lastNamedChild;
    return extractIdentifierFromNode(nameNode);
  }
  return extractIdentifierFromNode(functionNode.childForFieldName("name"));
}

function extractInvocationTypeArguments(functionNode: SyntaxNode | null): string[] {
  if (!functionNode) {
    return [];
  }
  const typeArgList = findFirstNamedDescendant(functionNode, "type_argument_list");
  if (!typeArgList) {
    return [];
  }
  return extractTypeIdentifiers(typeArgList.text);
}

function invocationGenericArity(functionNode: SyntaxNode | null): number {
  if (!functionNode) {
    return 0;
  }
  const typeArgList = findFirstNamedDescendant(functionNode, "type_argument_list");
  if (!typeArgList) {
    return 0;
  }
  return typeArgList.namedChildren.length;
}

function isTypeDeclaration(node: SyntaxNode): boolean {
  return (
    node.type === "class_declaration" ||
    node.type === "interface_declaration" ||
    node.type === "struct_declaration" ||
    node.type === "record_declaration" ||
    node.type === "enum_declaration"
  );
}

function isSymbolDeclaration(node: SyntaxNode): boolean {
  return (
    isTypeDeclaration(node) ||
    node.type === "method_declaration" ||
    node.type === "constructor_declaration" ||
    node.type === "local_function_statement"
  );
}

function declarationName(node: SyntaxNode): string | undefined {
  return extractIdentifierFromNode(node.childForFieldName("name"));
}

function namespaceName(node: SyntaxNode): string | undefined {
  const nameNode =
    node.childForFieldName("name") ??
    node.namedChildren.find(
      (child) =>
        child.type === "qualified_name" ||
        child.type === "alias_qualified_name" ||
        child.type === "identifier"
    );
  const value =
    nameNode?.text.replace(/\s+/g, "") ??
    /namespace\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(node.text)?.[1];
  return value && value.length > 0 ? value : undefined;
}

function normalizeQualifiedName(value: string): string {
  return value.replace(/\s+/g, "").replace(/\bglobal::/g, "").trim();
}

function declarationModifierTokens(node: SyntaxNode): string[] {
  const tokens = new Set<string>();
  for (const child of node.children) {
    if (child.type === "modifier") {
      tokens.add(child.text.toLowerCase());
    }
  }

  if (tokens.size === 0) {
    const header = node.text.slice(0, 300);
    const matcher = /\b(public|private|protected|internal|static)\b/g;
    let match = matcher.exec(header);
    while (match) {
      tokens.add(match[1].toLowerCase());
      match = matcher.exec(header);
    }
  }

  return [...tokens];
}

function declarationAccessibility(node: SyntaxNode): string | undefined {
  const modifiers = new Set(declarationModifierTokens(node));
  const hasProtected = modifiers.has("protected");
  const hasInternal = modifiers.has("internal");
  if (modifiers.has("public")) {
    return "public";
  }
  if (modifiers.has("private")) {
    return "private";
  }
  if (hasProtected && hasInternal) {
    return "protected_internal";
  }
  if (hasProtected) {
    return "protected";
  }
  if (hasInternal) {
    return "internal";
  }
  return undefined;
}

function declarationIsStatic(node: SyntaxNode): boolean {
  return declarationModifierTokens(node).includes("static");
}

function declarationParameterCount(node: SyntaxNode): number {
  const parameterList = findFirstNamedDescendant(node, "parameter_list");
  if (!parameterList) {
    return 0;
  }
  return parameterList.namedChildren.filter((child) => child.type === "parameter").length;
}

function declarationArity(node: SyntaxNode): number {
  const typeParameterList = findFirstNamedDescendant(node, "type_parameter_list");
  if (!typeParameterList) {
    return 0;
  }
  return typeParameterList.namedChildren.filter(
    (child) => child.type === "identifier" || child.type === "type_parameter"
  ).length;
}

function declarationMemberKind(node: SyntaxNode): SymbolMemberKind {
  if (isTypeDeclaration(node)) {
    return "type";
  }
  if (node.type === "constructor_declaration") {
    return "constructor";
  }
  if (node.type === "local_function_statement") {
    return "local_function";
  }
  return "method";
}

function parseUsingDirective(node: SyntaxNode): UsingDirectiveDetails | undefined {
  const directive = node.text.trim();
  if (!directive.endsWith(";")) {
    return undefined;
  }

  let body = directive.slice(0, -1).trim();
  let globalUsing = false;
  if (body.startsWith("global using ")) {
    globalUsing = true;
    body = body.slice("global using ".length).trim();
  } else if (body.startsWith("using ")) {
    body = body.slice("using ".length).trim();
  } else {
    return undefined;
  }

  let staticImport = false;
  if (body.startsWith("static ")) {
    staticImport = true;
    body = body.slice("static ".length).trim();
  }

  const aliasMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(body);
  const alias = aliasMatch?.[1];
  const rawTarget = aliasMatch?.[2] ?? body;
  const moduleName = normalizeQualifiedName(rawTarget);
  if (!moduleName) {
    return undefined;
  }

  return {
    moduleName,
    alias,
    globalUsing,
    staticImport,
    kind: alias ? "alias" : staticImport ? "static" : "namespace"
  };
}

function invocationArgumentCount(node: SyntaxNode): number {
  const argumentList = node.childForFieldName("arguments") ?? node.namedChildren.find((child) => child.type === "argument_list");
  if (!argumentList) {
    return 0;
  }
  return argumentList.namedChildren.filter((child) => child.type === "argument").length;
}

function invocationReceiverType(functionNode: SyntaxNode | null): string | undefined {
  if (!functionNode || functionNode.type !== "member_access_expression") {
    return undefined;
  }
  const receiverNode = functionNode.childForFieldName("expression") ?? functionNode.firstNamedChild;
  const receiverText = receiverNode ? normalizeQualifiedName(receiverNode.text) : "";
  if (!receiverText) {
    return undefined;
  }
  if (receiverText === "this" || receiverText === "base") {
    return undefined;
  }
  return receiverText;
}

function addExternalTypeDependency(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  callerId: string,
  typeName: string,
  filePath: string,
  line?: number,
  metadata?: GraphEdge["metadata"]
): void {
  const normalizedTypeName = normalizeQualifiedName(typeName);
  const externalId = externalNodeId(normalizedTypeName);
  addNode(nodes, {
    id: externalId,
    kind: NodeKind.External,
    name: normalizedTypeName,
    metadata: {
      parser: "csharp-tree-sitter"
    }
  });

  pushEdge(edges, {
    type: EdgeKind.DependsOn,
    from: callerId,
    to: externalId,
    filePath,
    line,
    metadata
  });
}

function addImportModuleEdge(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  fileId: string,
  filePath: string,
  moduleName: string,
  line?: number,
  details?: Partial<UsingDirectiveDetails>
): void {
  const normalizedModule = normalizeQualifiedName(moduleName);
  if (!normalizedModule) {
    return;
  }

  const moduleId = moduleNodeId(normalizedModule);
  addNode(nodes, {
    id: moduleId,
    kind: NodeKind.Module,
    name: normalizedModule,
    metadata: {
      parser: "csharp-tree-sitter"
    }
  });

  pushEdge(edges, {
    type: EdgeKind.Imports,
    from: fileId,
    to: moduleId,
    filePath,
    line,
    metadata: {
      parser: "csharp-tree-sitter",
      usingKind: details?.kind ?? "namespace",
      alias: details?.alias ?? null,
      globalUsing: details?.globalUsing ?? false,
      staticImport: details?.staticImport ?? false,
      implicitUsing: details?.kind === "implicit"
    }
  });
}

export function adaptCSharp(file: ScannedFile): AdapterOutput {
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
      parser: "csharp-tree-sitter"
    }
  });

  const tree = csharpParser.parse(file.content);
  const symbolScopeStack: string[] = [];
  const typeScopeStack: string[] = [];
  const namespaceScopeStack: string[] = [];
  const fileScopedNamespace = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(file.content)?.[1];
  if (fileScopedNamespace) {
    namespaceScopeStack.push(fileScopedNamespace);
  }

  const visit = (node: SyntaxNode): void => {
    let declaredSymbolId: string | undefined;
    let enteredType = false;
    let enteredNamespace = false;

    if (node.type === "namespace_declaration") {
      const currentNamespace = namespaceName(node);
      if (currentNamespace) {
        namespaceScopeStack.push(currentNamespace);
        enteredNamespace = true;
      }
    }

    if (isSymbolDeclaration(node)) {
      const name = declarationName(node);
      if (name) {
        declaredSymbolId = symbolNodeId(file.relativePath, name, node.startIndex);
        const qualifiedNamespace = normalizeQualifiedName(namespaceScopeStack.join("."));
        const containingType = normalizeQualifiedName(typeScopeStack.join("."));
        const memberKind = declarationMemberKind(node);
        const arity = declarationArity(node);
        const parameterCount = declarationParameterCount(node);
        const accessibility = declarationAccessibility(node);
        const isStatic = declarationIsStatic(node);
        const fullyQualifiedName = [qualifiedNamespace, containingType, name]
          .filter((value) => value.length > 0)
          .join(".");

        addNode(nodes, {
          id: declaredSymbolId,
          kind: NodeKind.Symbol,
          name,
          language: file.language,
          filePath: file.relativePath,
          sourceHash: file.contentHash,
          metadata: {
            parser: "csharp-tree-sitter",
            position: node.startIndex,
            namespace: qualifiedNamespace.length > 0 ? qualifiedNamespace : null,
            containingType: containingType.length > 0 ? containingType : null,
            fullyQualifiedName: fullyQualifiedName.length > 0 ? fullyQualifiedName : name,
            memberKind,
            arity,
            parameterCount,
            isStatic,
            accessibility: accessibility ?? null
          }
        });

        pushEdge(edges, {
          type: EdgeKind.Defines,
          from: fileId,
          to: declaredSymbolId,
          filePath: file.relativePath,
          line: lineFrom(node)
        });

        symbolScopeStack.push(declaredSymbolId);
        if (isTypeDeclaration(node)) {
          typeScopeStack.push(name);
          enteredType = true;
        }

        if (isTypeDeclaration(node)) {
          const baseList = node.namedChildren.find((child) => child.type === "base_list");
          if (baseList) {
            for (const inheritedType of extractTypeIdentifiers(baseList.text)) {
              addExternalTypeDependency(
                nodes,
                edges,
                declaredSymbolId,
                inheritedType,
                file.relativePath,
                lineFrom(baseList),
                {
                  parser: "csharp-tree-sitter",
                  memberKind: "type_ref"
                }
              );
            }
          }
        }
      }
    }

    if (node.type === "using_directive") {
      const usingDetails = parseUsingDirective(node);
      if (usingDetails) {
        addImportModuleEdge(nodes, edges, fileId, file.relativePath, usingDetails.moduleName, lineFrom(node), usingDetails);
      }
    }

    const callerId = symbolScopeStack[symbolScopeStack.length - 1] ?? fileId;

    if (node.type === "parameter") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        for (const typeName of extractTypeIdentifiers(typeNode.text)) {
          addExternalTypeDependency(nodes, edges, callerId, typeName, file.relativePath, lineFrom(typeNode), {
            parser: "csharp-tree-sitter",
            memberKind: "type_ref"
          });
        }
      }
    }

    if (node.type === "object_creation_expression") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        for (const typeName of extractTypeIdentifiers(typeNode.text)) {
          addExternalTypeDependency(nodes, edges, callerId, typeName, file.relativePath, lineFrom(typeNode), {
            parser: "csharp-tree-sitter",
            memberKind: "type_ref"
          });
        }
      }
    }

    if (node.type === "typeof_expression") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        for (const typeName of extractTypeIdentifiers(typeNode.text)) {
          addExternalTypeDependency(nodes, edges, callerId, typeName, file.relativePath, lineFrom(typeNode), {
            parser: "csharp-tree-sitter",
            memberKind: "type_ref"
          });
        }
      }
    }

    if (node.type === "invocation_expression") {
      const functionNode = node.childForFieldName("function");
      const callName = extractInvocationTargetName(functionNode);
      const callArgCount = invocationArgumentCount(node);
      const typeNames = extractInvocationTypeArguments(functionNode);
      const genericArity = invocationGenericArity(functionNode);
      const receiverType =
        invocationReceiverType(functionNode) ??
        (() => {
          const currentSymbol = symbolScopeStack[symbolScopeStack.length - 1];
          if (!currentSymbol) {
            return undefined;
          }
          const currentNode = nodes.get(currentSymbol);
          const containingTypeValue = currentNode?.metadata?.containingType;
          return typeof containingTypeValue === "string" && containingTypeValue.length > 0 ? containingTypeValue : undefined;
        })();
      if (callName && !RESERVED_CALL_NAMES.has(callName)) {
        const normalizedCallName = normalizeQualifiedName(callName);
        const calleeId = externalNodeId(normalizedCallName);
        addNode(nodes, {
          id: calleeId,
          kind: NodeKind.External,
          name: normalizedCallName,
          metadata: {
            parser: "csharp-tree-sitter"
          }
        });

        pushEdge(edges, {
          type: EdgeKind.Calls,
          from: callerId,
          to: calleeId,
          filePath: file.relativePath,
          line: lineFrom(functionNode ?? node),
          metadata: {
            parser: "csharp-tree-sitter",
            memberKind: "method",
            argCount: callArgCount,
            genericArity,
            receiverType: receiverType ?? null
          }
        });
      }

      for (const typeName of typeNames) {
        addExternalTypeDependency(
          nodes,
          edges,
          callerId,
          typeName,
          file.relativePath,
          lineFrom(functionNode ?? node),
          {
            parser: "csharp-tree-sitter",
            memberKind: "type_ref"
          }
        );
      }

      if (
        callName &&
        DI_REGISTRATION_METHODS.has(callName) &&
        typeNames.length >= 2 &&
        isLikelyInterfaceName(typeNames[0] ?? "")
      ) {
        const serviceType = typeNames[0];
        const implementationType = typeNames[1];
        if (serviceType && implementationType) {
          const normalizedServiceType = normalizeQualifiedName(serviceType);
          const normalizedImplementationType = normalizeQualifiedName(implementationType);
          const serviceExternalId = externalNodeId(normalizedServiceType);
          const implementationExternalId = externalNodeId(normalizedImplementationType);
          addNode(nodes, {
            id: serviceExternalId,
            kind: NodeKind.External,
            name: normalizedServiceType,
            metadata: {
              parser: "csharp-tree-sitter"
            }
          });
          addNode(nodes, {
            id: implementationExternalId,
            kind: NodeKind.External,
            name: normalizedImplementationType,
            metadata: {
              parser: "csharp-tree-sitter"
            }
          });
          pushEdge(edges, {
            type: EdgeKind.DependsOn,
            from: serviceExternalId,
            to: implementationExternalId,
            filePath: file.relativePath,
            line: lineFrom(functionNode ?? node),
            metadata: {
              parser: "csharp-tree-sitter",
              memberKind: "type_map"
            }
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }

    if (declaredSymbolId) {
      symbolScopeStack.pop();
    }
    if (enteredType) {
      typeScopeStack.pop();
    }
    if (enteredNamespace) {
      namespaceScopeStack.pop();
    }
  };

  visit(tree.rootNode);

  for (const moduleName of CSHARP_IMPLICIT_USINGS) {
    addImportModuleEdge(nodes, edges, fileId, file.relativePath, moduleName, undefined, {
      kind: "implicit",
      globalUsing: true
    });
  }

  return {
    nodes: Array.from(nodes.values()),
    edges
  };
}
