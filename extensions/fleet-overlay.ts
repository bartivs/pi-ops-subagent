import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { RunSnapshot } from "./types.ts";
import { displayRuns, dismissRun } from "./observability.ts";
import { FLEET_STATUS_TAGS, TERMINAL_FLEET_STATES, type FleetState } from "./constants.ts";

const shortId = (id: string): string => id.replace(/^run-/, "").slice(0, 10);
const duration = (run: RunSnapshot): string => `${((run.elapsedMs ?? 0) / 1000).toFixed(1)}s`;
const nowOrFinished = (run: RunSnapshot): string => run.finishedAt ?? new Date().toISOString();
const tag = (state: string): string => FLEET_STATUS_TAGS[state as FleetState] ?? `[${state.toUpperCase()}]`;
const fit = (s: string, width: number): string => truncateToWidth(s, Math.max(0, width), "");
const pad = (s: string, n: number): string => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
const frame = (title: string): string => `+ ${title} ${"-".repeat(Math.max(0, 96 - title.length))}+`;
const row = (content: string): string => `| ${pad(content, 96)} |`;

export interface OverlayRenderOptions { selected?: number; detail?: boolean; nowMs?: number; }

function currentRuns(runs: readonly RunSnapshot[]): RunSnapshot[] {
  return [...runs].sort((a, b) => (a.runId > b.runId ? 1 : -1));
}

/** Render the normative responsive fleet overlay. Every returned line is width-safe. */
export function renderFleetOverlay(runs: readonly RunSnapshot[] = displayRuns(), width = 100, options: OverlayRenderOptions = {}): string[] {
  const ordered = currentRuns(runs);
  const selected = Math.max(0, Math.min(options.selected ?? 0, Math.max(0, ordered.length - 1)));
  const selectedRun = ordered[selected];
  const counts = {
    running: ordered.filter((r) => r.state === "running").length,
    queued: ordered.filter((r) => r.state === "queued").length,
    failed: ordered.filter((r) => r.state === "failed" || r.state === "timed_out" || r.state === "aborted").length,
  };

  if (width < 40) {
    const run = selectedRun;
    return [
      fit(`OPS ${counts.running} run ${counts.failed} err`, width),
      fit(run ? `${tag(run.state)} ${run.agent}` : "[WAIT] no fleet", width),
      fit(run ? `${duration(run)}/${run.timeoutEffectiveSeconds ?? "-"}s` : "-", width),
      fit("Alt+O", width),
    ];
  }

  if (width < 100) {
    const lines = [`OPS FLEET  run=${counts.running} wait=${counts.queued} err=${counts.failed}`];
    ordered.slice(0, 8).forEach((run, i) => lines.push(`${i === selected ? ">" : " "} ${i + 1} ${tag(run.state)} ${run.agent} ${duration(run)}/${run.timeoutEffectiveSeconds ?? "-"}`));
    if (selectedRun) {
      lines.push(`-- DETAIL ${shortId(selectedRun.runId)} --`);
      lines.push(`agent: ${selectedRun.agent}  mode: ${selectedRun.mode}`);
      lines.push(`last: ${selectedRun.lastActivityAt ?? "-"}`);
      lines.push(`cost: $${selectedRun.usage.cost.toFixed(4)}  turns: ${selectedRun.usage.turns}`);
      lines.push("-- ACTIVITY --");
      const activity = selectedRun.activity.at(-1);
      if (activity) lines.push(`${activity.timestamp.slice(11, 19)} ${activity.kind} ${activity.detail}`);
      lines.push("-- DIGEST --");
      lines.push((selectedRun.digest ?? "-").split("\n")[0] ?? "-");
    }
    lines.push("[Tab] next [Enter] detail [q] close");
    return lines.map((line) => fit(line, width));
  }

  const lines: string[] = [frame("OPS FLEET"), row("#  | RUN          | AGENT            | STATE   | ELAPSED/TIMEOUT   | LAST")];
  ordered.slice(0, 8).forEach((run, i) => {
    const marker = i === selected ? ">" : " ";
    const content = `${marker}${i + 1} | ${pad(shortId(run.runId), 12)} | ${pad(run.agent, 16)} | ${pad(tag(run.state), 7)} | ${pad(`${duration(run)}/${run.timeoutEffectiveSeconds ?? "-"}`, 17)} | ${pad(run.lastActivityAt?.slice(11, 19) ?? "-", 28)}`;
    lines.push(row(content));
  });
  lines.push(frame("RUN DETAIL"));
  if (selectedRun) {
    lines.push(row(`id: ${selectedRun.runId}  mode: ${selectedRun.mode}  source: ${selectedRun.agentSource ?? "-"}`));
    lines.push(row(`task: ${selectedRun.taskLabel}  model: ${selectedRun.model ?? "-"}  cwd: ${selectedRun.cwd}`));
    lines.push(row(`time: ${selectedRun.startedAt ?? "-"} -> ${nowOrFinished(selectedRun)}  cost: $${selectedRun.usage.cost.toFixed(4)}`));
    lines.push(frame("ACTIVITY"));
    for (const event of selectedRun.activity.slice(-4)) lines.push(row(`${event.timestamp.slice(11, 19)}  ${event.kind} ${event.detail}`));
    lines.push(frame("DIGEST"));
    for (const digestLine of (selectedRun.digest ?? "-").split("\n").slice(0, 3)) lines.push(row(digestLine));
  } else {
    lines.push(row("no retained runs"));
    lines.push(frame("ACTIVITY"), row("-"), frame("DIGEST"), row("-"));
  }
  lines.push(frame("[Tab/Shift+Tab] select  [Enter] detail  [f] follow  [d] dismiss  [q] close"));
  return lines.map((line) => fit(line, width));
}

export class FleetOverlayComponent {
  private selected = 0;
  private detail = true;
  private follow = false;
  constructor(private readonly onClose: () => void, private readonly requestRender: () => void) {}

  handleInput(data: string): void {
    const runs = currentRuns(displayRuns());
    if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.alt("o"))) return this.onClose();
    if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) this.selected = runs.length ? (this.selected + 1) % runs.length : 0;
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) this.selected = runs.length ? (this.selected + runs.length - 1) % runs.length : 0;
    else if (matchesKey(data, Key.enter)) this.detail = !this.detail;
    else if (data === "s") this.detail = false;
    else if (data === "f") this.follow = !this.follow;
    else if (data === "d" && runs[this.selected] && TERMINAL_FLEET_STATES.has(runs[this.selected]!.state)) {
      dismissRun(runs[this.selected]!.runId);
      this.selected = Math.max(0, this.selected - 1);
    } else if (/^[1-9]$/.test(data)) this.selected = Math.min(Number(data) - 1, Math.max(0, runs.length - 1));
    this.requestRender();
  }

  render(width: number): string[] {
    return renderFleetOverlay(displayRuns(), width, { selected: this.selected, detail: this.detail });
  }
  invalidate(): void {}
  isFollowing(): boolean { return this.follow; }
}

export function createFleetOverlay(onClose: () => void, requestRender: () => void): FleetOverlayComponent {
  return new FleetOverlayComponent(onClose, requestRender);
}
