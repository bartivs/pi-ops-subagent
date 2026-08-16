/**
 * Minimal, self-contained `ssh` runtime tool for generated agents that act over
 * SSH (e.g. read-only docker/OS inspection probes). Registered by the package
 * so a manifest listing `tools: ["ssh", ...]` is actually runnable.
 *
 * Safety:
 * - Spawns the local `ssh` binary with an argv (no local shell string), so the
 *   remote `command` cannot inject local shell metacharacters.
 * - `host` and `identity` reject whitespace/control chars and leading `-` to
 *   avoid option-injection via the argv edge.
 * - Requires a trusted project; when an interactive UI is present it asks for
 *   confirmation before opening a connection.
 * - BatchMode avoids interactive password hangs; use an identity/agent.
 * - Timeout guarantees the connection is killed even if the remote hangs.
 * - Output is bounded and passed through `redactSensitive`.
 */
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { redactSensitive } from "./redact.ts";
import { truncateUtf8 } from "./usage-guidance.ts";

export const SSH_TOOL = "ssh" as const;

/** Host-safe pattern: hostname, dot-separated FQDN, IPv4, or configured alias. */
const HOST_RE = "^[a-zA-Z0-9][-a-zA-Z0-9._]{0,252}$";
/** Identity path: no control chars, no leading dash (option-injection guard). */
const FILE_ARG_RE = "^[^-][^\\x00-\\x1f\\x7f]*$";

/** TypeBox parameters; every field is a validated leaf with no unknown keys. */
export const SSHPARAMETERS = Type.Object(
  {
    host: Type.String({ pattern: HOST_RE, description: "SSH host name, FQDN, IPv4, or configured alias." }),
    command: Type.String({ minLength: 1, description: "Remote shell command to run. Read-only commands are recommended; the command is never shell-interpolated locally." }),
    user: Type.Optional(Type.String({ minLength: 1, description: "SSH login user; defaults to the current user." })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "SSH port; defaults to 22." })),
    identity: Type.Optional(Type.String({ pattern: FILE_ARG_RE, description: "Path to an SSH identity private key (-i). Must not begin with '-'." })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Kill the connection after this many seconds (default 60)." })),
  },
  { additionalProperties: false },
);

export interface SshInitParams {
  host: string;
  command: string;
  user?: string;
  port?: number;
  identity?: string;
  timeoutSeconds?: number;
}

export interface SshExecResult {
  exitCode: number;
  output: string;
  error: string;
  timedOut: boolean;
}

export interface SshRunContext {
  hasUI: boolean;
  isProjectTrusted: () => boolean;
  uiConfirm?: (title: string, body: string) => Promise<boolean>;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Injectable runner for tests; defaults to spawning the local `ssh` binary. */
  run?: (params: SshInitParams, timeoutMs: number, signal?: AbortSignal) => Promise<SshExecResult>;
}

function buildArgs(p: SshInitParams): string[] {
  const args: string[] = ["-o", "BatchMode=yes"];
  if (p.user) args.push("-l", p.user);
  if (p.port) args.push("-p", String(p.port));
  if (p.identity) args.push("-i", p.identity);
  args.push(p.host, p.command);
  return args;
}

function defaultRun(params: SshInitParams, timeoutMs: number, signal?: AbortSignal): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const args = buildArgs(params);
    const child: ChildProcess = spawn("ssh", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 5000);
    }, timeoutMs);
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (d: Buffer) => {
      out = (out + d.toString("utf8")).slice(-8192 * 2);
    });
    child.stderr!.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-16_384);
    });
    child.once("close", (code) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code ?? 1, output: out, error: err, timedOut });
    });
    child.once("error", (e) => {
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: 1, output: out, error: `failed to start ssh: ${e.message}`, timedOut });
    });
  });
}

function redactResult(r: SshExecResult): SshExecResult {
  const o = redactSensitive(r.output);
  const e = redactSensitive(r.error);
  return { exitCode: r.exitCode, output: o.text, error: e.text, timedOut: r.timedOut };
}

/**
 * Runnable seam mirroring the `subagent` executor. Returns a bounded summary;
 * the full bounded output is also carried so callers can choose.
 */
export async function executeSsh(params: SshInitParams, env: SshRunContext): Promise<SshExecResult & { summary: string }> {
  if (!env.isProjectTrusted()) throw new Error("ssh tool requires a trusted project.");
  if (!params.command.trim()) throw new Error("ssh command must not be empty.");
  if (env.hasUI && env.uiConfirm) {
    const ok = await env.uiConfirm("SSH connection", `Open an ssh connection to ${params.user ? `${params.user}@` : ""}${params.host} to run a remote command?`);
    if (!ok) throw new Error(`ssh connection to ${params.host} cancelled.`);
  }
  const run = env.run ?? defaultRun;
  const timeoutMs = (params.timeoutSeconds ?? 60) * 1000;
  const res = redactResult(await run(params, timeoutMs, env.signal));
  const cap = env.maxOutputBytes ?? 24_000;
  const output = truncateUtf8(res.output, cap);
  const note = res.timedOut ? " (timed out)" : res.exitCode === 0 ? "" : ` (exit ${res.exitCode})`;
  return { ...res, output, summary: `${params.host}${note}: ${output.split("\n").slice(0, 6).join("\n")}` };
}
