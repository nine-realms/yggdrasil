export const ACTIVE_RUNTIME_CONTRACT = {
  queryServingSourceOfTruth: "sqlite",
  ingestionAccelerationRole: "in_memory_parse_ast_only"
} as const;

export type ActiveRuntimeLifecycle =
  | "stopped"
  | "starting"
  | "running"
  | "updating"
  | "stopping"
  | "failed";

export type RuntimeFreshnessStatus = "unknown" | "fresh" | "stale";

export interface RuntimeFreshnessMetadata {
  staleAfterMs: number;
  lastAttemptedUpdateAtMs: number | null;
  lastSuccessfulUpdateAtMs: number | null;
  lastQueuedChangeAtMs: number | null;
}

export interface QueuedChange {
  filePath: string;
  detectedAtMs: number;
}

export interface InFlightIncrementalUpdate {
  startedAtMs: number;
  changedFiles: string[];
}

export interface ActiveRuntimeState {
  lifecycle: ActiveRuntimeLifecycle;
  lifecycleUpdatedAtMs: number | null;
  changeQueue: QueuedChange[];
  queuedAtMs: number | null;
  debounceUntilMs: number | null;
  inFlightUpdate: InFlightIncrementalUpdate | null;
  freshness: RuntimeFreshnessMetadata;
  lastError: string | null;
}

export type RuntimePendingQueueState = "idle" | "debouncing" | "queued" | "processing";

export interface RuntimeStatusSnapshot {
  lifecycle: ActiveRuntimeLifecycle;
  lifecycleUpdatedAtMs: number | null;
  freshnessStatus: RuntimeFreshnessStatus;
  lastAttemptedUpdateAtMs: number | null;
  lastSuccessfulUpdateAtMs: number | null;
  lastQueuedChangeAtMs: number | null;
  pending: {
    state: RuntimePendingQueueState;
    queueSize: number;
    queuedAtMs: number | null;
    debounceUntilMs: number | null;
  };
  inFlight: {
    startedAtMs: number;
    fileCount: number;
  } | null;
  lastError: string | null;
}

const LIFECYCLE_TRANSITIONS: Record<ActiveRuntimeLifecycle, ActiveRuntimeLifecycle[]> = {
  stopped: ["starting"],
  starting: ["running", "failed", "stopping"],
  running: ["updating", "failed", "stopping"],
  updating: ["running", "failed", "stopping"],
  stopping: ["stopped", "failed"],
  failed: ["starting", "stopping", "stopped"]
};

function normalizeTimestampMs(timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) {
    throw new Error("timestampMs must be a finite number.");
  }
  return Math.max(0, Math.trunc(timestampMs));
}

