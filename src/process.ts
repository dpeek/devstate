import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";

import type { CommandConfig } from "./config.js";
import { logPath, outputExcerpt, resolveCommandCwd } from "./fs.js";

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  outputExcerpt?: string;
  finishedAt: string;
}

export async function runCommand(
  root: string,
  commandConfig: CommandConfig,
  logName: string,
): Promise<CommandResult> {
  const stream = createWriteStream(logPath(root, logName), { flags: "w" });
  const [command, ...args] = commandConfig.cmd;
  const child = spawn(command!, args, {
    cwd: resolveCommandCwd(root, commandConfig.cwd),
    env: { ...process.env, ...commandConfig.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let captured = "";
  const onChunk = (chunk: Buffer): void => {
    stream.write(chunk);
    captured = `${captured}${chunk.toString("utf8")}`.slice(-1_000_000);
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  let settled = false;
  const result = await new Promise<CommandResult>((resolve) => {
    function finish(value: Omit<CommandResult, "finishedAt" | "outputExcerpt">): void {
      if (settled) {
        return;
      }
      settled = true;
      const finishedAt = new Date().toISOString();
      const resultWithOutput: CommandResult = {
        ...value,
        finishedAt,
      };
      if (!value.ok) {
        resultWithOutput.outputExcerpt = outputExcerpt(captured);
      }
      stream.end(() => resolve(resultWithOutput));
    }

    child.on("error", (error) => {
      stream.write(`${error.message}\n`);
      captured = `${captured}${error.message}\n`;
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
