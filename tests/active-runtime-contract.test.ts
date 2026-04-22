import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUNTIME_CONTRACT,
  beginIncrementalUpdate,
  completeIncrementalUpdate,
  createActiveRuntimeState,
  enqueueRuntimeChanges,
  freshnessStatusAt,
  runtimeStatusSnapshotAt,
  scheduleDebouncedIncrementalUpdate,
  shouldRunIncrementalUpdate,
  transitionLifecycle
} from "../src/runtime/active-runtime-contract.js";

describe("active runtime contract", () => {
  it("locks query serving to SQLite and parse state to ingestion acceleration", () => {
    expect(ACTIVE_RUNTIME_CONTRACT).toEqual({
      queryServingSourceOfTruth: "sqlite",
      ingestionAccelerationRole: "in_memory_parse_ast_only"
    });
  });

  it("enforces lifecycle transitions", () => {
    const initial = createActiveRuntimeState();
    const starting = transitionLifecycle(initial, "starting", 100);
    const running = transitionLifecycle(starting, "running", 120);
    expect(running.lifecycle).toBe("running");
    expect(() => transitionLifecycle(running, "starting", 130)).toThrow(/Invalid lifecycle transition/i);
  });

  it("deduplicates queued file changes and preserves earliest detection timestamp", () => {
    const initial = createActiveRuntimeState({ lifecycle: "running" });
    const first = enqueueRuntimeChanges(initial, ["src/a.ts", "src/b.ts"], 200);
    const second = enqueueRuntimeChanges(first, ["src/a.ts", "src/c.ts", "  "], 240);
    const third = enqueueRuntimeChanges(second, ["src/a.ts"], 150);

    expect(third.changeQueue).toEqual([
      { filePath: "src/a.ts", detectedAtMs: 150 },
      { filePath: "src/b.ts", detectedAtMs: 200 },
      { filePath: "src/c.ts", detectedAtMs: 240 }
    ]);
    expect(third.queuedAtMs).toBe(150);
    expect(third.freshness.lastQueuedChangeAtMs).toBe(240);
  });

  it("schedules debounce and starts incremental updates once window elapses", () => {
    const running = createActiveRuntimeState({ lifecycle: "running" });
    const queued = enqueueRuntimeChanges(running, ["src/a.ts", "src/b.ts"], 1_000);
    const scheduled = scheduleDebouncedIncrementalUpdate(queued, { nowMs: 1_050, debounceMs: 100 });

    expect(scheduled.debounceUntilMs).toBe(1_150);
    expect(shouldRunIncrementalUpdate(scheduled, 1_149)).toBe(false);
    expect(shouldRunIncrementalUpdate(scheduled, 1_150)).toBe(true);

    const started = beginIncrementalUpdate(scheduled, 1_150);
    expect(started?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(started?.state.lifecycle).toBe("updating");
    expect(started?.state.inFlightUpdate?.startedAtMs).toBe(1_150);
    expect(started?.state.freshness.lastAttemptedUpdateAtMs).toBe(1_150);
    expect(started?.state.changeQueue).toEqual([]);
  });

  it("tracks freshness windows from successful completions", () => {
    const running = transitionLifecycle(transitionLifecycle(createActiveRuntimeState(), "starting", 10), "running", 11);
    const queued = enqueueRuntimeChanges(running, ["src/a.ts"], 100);
    const scheduled = scheduleDebouncedIncrementalUpdate(queued, { nowMs: 120, debounceMs: 0 });
    const started = beginIncrementalUpdate(scheduled, 121);
    expect(started).not.toBeNull();

    const completed = completeIncrementalUpdate(started!.state, { completedAtMs: 150, success: true });
    expect(completed.lifecycle).toBe("running");
    expect(completed.freshness.lastSuccessfulUpdateAtMs).toBe(150);
    expect(freshnessStatusAt(completed.freshness, 200)).toBe("fresh");
    expect(freshnessStatusAt(completed.freshness, 61_000 + 150)).toBe("stale");
  });

  it("keeps timestamps monotonic and records failure metadata", () => {
    const running = transitionLifecycle(transitionLifecycle(createActiveRuntimeState(), "starting", 10), "running", 11);
    const queued = enqueueRuntimeChanges(running, ["src/a.ts"], 100);
    const scheduled = scheduleDebouncedIncrementalUpdate(queued, { nowMs: 100, debounceMs: 0 });
    const started = beginIncrementalUpdate(scheduled, 120)!;
    const succeeded = completeIncrementalUpdate(started.state, { completedAtMs: 200, success: true });

    const queuedAgain = enqueueRuntimeChanges(succeeded, ["src/b.ts"], 205);
    const scheduledAgain = scheduleDebouncedIncrementalUpdate(queuedAgain, { nowMs: 205, debounceMs: 0 });
    const startedAgain = beginIncrementalUpdate(scheduledAgain, 210)!;
    const failed = completeIncrementalUpdate(startedAgain.state, {
      completedAtMs: 190,
      success: false,
      errorMessage: "sqlite busy"
    });

    expect(failed.lifecycle).toBe("failed");
    expect(failed.lastError).toBe("sqlite busy");
    expect(failed.freshness.lastSuccessfulUpdateAtMs).toBe(200);
    expect(failed.freshness.lastAttemptedUpdateAtMs).toBe(210);
  });

  it("summarizes lightweight runtime status for diagnostics", () => {
    const running = transitionLifecycle(transitionLifecycle(createActiveRuntimeState(), "starting", 10), "running", 11);
    const queued = enqueueRuntimeChanges(running, ["src/a.ts"], 100);
    const scheduled = scheduleDebouncedIncrementalUpdate(queued, { nowMs: 120, debounceMs: 25 });

    const debouncingSnapshot = runtimeStatusSnapshotAt(scheduled, 130);
    expect(debouncingSnapshot.pending.state).toBe("debouncing");
    expect(debouncingSnapshot.pending.queueSize).toBe(1);
    expect(debouncingSnapshot.lastQueuedChangeAtMs).toBe(100);

    const started = beginIncrementalUpdate(scheduled, 145)!;
    const processingSnapshot = runtimeStatusSnapshotAt(started.state, 150);
    expect(processingSnapshot.pending.state).toBe("processing");
    expect(processingSnapshot.inFlight?.fileCount).toBe(1);

    const completed = completeIncrementalUpdate(started.state, { completedAtMs: 180, success: true });
    const idleSnapshot = runtimeStatusSnapshotAt(completed, 190);
    expect(idleSnapshot.pending.state).toBe("idle");
    expect(idleSnapshot.pending.queueSize).toBe(0);
    expect(idleSnapshot.freshnessStatus).toBe("fresh");
    expect(idleSnapshot.lastSuccessfulUpdateAtMs).toBe(180);
  });
});
