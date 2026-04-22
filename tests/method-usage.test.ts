import { describe, expect, it } from "vitest";
import { deriveMethodName } from "../src/query/method-usage.js";

describe("deriveMethodName", () => {
  it("extracts method name from symbol id format", () => {
    expect(deriveMethodName("symbol:src/services/PromotionService.cs#GetUserAreaOfStudyGroups@1581")).toBe(
      "GetUserAreaOfStudyGroups"
    );
  });

  it("extracts method name from qualified names", () => {
    expect(deriveMethodName("PromotionService.GetUserAreaOfStudyGroups")).toBe("GetUserAreaOfStudyGroups");
  });

  it("extracts trailing method token from natural language style prompts", () => {
    expect(deriveMethodName("Find where PromotionService GetUserAreaOfStudyGroups is used")).toBe(
      "GetUserAreaOfStudyGroups"
    );
  });

  it("falls back to trimmed input when extraction would be empty", () => {
    expect(deriveMethodName("   PromotionService   ")).toBe("PromotionService");
  });
});
