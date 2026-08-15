import type { RunSnapshot } from "./types.ts";
import { FLEET_STATUS_TAGS, TERMINAL_FLEET_STATES, type FleetState } from "./constants.ts";
import { displayRuns } from "./observability.ts";

const clamp = (s: string, width: number): string => {
  if (width <= 0) return "";
  if (s.length <= width) return s;
  return width <= 3 ? s.slice(0, width) : `${s.slice(0, width - 3)}...`;
};
const seconds = (ms: number | null | undefined): string => `${((ms ?? 0) / 1000).toFixed(1)}s`;
const shortId = (id: string): string => id.replace(/^run-/, "").slice(0, 8);
const activityTime = (iso: string | null): string => iso ? iso.slice(11, 19) : "-";

export interface FleetWidgetOptions {
  lines?: number;
  nowMs?: number;
}

export function fleetCounts(runs: readonly RunSnapshot[]) {
  return {
    running: runs.filter((r) => r.state === "running").length,
    queued: runs.filter((r) => r.state === "queued").length,
    failed: runs.filter((r) => r.state === "failed" || r.state === "timed_out" || r.state === "aborted").length,
    retained: runs.filter((r) => TERMINAL_FLEET_STATES.has(r.state)).length,
  };
}

/** Exact three-line passive widget template, bounded to terminal width. */
export function renderFleetWidget(runs: readonly RunSnapshot[] = displayRuns(), width = 120, options: FleetWidgetOptions = {}): string[] {
  const budget = Math.max(1, Math.min(8, options.lines ?? 3));
  const now = options.nowMs ?? Date.now();
  const counts = fleetCounts(runs);
  const cost = runs.reduce((sum, r) => sum + r.usage.cost, 0);
  const active = runs.filter((r) => !TERMINAL_FLEET_STATES.has(r.state));
  const current = active[0] ?? runs[0];
  const stale = runs.filter((r) => r.stale).length;
  const tools = runs.reduce((sum, r) => sum + r.activity.filter((e) => e.kind === "tool_result").length, 0);
  const turns = runs.reduce((sum, r) => sum + r.usage.turns, 0);
  const lines: string[] = [];
  lines.push(clamp(`OPS  run=${counts.running} wait=${counts.queued} err=${counts.failed} kept=${counts.retained} cost=$${cost.toFixed(4)}`, width));
  if (budget >= 2) {
    if (current) {
      const elapsed = current.elapsedMs ?? (current.startedAt ? now - Date.parse(current.startedAt) : 0);
      const timeout = current.timeoutEffectiveSeconds === null ? "-" : `${current.timeoutEffectiveSeconds}s`;
      const status = FLEET_STATUS_TAGS[current.state as FleetState] ?? `[${current.state.toUpperCase()}]`;
      lines.push(clamp(`> ${status} ${shortId(current.runId)} ${current.agent}  ${seconds(elapsed)}/${timeout}  ${activityTime(current.lastActivityAt)}`, width));
    } else {
      lines.push(clamp("> [WAIT] - no active runs", width));
    }
  }
  if (budget >= 3) lines.push(clamp(`Alt+O fleet | stale=${stale} | tools=${tools} | turns=${turns}`, width));
  if (budget > 3) {
    for (const run of active.slice(1, budget - 2)) {
      lines.push(clamp(`  ${FLEET_STATUS_TAGS[run.state as FleetState] ?? `[${run.state}]`} ${shortId(run.runId)} ${run.agent} ${run.taskLabel}`, width));
    }
  }
  return lines.slice(0, budget);
}

export class FleetWidget {
  constructor(private readonly options: FleetWidgetOptions = {}) {}
  render(width: number): string[] { return renderFleetWidget(displayRuns(), width, this.options); }
  invalidate(): void {}
}

export function createFleetWidget(options: FleetWidgetOptions = {}): FleetWidget {
  return new FleetWidget(options);
}
