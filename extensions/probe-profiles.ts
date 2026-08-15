/**
 * Registered read-only diagnostic profiles for `probe_exec` (probe-protocol
 * 4.2). Each profile maps to ONE fixed executable with an explicit argument
 * policy. `probe_exec` never accepts an arbitrary executable path; unknown
 * profiles and unknown/shell/mutation arguments are rejected before spawn.
 *
 * Argument policies are exact allowlists plus, for path-taking profiles, a
 * strict path pattern (no traversal, no shell metacharacters).
 */

export interface ProbeProfile {
  id: string;
  /** Fixed executable (never a model-supplied path). */
  exec: string;
  description: string;
  /** Allowed flag args (exact). */
  flags: readonly string[];
  /** When true, trailing args must be safe absolute paths. */
  acceptsPaths: boolean;
}

/** Shell metacharacters that never appear in any accepted argument. */
export const SHELL_METACHARS = /[;&|<>$`(){}[\]*?!'"\\\n\r\t]/;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** Safe path pattern: absolute, no `..`, no shell metachars, printable only. */
export function isValidProbePath(arg: string): boolean {
  if (!arg.startsWith("/")) return false;
  if (arg.includes("..")) return false;
  if (SHELL_METACHARS.test(arg)) return false;
  return /^\/[A-Za-z0-9_./-]*$/.test(arg);
}

function pidArg(arg: string): boolean {
  return /^\d{1,7}$/.test(arg);
}

export const PROFILES: readonly ProbeProfile[] = [
  {
    id: "hostname",
    exec: "hostname",
    description: "Read the hostname. Flags: -f (fqdn), -s (short), -i (IP), -I (all IPs), -d (domain), -y (NIS). No other arguments.",
    flags: ["-f", "-s", "-i", "-I", "-d", "-y"],
    acceptsPaths: false,
  },
  {
    id: "uptime",
    exec: "uptime",
    description: "System uptime and load averages. Flags: -p (pretty), -s (since). No other arguments.",
    flags: ["-p", "-s"],
    acceptsPaths: false,
  },
  {
    id: "df",
    exec: "df",
    description: "Filesystem usage. Flags: -h, -T, -l, -P, -k. Optional safe absolute paths to query specific filesystems.",
    flags: ["-h", "-T", "-l", "-P", "-k"],
    acceptsPaths: true,
  },
  {
    id: "free",
    exec: "free",
    description: "Memory usage. Flags: -b, -k, -m, -g, -h, -t. No other arguments.",
    flags: ["-b", "-k", "-m", "-g", "-h", "-t"],
    acceptsPaths: false,
  },
  {
    id: "ps",
    exec: "ps",
    description: "Process snapshot. Flags: -ef, -ax, -e, -f, -A, '-eo pid,ppid,comm,args', '-o pid,ppid,comm,args', or '-p <pid>' with a numeric pid.",
    flags: ["-ef", "-ax", "-e", "-f", "-A", "-eo pid,ppid,comm,args", "-o pid,ppid,comm,args", "-p"],
    acceptsPaths: false,
  },
  {
    id: "ss",
    exec: "ss",
    description: "Socket statistics. Flags: -tunap, -tn, -l, -s, -tp. No other arguments.",
    flags: ["-tunap", "-tn", "-l", "-s", "-tp"],
    acceptsPaths: false,
  },
  {
    id: "dmesg",
    exec: "dmesg",
    description: "Kernel ring buffer (may require privileges). Flags: -T, -x, -k, '-l err,warn'. No other arguments.",
    flags: ["-T", "-x", "-k", "-l err,warn"],
    acceptsPaths: false,
  },
  {
    id: "sysctl",
    exec: "sysctl",
    description: "Read-only kernel parameters. Accepted keys: vm.swappiness, net.ipv4.tcp_tw_reuse, net.ipv4.ip_forward, kernel.hostname, kernel.panic, vm.overcommit_memory.",
    flags: ["vm.swappiness", "net.ipv4.tcp_tw_reuse", "net.ipv4.ip_forward", "kernel.hostname", "kernel.panic", "vm.overcommit_memory"],
    acceptsPaths: false,
  },
  {
    id: "proc-file",
    exec: "cat",
    description: "Read a safe /proc pseudo-file. Accepted paths: /proc/meminfo, /proc/cpuinfo, /proc/loadavg, /proc/stat, /proc/uptime, /proc/diskstats.",
    flags: ["/proc/meminfo", "/proc/cpuinfo", "/proc/loadavg", "/proc/stat", "/proc/uptime", "/proc/diskstats"],
    acceptsPaths: false,
  },
];

const PROFILE_MAP = new Map(PROFILES.map((p) => [p.id, p]));

export function getProfile(id: string): ProbeProfile | undefined {
  return PROFILE_MAP.get(id);
}

export function registeredProfileIds(): string[] {
  return PROFILES.map((p) => p.id);
}

/**
 * Validate `args` for a profile. Returns an error string, or null when the
 * arguments are acceptable. Rejects shell metacharacters, traversal, unknown
 * flags, and mutation-capable subcommands (which are not registered at all).
 */
export function validateProfileArgs(profile: ProbeProfile, args: string[]): string | null {
  for (const arg of args) {
    if (SHELL_METACHARS.test(arg)) {
      return `argument ${JSON.stringify(arg)} contains shell metacharacters`;
    }
  }
  if (profile.acceptsPaths) {
    // All args must be either an allowed flag or a safe absolute path.
    for (const arg of args) {
      if (profile.flags.includes(arg)) continue;
      if (!isValidProbePath(arg)) {
        return `argument ${JSON.stringify(arg)} is not an allowed flag or a safe absolute path`;
      }
    }
    return null;
  }
  if (profile.id === "ps") {
    // "-p" takes exactly one numeric pid that must follow it.
    let i = 0;
    while (i < args.length) {
      const arg = args[i]!;
      if (arg === "-p") {
        if (i + 1 >= args.length || !pidArg(args[i + 1]!)) {
          return '"-p" requires a numeric pid argument';
        }
        i += 2;
        continue;
      }
      if (!profile.flags.includes(arg)) {
        return `unknown ps argument ${JSON.stringify(arg)}`;
      }
      i++;
    }
    return null;
  }
  for (const arg of args) {
    if (!profile.flags.includes(arg)) {
      return `unknown ${profile.id} argument ${JSON.stringify(arg)}; allowed: ${profile.flags.join(", ")}`;
    }
  }
  return null;
}

/** Fixed executable for a profile (never model-supplied). */
export function executableFor(profileId: string): string {
  const p = getProfile(profileId);
  if (!p) throw new ProfileError(`Unknown profile "${profileId}". Registered profiles: ${registeredProfileIds().join(", ")}`);
  return p.exec;
}