function assertNonNegativeMs(ms: number, fieldName: string): number {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number.`);
  }
  return Math.trunc(ms);
}

function pushTimestamp(currentValue: number | null, nextValue: number): number {
  return currentValue === null ? nextValue : Math.max(currentValue, nextValue);
}

export function createActiveRuntimeState(options?: {
  staleAfterMs?: number;
  lifecycle?: ActiveRuntimeLifecycle;
}): ActiveRuntimeState {
  const staleAfterMs = assertNonNegativeMs(options?.staleAfterMs ?? 60_000, "staleAfterMs");
  const lifecycle = options?.lifecycle ?? "stopped";

  return {
    lifecycle,
    lifecycleUpdatedAtMs: null,
    changeQueue: [],
    queuedAtMs: null,
    debounceUntilMs: null,
    inFlightUpdate: null,
    freshness: {
      staleAfterMs,
      lastAttemptedUpdateAtMs: null,
      lastSuccessfulUpdateAtMs: null,
      lastQueuedChangeAtMs: null
    },
    lastError: null
  };
}

export function transitionLifecycle(
  state: ActiveRuntimeState,
  nextLifecycle: ActiveRuntimeLifecycle,
  atMs: number,
  errorMessage?: string
): ActiveRuntimeState {
  const normalizedAtMs = normalizeTimestampMs(atMs);
  const allowed = LIFECYCLE_TRANSITIONS[state.lifecycle] ?? [];
  if (!allowed.includes(nextLifecycle) && state.lifecycle !== nextLifecycle) {
    throw new Error(`Invalid lifecycle transition: ${state.lifecycle} -> ${nextLifecycle}`);
  }

  return {
    ...state,
    lifecycle: nextLifecycle,
    lifecycleUpdatedAtMs: pushTimestamp(state.lifecycleUpdatedAtMs, normalizedAtMs),
    lastError: nextLifecycle === "failed" ? errorMessage ?? state.lastError ?? "Active runtime failed." : null
  };
}

export function enqueueRuntimeChanges(
  state: ActiveRuntimeState,
  changedFiles: string[],
  detectedAtMs: number
): ActiveRuntimeState {
  const normalizedAtMs = normalizeTimestampMs(detectedAtMs);
  if (changedFiles.length === 0) {
    return state;
  }

  const byPath = new Map(state.changeQueue.map((change) => [change.filePath, change] as const));
  for (const filePath of changedFiles) {
    const normalizedPath = filePath.trim();
    if (normalizedPath.length === 0) {
      continue;
    }

    const existing = byPath.get(normalizedPath);
    if (!existing) {
      byPath.set(normalizedPath, { filePath: normalizedPath, detectedAtMs: normalizedAtMs });
      continue;
    }

    byPath.set(normalizedPath, {
      filePath: normalizedPath,
      detectedAtMs: Math.min(existing.detectedAtMs, normalizedAtMs)
    });
  }

  const nextQueue = Array.from(byPath.values()).sort(
    (a, b) => a.detectedAtMs - b.detectedAtMs || a.filePath.localeCompare(b.filePath)
  );

  if (nextQueue.length === state.changeQueue.length && state.changeQueue.every((change, index) => change === nextQueue[index])) {
    return state;
  }

  return {
    ...state,
    changeQueue: nextQueue,
    queuedAtMs: nextQueue.length === 0 ? null : nextQueue[0].detectedAtMs,
    freshness: {
      ...state.freshness,
      lastQueuedChangeAtMs: pushTimestamp(state.freshness.lastQueuedChangeAtMs, normalizedAtMs)
    }
  };
}

export function scheduleDebouncedIncrementalUpdate(
  state: ActiveRuntimeState,
  options: { nowMs: number; debounceMs: number }
): ActiveRuntimeState {
  if (state.changeQueue.length === 0) {
    return {
      ...state,
      debounceUntilMs: null
    };
  }

  const nowMs = normalizeTimestampMs(options.nowMs);
  const debounceMs = assertNonNegativeMs(options.debounceMs, "debounceMs");

  return {
    ...state,
    debounceUntilMs: nowMs + debounceMs
  };
}

export function shouldRunIncrementalUpdate(state: ActiveRuntimeState, nowMs: number): boolean {
  const normalizedAtMs = normalizeTimestampMs(nowMs);
  return (
    state.lifecycle === "running" &&
    state.inFlightUpdate === null &&
    state.changeQueue.length > 0 &&
    (state.debounceUntilMs === null || normalizedAtMs >= state.debounceUntilMs)
  );
}

export function beginIncrementalUpdate(
  state: ActiveRuntimeState,
  startedAtMs: number
): { state: ActiveRuntimeState; changedFiles: string[] } | null {
  const normalizedAtMs = normalizeTimestampMs(startedAtMs);
  if (!shouldRunIncrementalUpdate(state, normalizedAtMs)) {
    return null;
  }

  const changedFiles = state.changeQueue.map((change) => change.filePath);

  return {
    changedFiles,
    state: {
      ...state,
      lifecycle: "updating",
      lifecycleUpdatedAtMs: pushTimestamp(state.lifecycleUpdatedAtMs, normalizedAtMs),
      inFlightUpdate: {
        startedAtMs: normalizedAtMs,
        changedFiles
      },
      freshness: {
        ...state.freshness,
        lastAttemptedUpdateAtMs: pushTimestamp(state.freshness.lastAttemptedUpdateAtMs, normalizedAtMs)
      },
      changeQueue: [],
      queuedAtMs: null,
      debounceUntilMs: null,
      lastError: null
    }
  };
}

export function completeIncrementalUpdate(
  state: ActiveRuntimeState,
  result: { completedAtMs: number; success: boolean; errorMessage?: string }
): ActiveRuntimeState {
  if (state.inFlightUpdate === null) {
    throw new Error("Cannot complete incremental update without an in-flight update.");
  }

  const completedAtMs = normalizeTimestampMs(result.completedAtMs);
  const lifecycle: ActiveRuntimeLifecycle = result.success ? "running" : "failed";

  return {
    ...state,
    lifecycle,
    lifecycleUpdatedAtMs: pushTimestamp(state.lifecycleUpdatedAtMs, completedAtMs),
    inFlightUpdate: null,
    freshness: {
      ...state.freshness,
      lastAttemptedUpdateAtMs: pushTimestamp(state.freshness.lastAttemptedUpdateAtMs, completedAtMs),
      lastSuccessfulUpdateAtMs: result.success
        ? pushTimestamp(state.freshness.lastSuccessfulUpdateAtMs, completedAtMs)
        : state.freshness.lastSuccessfulUpdateAtMs
    },
    lastError: result.success ? null : result.errorMessage ?? "Incremental update failed."
  };
}

export function freshnessStatusAt(metadata: RuntimeFreshnessMetadata, nowMs: number): RuntimeFreshnessStatus {
  const normalizedAtMs = normalizeTimestampMs(nowMs);
  if (metadata.lastSuccessfulUpdateAtMs === null) {
    return "unknown";
  }

  if (normalizedAtMs - metadata.lastSuccessfulUpdateAtMs > metadata.staleAfterMs) {
    return "stale";
  }

  return "fresh";
}

function pendingQueueStateAt(state: ActiveRuntimeState, nowMs: number): RuntimePendingQueueState {
  if (state.inFlightUpdate !== null) {
    return "processing";
  }
  if (state.changeQueue.length === 0) {
    return "idle";
  }
  if (state.debounceUntilMs !== null && normalizeTimestampMs(nowMs) < state.debounceUntilMs) {
    return "debouncing";
  }
  return "queued";
}

export function runtimeStatusSnapshotAt(state: ActiveRuntimeState, nowMs: number): RuntimeStatusSnapshot {
  const normalizedAtMs = normalizeTimestampMs(nowMs);
  return {
    lifecycle: state.lifecycle,
    lifecycleUpdatedAtMs: state.lifecycleUpdatedAtMs,
    freshnessStatus: freshnessStatusAt(state.freshness, normalizedAtMs),
    lastAttemptedUpdateAtMs: state.freshness.lastAttemptedUpdateAtMs,
    lastSuccessfulUpdateAtMs: state.freshness.lastSuccessfulUpdateAtMs,
    lastQueuedChangeAtMs: state.freshness.lastQueuedChangeAtMs,
    pending: {
      state: pendingQueueStateAt(state, normalizedAtMs),
      queueSize: state.changeQueue.length,
      queuedAtMs: state.queuedAtMs,
      debounceUntilMs: state.debounceUntilMs
    },
    inFlight:
      state.inFlightUpdate === null
        ? null
        : {
            startedAtMs: state.inFlightUpdate.startedAtMs,
            fileCount: state.inFlightUpdate.changedFiles.length
          },
    lastError: state.lastError
  };
}
