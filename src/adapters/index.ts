import { adaptCSharp } from "./csharp-adapter.js";
import { adaptTypeScript } from "./typescript-adapter.js";
import { AdapterOutput, CodeLanguage, ScannedFile } from "../types/graph.js";

export function adaptFile(file: ScannedFile): AdapterOutput {
  switch (file.language) {
    case CodeLanguage.TypeScript:
    case CodeLanguage.JavaScript:
      return adaptTypeScript(file);
    case CodeLanguage.CSharp:
      return adaptCSharp(file);
    default:
      return { nodes: [], edges: [] };
  }
}
