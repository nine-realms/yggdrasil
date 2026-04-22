import { describe, expect, it } from "vitest";
import { adaptCSharp } from "../src/adapters/csharp-adapter.js";
import { CodeLanguage, EdgeKind } from "../src/types/graph.js";

describe("adaptCSharp", () => {
  it("captures class dependencies from generic registration and constructor usage", () => {
    const result = adaptCSharp({
      absolutePath: "C:\\repo\\src\\Startup.cs",
      relativePath: "src/Startup.cs",
      language: CodeLanguage.CSharp,
      contentHash: "hash-1",
      content: `
        public class Startup {
          public void ConfigureServices(IServiceCollection services) {
            services.AddScoped<IPrimaryService, PrimaryService>();
            var svc = new PrimaryService();
          }
        }
      `
    });

    const primaryRefs = result.edges.filter(
      (edge) => edge.type === EdgeKind.DependsOn && edge.to === "external:PrimaryService"
    );
    expect(primaryRefs.length).toBeGreaterThan(0);

    expect(
      result.edges.some(
        (edge) =>
          edge.type === EdgeKind.DependsOn &&
          edge.from === "external:IPrimaryService" &&
          edge.to === "external:PrimaryService"
      )
    ).toBe(true);
  });

  it("captures invocation edges from identifier and member-access calls", () => {
    const result = adaptCSharp({
      absolutePath: "C:\\repo\\src\\Worker.cs",
      relativePath: "src/Worker.cs",
      language: CodeLanguage.CSharp,
      contentHash: "hash-2",
      content: `
        public class Worker {
          public void Run() {}
          public void Start() {
            this.Run();
            Run();
            helper.DoWork();
          }
        }
      `
    });

    const runCalls = result.edges.filter(
      (edge) => edge.type === EdgeKind.Calls && edge.to === "external:Run"
    );
    expect(runCalls.length).toBe(2);
    expect(
      result.edges.some((edge) => edge.type === EdgeKind.Calls && edge.to === "external:DoWork")
    ).toBe(true);
  });

  it("captures namespace metadata and avoids namespace-fragment type dependencies", () => {
    const result = adaptCSharp({
      absolutePath: "C:\\repo\\src\\Worker.cs",
      relativePath: "src/Worker.cs",
      language: CodeLanguage.CSharp,
      contentHash: "hash-3",
      content: `
        namespace App.Services;
        public class Worker {
          public Worker(Company.Product.Services.IPrimaryService service) {}
        }
      `
    });

    const workerNode = result.nodes.find((node) => node.name === "Worker");
    expect(workerNode?.metadata?.namespace).toBe("App.Services");

    expect(
      result.edges.some((edge) => edge.type === EdgeKind.DependsOn && edge.to === "external:IPrimaryService")
    ).toBe(true);
    expect(
      result.edges.some((edge) => edge.type === EdgeKind.DependsOn && edge.to === "external:Company")
    ).toBe(false);
    expect(
      result.edges.some((edge) => edge.type === EdgeKind.DependsOn && edge.to === "external:Product")
    ).toBe(false);
    expect(
      result.edges.some((edge) => edge.type === EdgeKind.DependsOn && edge.to === "external:Services")
    ).toBe(false);
  });

  it("captures symbol and call fingerprints for resolver disambiguation", () => {
    const result = adaptCSharp({
      absolutePath: "C:\\repo\\src\\Worker.cs",
      relativePath: "src/Worker.cs",
      language: CodeLanguage.CSharp,
      contentHash: "hash-4",
      content: `
        namespace My.App;
        public class Worker {
          public T Create<T>(int value) { return default; }
          public void Run() {
            Create<int>(1);
          }
        }
      `
    });

    const workerNode = result.nodes.find((node) => node.name === "Worker");
    expect(workerNode?.metadata?.fullyQualifiedName).toBe("My.App.Worker");
    expect(workerNode?.metadata?.memberKind).toBe("type");

    const runNode = result.nodes.find((node) => node.name === "Run");
    expect(runNode?.metadata?.containingType).toBe("Worker");
    expect(runNode?.metadata?.memberKind).toBe("method");

    const createNode = result.nodes.find((node) => node.name === "Create");
    expect(createNode?.metadata?.arity).toBe(1);
    expect(createNode?.metadata?.parameterCount).toBe(1);

    const createCall = result.edges.find((edge) => edge.type === EdgeKind.Calls && edge.to === "external:Create");
    expect(createCall?.metadata?.argCount).toBe(1);
    expect(createCall?.metadata?.genericArity).toBe(1);
    expect(createCall?.metadata?.receiverType).toBe("Worker");
  });

  it("captures alias, static, and global using metadata on import edges", () => {
    const result = adaptCSharp({
      absolutePath: "C:\\repo\\src\\Worker.cs",
      relativePath: "src/Worker.cs",
      language: CodeLanguage.CSharp,
      contentHash: "hash-5",
      content: `
        global using Shared.Tools;
        using Alias = App.Services;
        using static App.Utility.Factory;
        public class Worker {}
      `
    });

    const aliasImport = result.edges.find(
      (edge) => edge.type === EdgeKind.Imports && edge.to === "module:App.Services"
    );
    expect(aliasImport?.metadata?.usingKind).toBe("alias");
    expect(aliasImport?.metadata?.alias).toBe("Alias");
    expect(aliasImport?.metadata?.globalUsing).toBe(false);
    expect(aliasImport?.metadata?.staticImport).toBe(false);
    expect(aliasImport?.metadata?.implicitUsing).toBe(false);

    const staticImport = result.edges.find(
      (edge) => edge.type === EdgeKind.Imports && edge.to === "module:App.Utility.Factory"
    );
    expect(staticImport?.metadata?.usingKind).toBe("static");
    expect(staticImport?.metadata?.staticImport).toBe(true);

    const globalImport = result.edges.find(
      (edge) => edge.type === EdgeKind.Imports && edge.to === "module:Shared.Tools"
    );
    expect(globalImport?.metadata?.globalUsing).toBe(true);
    expect(globalImport?.metadata?.usingKind).toBe("namespace");

    const implicitImport = result.edges.find(
      (edge) => edge.type === EdgeKind.Imports && edge.to === "module:System.Linq"
    );
    expect(implicitImport?.metadata?.implicitUsing).toBe(true);
    expect(implicitImport?.metadata?.globalUsing).toBe(true);
  });
});
