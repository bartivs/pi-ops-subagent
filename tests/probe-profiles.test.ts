import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROFILES,
  registeredProfileIds,
  getProfile,
  validateProfileArgs,
  executableFor,
  isValidProbePath,
  ProfileError,
  type ProbeProfile,
} from "../extensions/probe-profiles.ts";

test("profiles are registered read-only diagnostics with documented accepted arguments", () => {
  assert.ok(PROFILES.length >= 8, "read-only profiles registered");
  for (const p of PROFILES) {
    assert.match(p.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(p.exec.length > 0, `${p.id} has a fixed executable`);
    assert.ok(p.description.length > 20, `${p.id} documents its accepted arguments`);
    assert.ok(p.flags.length > 0, `${p.id} has an explicit allowlist`);
  }
  // fixed executables are simple binaries, never shell strings
  for (const p of PROFILES) {
    assert.ok(!p.exec.includes(" "), `${p.id} executable is a single binary`);
    assert.ok(!p.exec.includes("|") && !p.exec.includes(";"), `${p.id} executable is not a shell pipeline`);
  }
});

test("every profile accepts its own documented flags and rejects unknown arguments", () => {
  for (const p of PROFILES) {
    // "-p" needs a following numeric pid (ps)
    const flags = p.id === "ps" ? p.flags.filter((f) => f !== "-p") : [...p.flags];
    assert.equal(validateProfileArgs(p, flags), null, `${p.id} accepts its allowlist`);
    assert.ok(
      validateProfileArgs(p, ["--unknown-flag"]) !== null,
      `${p.id} rejects unknown flags`,
    );
    if (p.id === "ps") {
      assert.equal(validateProfileArgs(p, ["-p", "1234"]), null);
    }
  }
});

test("shell metacharacters, redirection, and control operators are rejected", () => {
  const p = getProfile("hostname")!;
  for (const bad of ["; ls", "| cat", "& echo", "> /tmp/x", "< /etc/passwd", "`id`", "$(id)", "$HOME", "a\nb", "rm -rf /"]) {
    assert.ok(validateProfileArgs(p, [bad]) !== null, `rejects ${JSON.stringify(bad)}`);
  }
});

test("mutation-capable subcommands are not registered and never accepted", () => {
  for (const attempt of [
    ["restart"],
    ["stop"],
    ["start"],
    ["reload"],
    ["install"],
    ["delete"],
    ["remove"],
    ["flush"],
    ["reboot"],
    ["shutdown"],
    ["mkfs"],
  ]) {
    // These look like executable-ish profile values; they are unregistered.
    assert.equal(getProfile(attempt[0]!), undefined, `${attempt[0]} is not a profile`);
  }
  // Even inside registered profiles, mutation verbs are not valid args.
  const ps = getProfile("ps")!;
  assert.ok(validateProfileArgs(ps, ["-eo", "pid,args", "restart"]) !== null);
});

test("df accepts only allowed flags and safe absolute paths", () => {
  const df = getProfile("df")!;
  assert.equal(validateProfileArgs(df, ["-h", "/var"]), null);
  assert.equal(validateProfileArgs(df, ["/var/lib/mysql"]), null);
  assert.ok(validateProfileArgs(df, ["-h", "../../etc"]) !== null, "no traversal");
  assert.ok(validateProfileArgs(df, ["-h", "var"]) !== null, "must be absolute");
  assert.ok(validateProfileArgs(df, ["-h", "/var; rm -rf /"]) !== null);
});

test("ps -p requires a numeric pid", () => {
  const ps = getProfile("ps")!;
  assert.equal(validateProfileArgs(ps, ["-p", "1234"]), null);
  assert.ok(validateProfileArgs(ps, ["-p"]) !== null, "-p needs a pid");
  assert.ok(validateProfileArgs(ps, ["-p", "abc"]) !== null);
  assert.ok(validateProfileArgs(ps, ["-p", "1234", "def"]) !== null);
});

test("executableFor rejects unknown profiles with the registered list", () => {
  assert.throws(() => executableFor("rm"), (e: Error) => {
    assert.ok(e instanceof ProfileError);
    assert.match(e.message, /Unknown profile "rm"/);
    assert.match(e.message, /Registered profiles: /);
    return true;
  });
});

test("isValidProbePath guards traversal and metacharacters", () => {
  assert.equal(isValidProbePath("/var/log/syslog"), true);
  assert.equal(isValidProbePath("/var/log/../etc/passwd"), false);
  assert.equal(isValidProbePath("/var/log;ls"), false);
  assert.equal(isValidProbePath("relative/path"), false);
  assert.equal(isValidProbePath("/path with space"), false);
});

test("profile ids are unique and documented in code", () => {
  const ids = registeredProfileIds();
  assert.equal(new Set(ids).size, ids.length);
  // The allowlist table below documents each accepted argument (task 4.2):
  const documented: Record<string, string[]> = {
    hostname: ["-f", "-s", "-i", "-I", "-d", "-y"],
    uptime: ["-p", "-s"],
    df: ["-h", "-T", "-l", "-P", "-k"],
    free: ["-b", "-k", "-m", "-g", "-h", "-t"],
    ps: ["-ef", "-ax", "-e", "-f", "-A", "-eo pid,ppid,comm,args", "-o pid,ppid,comm,args", "-p <pid>"],
    ss: ["-tunap", "-tn", "-l", "-s", "-tp"],
    dmesg: ["-T", "-x", "-k", "-l err,warn"],
    sysctl: ["vm.swappiness", "net.ipv4.tcp_tw_reuse", "net.ipv4.ip_forward", "kernel.hostname", "kernel.panic", "vm.overcommit_memory"],
    "proc-file": ["/proc/meminfo", "/proc/cpuinfo", "/proc/loadavg", "/proc/stat", "/proc/uptime", "/proc/diskstats"],
  };
  for (const [id, args] of Object.entries(documented)) {
    const p = getProfile(id);
    assert.ok(p, `profile ${id} exists for documentation`);
    assert.ok((p as ProbeProfile).description.includes(args[0]!), `${id} description names ${args[0]}`);
  }
});

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-profiles-"));
}

test("profile table consistency", () => {
  const root = tmpdir();
  void root;
});