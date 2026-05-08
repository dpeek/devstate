import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";

import type { CommandConfig } from "./config.js";
import { logPath, resolveCommandCwd } from "./fs.js";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export async function runCommand(
  root: string,
  commandConfig: CommandConfig,
  logName: string,
): Promise<CommandResult> {
  const stream = createWriteStream(logPath(root, logName), { flags: "w" });
  const child = spawn(commandConfig.command, commandConfig.args ?? [], {
    cwd: resolveCommandCwd(root, commandConfig.cwd),
    env: { ...process.env, ...commandConfig.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });

  let settled = false;
  const result = await new Promise<CommandResult>((resolve) => {
    function finish(value: CommandResult): void {
      if (settled) {
        return;
      }
      settled = true;
      stream.end(() => resolve(value));
    }

    child.on("error", (error) => {
      stream.write(`${error.message}\n`);
      finish({ ok: false, code: null, signal: null, error });
    });

    child.on("close", (code, signal) => {
      finish({ ok: code === 0, code, signal });
    });
  });

  return result;
}

export async function terminateProcessGroups(pids: number[], graceMs = 1500): Promise<void> {
  for (const pid of pids) {
    signalProcessGroup(pid, "SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const pid of pids) {
    signalProcessGroup(pid, "SIGKILL");
  }
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may already be gone, which is fine for shutdown.
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const child = spawn(process.execPath, ["-e", `process.kill(${pid}, 0)`], {
      stdio: "ignore",
      signal: controller.signal,
    });
    await once(child, "exit");
  } catch {
    // Best-effort helper.
  } finally {
    clearTimeout(timeout);
  }
}
