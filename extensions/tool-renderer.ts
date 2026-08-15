import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { FLEET_STATUS_TAGS, type FleetState } from "./constants.ts";

export interface RenderOutcome {
  state: FleetState | string;
  agent: string;
  runId: string;
  elapsedMs?: number | null;
  digest?: string | null;
  errorMessage?: string | null;
  stopReason?: string | null;
}

export interface RenderDetails {
  mode?: string;
  durationMs?: number;
  aggregate?: { turns?: number; cost?: number };
  outcomes?: RenderOutcome[];
}

const shortId = (id: string): string => id.startsWith("run-") ? id.slice(4, 12) : id.slice(0, 8);
const duration = (ms: number | null | undefined): string => `${((ms ?? 0) / 1000).toFixed(1)}s`;
const tag = (state: string): string => FLEET_STATUS_TAGS[state as FleetState] ?? `[${state.toUpperCase()}]`;

function detailsOf(result: any): RenderDetails {
  return (result?.details ?? {}) as RenderDetails;
}

/** Plain, theme-independent collapsed text used by snapshots and headless tests. */
export function renderResultText(details: RenderDetails, expanded = false): string {
  const outcomes = details.outcomes ?? [];
  const done = outcomes.filter((o) => o.state === "done").length;
  const failed = outcomes.length - done;
  const mode = details.mode ?? "single";
  const aggregate = details.aggregate ?? {};
  const lines = [`subagent ${mode}: ok=${done} err=${failed} time=${duration(details.durationMs)} turns=${aggregate.turns ?? 0} cost=$${(aggregate.cost ?? 0).toFixed(4)}`];
  const shown = expanded ? outcomes : outcomes.slice(0, 8);
  for (const outcome of shown) {
    if (outcome.state === "done") {
      const preview = (outcome.digest ?? "").split("\n")[0]?.slice(0, 160) ?? "";
      lines.push(`  ${tag(outcome.state)} ${outcome.agent} ${shortId(outcome.runId)} ${duration(outcome.elapsedMs)}${preview ? ` ${preview}` : ""}`);
    } else {
      const reason = outcome.errorMessage ?? outcome.stopReason ?? outcome.state;
      lines.push(`  ${tag(outcome.state)} ${outcome.agent} ${shortId(outcome.runId)} ${reason}`);
    }
  }
  if (!expanded && outcomes.length > shown.length) lines.push(`  ... ${outcomes.length - shown.length} more`);
  return lines.join("\n");
}

/** pi custom-tool renderer for the invocation row. */
export function renderCall(args: any, theme: Theme): Text {
  const mode = args?.mode ?? (args?.tasks ? "parallel" : args?.chain ? "chain" : "single");
  const label = args?.agent ?? args?.tasks?.[0]?.agent ?? args?.chain?.[0]?.agent ?? "fleet";
  const task = args?.task ?? args?.tasks?.[0]?.task ?? args?.chain?.[0]?.task ?? "";
  const text = `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", String(mode))} ${theme.fg("accent", String(label))}${task ? ` ${theme.fg("dim", task)}` : ""}`;
  return new Text(text, 0, 0);
}

/** pi custom-tool renderer for collapsed/expanded results. */
export function renderResult(result: any, options: { expanded: boolean }, theme: Theme): Text {
  const plain = renderResultText(detailsOf(result), options.expanded);
  const lines = plain.split("\n");
  const styled = lines.map((line) => {
    if (line.includes("[ERR]") || line.includes("[TIME]") || line.includes("[ABRT]")) return theme.fg("error", line);
    if (line.includes("[OK]")) return theme.fg("success", line);
    return line;
  }).join("\n");
  return new Text(styled, 0, 0);
}

export const renderSubagentCall = renderCall;
export const renderSubagentResult = renderResult;
