import { describe, expect, it } from "vitest";
import { adaptTypeScript } from "../src/adapters/typescript-adapter.js";
import { CodeLanguage, EdgeKind, NodeKind } from "../src/types/graph.js";

describe("adaptTypeScript", () => {
  it("extracts file, symbols, import edges, and call edges", () => {
    const result = adaptTypeScript({
      absolutePath: "C:\\repo\\src\\service.ts",
      relativePath: "src/service.ts",
      language: CodeLanguage.TypeScript,
      contentHash: "abc123",
      content: `
        import { foo } from "./dep";
        export function processOrder() {
          foo();
        }
      `
    });

    const symbolNames = result.nodes.filter((node) => node.kind === NodeKind.Symbol).map((node) => node.name);
    expect(symbolNames).toContain("processOrder");
    expect(result.edges.some((edge) => edge.type === EdgeKind.Imports)).toBe(true);
    expect(result.edges.some((edge) => edge.type === EdgeKind.Calls)).toBe(true);
  });

  it("captures class/type references as depends_on edges", () => {
    const result = adaptTypeScript({
      absolutePath: "C:\\repo\\src\\consumer.ts",
      relativePath: "src/consumer.ts",
      language: CodeLanguage.TypeScript,
      contentHash: "def456",
      content: `
        class PrimaryService {}
        class Worker extends PrimaryService {}
        function build(svc: PrimaryService) {
          return new PrimaryService();
        }
      `
    });

    const hasDependency = result.edges.some(
      (edge) => edge.type === EdgeKind.DependsOn && edge.to === "external:PrimaryService"
    );
    expect(hasDependency).toBe(true);
  });
});
