import { describe, expect, it } from "vitest";
import { buildGraphDocument } from "../src/relationship/relationship-engine.js";
import { CodeLanguage, EdgeKind, GRAPH_SCHEMA_VERSION, NodeKind } from "../src/types/graph.js";

describe("buildGraphDocument", () => {
  it("adds repository contains edges and deduplicates relationships", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\a.ts",
        relativePath: "src/a.ts",
        language: CodeLanguage.TypeScript,
        contentHash: "hash-a",
        content: "export const a = 1;"
      }
    ];

    const graph = buildGraphDocument(
      "C:\\repo",
      scannedFiles,
      [
        {
          nodes: [],
          edges: [
            {
              type: EdgeKind.Imports,
              from: "file:src/a.ts",
              to: "module:lodash"
            },
            {
              type: EdgeKind.Imports,
              from: "file:src/a.ts",
              to: "module:lodash"
            }
          ]
        }
      ]
    );

    expect(graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    expect(graph.edges.filter((edge) => edge.type === EdgeKind.Imports).length).toBe(1);
    expect(graph.edges.some((edge) => edge.type === EdgeKind.Contains)).toBe(true);
  });

  it("resolves external call/dependency targets to symbols when deterministic", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\worker.cs",
        relativePath: "src/worker.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-worker",
        content: "class Worker {}"
      },
      {
        absolutePath: "C:\\repo\\src\\primary.cs",
        relativePath: "src/primary.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-primary",
        content: "class PrimaryService {}"
      }
    ];

    const graph = buildGraphDocument("C:\\repo", scannedFiles, [
      {
        nodes: [
          {
            id: "symbol:src/worker.cs#Run@10",
            kind: NodeKind.Symbol,
            name: "Run",
            language: CodeLanguage.CSharp,
            filePath: "src/worker.cs"
          },
          {
            id: "symbol:src/primary.cs#PrimaryService@10",
            kind: NodeKind.Symbol,
            name: "PrimaryService",
            language: CodeLanguage.CSharp,
            filePath: "src/primary.cs"
          },
          {
            id: "external:Run",
            kind: NodeKind.External,
            name: "Run"
          },
          {
            id: "external:PrimaryService",
            kind: NodeKind.External,
            name: "PrimaryService"
          }
        ],
        edges: [
          {
            type: EdgeKind.Calls,
            from: "symbol:src/worker.cs#Run@10",
            to: "external:Run",
            filePath: "src/worker.cs"
          },
          {
            type: EdgeKind.DependsOn,
            from: "symbol:src/worker.cs#Run@10",
            to: "external:PrimaryService",
            filePath: "src/worker.cs"
          }
        ]
      }
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.Calls &&
          edge.from === "symbol:src/worker.cs#Run@10" &&
          edge.to === "symbol:src/worker.cs#Run@10"
      )
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.DependsOn &&
          edge.from === "symbol:src/worker.cs#Run@10" &&
          edge.to === "symbol:src/primary.cs#PrimaryService@10"
      )
    ).toBe(true);

    const resolvedDependencyEdge = graph.edges.find(
      (edge) =>
        edge.type === EdgeKind.DependsOn &&
        edge.from === "symbol:src/worker.cs#Run@10" &&
        edge.to === "symbol:src/primary.cs#PrimaryService@10"
    );
    expect(resolvedDependencyEdge?.metadata?.resolverMode).toBe("ranked");
    expect(resolvedDependencyEdge?.metadata?.resolverDecision).toBe("ranked_auto_resolved");
    expect(resolvedDependencyEdge?.metadata?.resolverConfidenceBand).toBe("high");
  });

  it("does not resolve ambiguous external targets", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\a.cs",
        relativePath: "src/a.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-a",
        content: "class A {}"
      },
      {
        absolutePath: "C:\\repo\\src\\b.cs",
        relativePath: "src/b.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-b",
        content: "class B {}"
      }
    ];

    const graph = buildGraphDocument("C:\\repo", scannedFiles, [
      {
        nodes: [
          {
            id: "symbol:src/a.cs#Run@1",
            kind: NodeKind.Symbol,
            name: "Run",
            language: CodeLanguage.CSharp,
            filePath: "src/a.cs"
          },
          {
            id: "symbol:src/b.cs#Run@1",
            kind: NodeKind.Symbol,
            name: "Run",
            language: CodeLanguage.CSharp,
            filePath: "src/b.cs"
          },
          {
            id: "symbol:src/a.cs#Caller@5",
            kind: NodeKind.Symbol,
            name: "Caller",
            language: CodeLanguage.CSharp,
            filePath: "src/a.cs"
          },
          {
            id: "external:Run",
            kind: NodeKind.External,
            name: "Run"
          }
        ],
        edges: [
          {
            type: EdgeKind.Calls,
            from: "symbol:src/a.cs#Caller@5",
            to: "external:Run",
            filePath: "src/other.cs"
          }
        ]
      }
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.Calls &&
          edge.from === "symbol:src/a.cs#Caller@5" &&
          edge.to === "external:Run"
      )
    ).toBe(true);

    const unresolvedCall = graph.edges.find(
      (edge) =>
        edge.type === EdgeKind.Calls &&
        edge.from === "symbol:src/a.cs#Caller@5" &&
        edge.to === "external:Run"
    );
    expect(unresolvedCall?.metadata?.resolverDecision).toBe("ranked_low_confidence");
    expect(unresolvedCall?.metadata?.resolverConfidenceBand).toBe("low");
  });

  it("keeps medium-confidence ranked ties unresolved and emits candidates", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\caller.cs",
        relativePath: "src/caller.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-caller",
        content: "class Caller {}"
      }
    ];

    const graph = buildGraphDocument("C:\\repo", scannedFiles, [
      {
        nodes: [
          {
            id: "symbol:src/caller.cs#Caller@1",
            kind: NodeKind.Symbol,
            name: "Caller",
            language: CodeLanguage.CSharp,
            filePath: "src/caller.cs",
            metadata: {
              containingType: "Factory"
            }
          },
          {
            id: "symbol:src/caller.cs#CreateA@5",
            kind: NodeKind.Symbol,
            name: "Create",
            language: CodeLanguage.CSharp,
            filePath: "src/caller.cs",
            metadata: {
              namespace: "App.Services",
              fullyQualifiedName: "App.Services.Create",
              containingType: "Factory",
              memberKind: "method",
              arity: 0,
              parameterCount: 1
            }
          },
          {
            id: "symbol:src/caller.cs#CreateB@8",
            kind: NodeKind.Symbol,
            name: "Create",
            language: CodeLanguage.CSharp,
            filePath: "src/caller.cs",
            metadata: {
              namespace: "App.Services",
              fullyQualifiedName: "App.Services.Create",
              containingType: "Factory",
              memberKind: "method",
              arity: 0,
              parameterCount: 1
            }
          },
          {
            id: "module:App.Services",
            kind: NodeKind.Module,
            name: "App.Services"
          },
          {
            id: "external:App.Services.Create",
            kind: NodeKind.External,
            name: "App.Services.Create"
          }
        ],
        edges: [
          {
            type: EdgeKind.Imports,
            from: "file:src/caller.cs",
            to: "module:App.Services",
            filePath: "src/caller.cs"
          },
          {
            type: EdgeKind.Calls,
            from: "symbol:src/caller.cs#Caller@1",
            to: "external:App.Services.Create",
            filePath: "src/caller.cs",
            metadata: {
              memberKind: "method",
              argCount: 1,
              genericArity: 0,
              receiverType: "Factory"
            }
          }
        ]
      }
    ]);

    const unresolvedCall = graph.edges.find(
      (edge) =>
        edge.type === EdgeKind.Calls &&
        edge.from === "symbol:src/caller.cs#Caller@1" &&
        edge.to === "external:App.Services.Create"
    );
    expect(unresolvedCall).toBeDefined();
    expect(unresolvedCall?.metadata?.resolverMode).toBe("ranked");
    expect(unresolvedCall?.metadata?.resolverDecision).toBe("ranked_candidates_only");
    expect(unresolvedCall?.metadata?.resolverConfidenceBand).toBe("medium");
    expect(unresolvedCall?.metadata?.resolverCandidateCount).toBe(2);
  });

  it("supports strict-mode opt-out when ranked policy leaves low-confidence unresolved", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\feature\\caller.cs",
        relativePath: "src/feature/caller.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-caller",
        content: "class Caller {}"
      },
      {
        absolutePath: "C:\\repo\\src\\feature\\service-a.cs",
        relativePath: "src/feature/service-a.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-a",
        content: "class Create {}"
      },
      {
        absolutePath: "C:\\repo\\src\\other\\service-b.cs",
        relativePath: "src/other/service-b.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-b",
        content: "class Create {}"
      }
    ];

    const output = {
      nodes: [
        {
          id: "symbol:src/feature/caller.cs#Caller@1",
          kind: NodeKind.Symbol,
          name: "Caller",
          language: CodeLanguage.CSharp,
          filePath: "src/feature/caller.cs"
        },
        {
          id: "symbol:src/feature/service-a.cs#Create@1",
          kind: NodeKind.Symbol,
          name: "Create",
          language: CodeLanguage.CSharp,
          filePath: "src/feature/service-a.cs"
        },
        {
          id: "symbol:src/other/service-b.cs#Create@1",
          kind: NodeKind.Symbol,
          name: "Create",
          language: CodeLanguage.CSharp,
          filePath: "src/other/service-b.cs"
        },
        {
          id: "external:Create",
          kind: NodeKind.External,
          name: "Create"
        }
      ],
      edges: [
        {
          type: EdgeKind.Calls,
          from: "symbol:src/feature/caller.cs#Caller@1",
          to: "external:Create",
          filePath: "src/feature/caller.cs"
        }
      ]
    };

    const rankedGraph = buildGraphDocument("C:\\repo", scannedFiles, [output]);
    expect(
      rankedGraph.edges.some(
        (edge) =>
          edge.type === EdgeKind.Calls &&
          edge.from === "symbol:src/feature/caller.cs#Caller@1" &&
          edge.to === "external:Create"
      )
    ).toBe(true);

    const strictGraph = buildGraphDocument("C:\\repo", scannedFiles, [output], { mode: "strict" });
    expect(
      strictGraph.edges.some(
        (edge) =>
          edge.type === EdgeKind.Calls &&
          edge.from === "symbol:src/feature/caller.cs#Caller@1" &&
          edge.to === "symbol:src/feature/service-a.cs#Create@1"
      )
    ).toBe(true);
  });

  it("resolves ambiguous external targets using imported namespace and qualified external names", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\caller.cs",
        relativePath: "src/caller.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-caller",
        content: "class Caller {}"
      },
      {
        absolutePath: "C:\\repo\\src\\app-service.cs",
        relativePath: "src/app-service.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-app",
        content: "class PrimaryService {}"
      },
      {
        absolutePath: "C:\\repo\\src\\other-service.cs",
        relativePath: "src/other-service.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-other",
        content: "class PrimaryService {}"
      }
    ];

    const graph = buildGraphDocument("C:\\repo", scannedFiles, [
      {
        nodes: [
          {
            id: "symbol:src/caller.cs#Caller@1",
            kind: NodeKind.Symbol,
            name: "Caller",
            language: CodeLanguage.CSharp,
            filePath: "src/caller.cs"
          },
          {
            id: "symbol:src/app-service.cs#PrimaryService@1",
            kind: NodeKind.Symbol,
            name: "PrimaryService",
            language: CodeLanguage.CSharp,
            filePath: "src/app-service.cs",
            metadata: { namespace: "App.Services" }
          },
          {
            id: "symbol:src/other-service.cs#PrimaryService@1",
            kind: NodeKind.Symbol,
            name: "PrimaryService",
            language: CodeLanguage.CSharp,
            filePath: "src/other-service.cs",
            metadata: { namespace: "Other.Services" }
          },
          {
            id: "module:App.Services",
            kind: NodeKind.Module,
            name: "App.Services"
          },
          {
            id: "external:App.Services.PrimaryService",
            kind: NodeKind.External,
            name: "App.Services.PrimaryService"
          }
        ],
        edges: [
          {
            type: EdgeKind.Imports,
            from: "file:src/caller.cs",
            to: "module:App.Services",
            filePath: "src/caller.cs"
          },
          {
            type: EdgeKind.DependsOn,
            from: "symbol:src/caller.cs#Caller@1",
            to: "external:App.Services.PrimaryService",
            filePath: "src/caller.cs"
          }
        ]
      }
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.DependsOn &&
          edge.from === "symbol:src/caller.cs#Caller@1" &&
          edge.to === "symbol:src/app-service.cs#PrimaryService@1"
      )
    ).toBe(true);
  });

  it("resolves ambiguous targets using alias and static import context", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\caller.cs",
        relativePath: "src/caller.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-caller",
        content: "class Caller {}"
      },
      {
        absolutePath: "C:\\repo\\src\\app-service.cs",
        relativePath: "src/app-service.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-app",
        content: "class PrimaryService {}"
      },
      {
        absolutePath: "C:\\repo\\src\\factory-a.cs",
        relativePath: "src/factory-a.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-factory-a",
        content: "class Factory {}"
      },
      {
        absolutePath: "C:\\repo\\src\\factory-b.cs",
        relativePath: "src/factory-b.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-factory-b",
        content: "class Factory {}"
      }
    ];

    const graph = buildGraphDocument("C:\\repo", scannedFiles, [
      {
        nodes: [
          {
            id: "symbol:src/caller.cs#Caller@1",
            kind: NodeKind.Symbol,
            name: "Caller",
            language: CodeLanguage.CSharp,
            filePath: "src/caller.cs"
          },
          {
            id: "symbol:src/app-service.cs#PrimaryService@1",
            kind: NodeKind.Symbol,
            name: "PrimaryService",
            language: CodeLanguage.CSharp,
            filePath: "src/app-service.cs",
            metadata: {
              namespace: "App.Services",
              fullyQualifiedName: "App.Services.PrimaryService",
              containingType: "PrimaryService",
              memberKind: "type",
              arity: 0,
              parameterCount: 0
            }
          },
          {
            id: "symbol:src/factory-a.cs#Create@1",
            kind: NodeKind.Symbol,
            name: "Create",
            language: CodeLanguage.CSharp,
            filePath: "src/factory-a.cs",
            metadata: {
              namespace: "App.Utility",
              fullyQualifiedName: "App.Utility.Factory.Create",
              containingType: "Factory",
              memberKind: "method",
              arity: 0,
              parameterCount: 1
            }
          },
          {
            id: "symbol:src/factory-b.cs#Create@1",
            kind: NodeKind.Symbol,
            name: "Create",
            language: CodeLanguage.CSharp,
            filePath: "src/factory-b.cs",
            metadata: {
              namespace: "Other.Utility",
              fullyQualifiedName: "Other.Utility.Factory.Create",
              containingType: "Factory",
              memberKind: "method",
              arity: 0,
              parameterCount: 1
            }
          },
          {
            id: "module:App.Services",
            kind: NodeKind.Module,
            name: "App.Services"
          },
          {
            id: "module:App.Utility.Factory",
            kind: NodeKind.Module,
            name: "App.Utility.Factory"
          },
          {
            id: "external:Alias.PrimaryService",
            kind: NodeKind.External,
            name: "Alias.PrimaryService"
          },
          {
            id: "external:Create",
            kind: NodeKind.External,
            name: "Create"
          }
        ],
        edges: [
          {
            type: EdgeKind.Imports,
            from: "file:src/caller.cs",
            to: "module:App.Services",
            filePath: "src/caller.cs",
            metadata: {
              alias: "Alias",
              usingKind: "alias",
              globalUsing: false,
              staticImport: false,
              implicitUsing: false
            }
          },
          {
            type: EdgeKind.Imports,
            from: "file:src/caller.cs",
            to: "module:App.Utility.Factory",
            filePath: "src/caller.cs",
            metadata: {
              alias: null,
              usingKind: "static",
              globalUsing: false,
              staticImport: true,
              implicitUsing: false
            }
          },
          {
            type: EdgeKind.DependsOn,
            from: "symbol:src/caller.cs#Caller@1",
            to: "external:Alias.PrimaryService",
            filePath: "src/caller.cs",
            metadata: {
              memberKind: "type_ref"
            }
          },
          {
            type: EdgeKind.Calls,
            from: "symbol:src/caller.cs#Caller@1",
            to: "external:Create",
            filePath: "src/caller.cs",
            metadata: {
              memberKind: "method",
              argCount: 1,
              genericArity: 0,
              receiverType: "Factory"
            }
          }
        ]
      }
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.DependsOn &&
          edge.from === "symbol:src/caller.cs#Caller@1" &&
          edge.to === "symbol:src/app-service.cs#PrimaryService@1"
      )
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.Calls &&
          edge.from === "symbol:src/caller.cs#Caller@1" &&
          edge.to === "symbol:src/factory-a.cs#Create@1"
      )
    ).toBe(true);
  });

  it("uses signature and project proximity to break ties deterministically", () => {
    const scannedFiles = [
      {
        absolutePath: "C:\\repo\\src\\feature\\caller.cs",
        relativePath: "src/feature/caller.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-caller",
        content: "class Caller {}"
      },
      {
        absolutePath: "C:\\repo\\src\\feature\\service-a.cs",
        relativePath: "src/feature/service-a.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-a",
        content: "class Service {}"
      },
      {
        absolutePath: "C:\\repo\\src\\other\\service-b.cs",
        relativePath: "src/other/service-b.cs",
        language: CodeLanguage.CSharp,
        contentHash: "hash-b",
        content: "class Service {}"
      }
    ];

    const graph = buildGraphDocument("C:\\repo", scannedFiles, [
      {
        nodes: [
          {
            id: "symbol:src/feature/caller.cs#Caller@1",
            kind: NodeKind.Symbol,
            name: "Caller",
            language: CodeLanguage.CSharp,
            filePath: "src/feature/caller.cs"
          },
          {
            id: "symbol:src/feature/service-a.cs#Build@1",
            kind: NodeKind.Symbol,
            name: "Build",
            language: CodeLanguage.CSharp,
            filePath: "src/feature/service-a.cs",
            metadata: {
              namespace: "App.Services",
              fullyQualifiedName: "App.Services.Service.Build",
              containingType: "Service",
              memberKind: "method",
              arity: 1,
              parameterCount: 2
            }
          },
          {
            id: "symbol:src/other/service-b.cs#Build@1",
            kind: NodeKind.Symbol,
            name: "Build",
            language: CodeLanguage.CSharp,
            filePath: "src/other/service-b.cs",
            metadata: {
              namespace: "App.Services",
              fullyQualifiedName: "App.Services.Service.Build",
              containingType: "Service",
              memberKind: "method",
              arity: 1,
              parameterCount: 1
            }
          },
          {
            id: "external:Build",
            kind: NodeKind.External,
            name: "Build"
          }
        ],
        edges: [
          {
            type: EdgeKind.Calls,
            from: "symbol:src/feature/caller.cs#Caller@1",
            to: "external:Build",
            filePath: "src/feature/caller.cs",
            metadata: {
              memberKind: "method",
              argCount: 2,
              genericArity: 1,
              receiverType: "Service"
            }
          }
        ]
      }
    ]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.type === EdgeKind.Calls &&
          edge.from === "symbol:src/feature/caller.cs#Caller@1" &&
          edge.to === "symbol:src/feature/service-a.cs#Build@1"
      )
    ).toBe(true);
  });
});
