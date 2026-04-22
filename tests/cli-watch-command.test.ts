import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runCliOnce(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: path.resolve(process.cwd()),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("cli watch command", () => {
  it("includes watch and legacy commands in top-level help", async () => {
    const result = await runCliOnce(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("index");
    expect(result.stdout).toContain("update");
    expect(result.stdout).toContain("query");
    expect(result.stdout).toContain("mcp-stdio");
    expect(result.stdout).toContain("visualize");
    expect(result.stdout).toContain("watch");
    expect(result.stderr).not.toContain("watch error:");
  });

  it("starts watching and shuts down gracefully on SIGINT", async () => {
    const repoDir = await mkdtemp(path.join(process.cwd(), ".yggdrasil-cli-watch-"));
    tempDirs.push(repoDir);

    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const child = spawn("node", ["--import", "tsx", "src/cli.ts", "watch", "--repo", repoDir, "--languages", "typescript", "--watch-debounce", "0", "--runtime-debounce", "0"], {
      cwd: path.resolve(process.cwd()),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await waitFor(() => stdout.includes('"status": "watching"'));
    child.kill("SIGINT");

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"status": "stopping"');
    expect(stdout).toContain('"status": "stopped"');
    expect(stderr).not.toContain("watch error:");
  });
});
