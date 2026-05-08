#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  CONFIG_FILE,
  CONTROL_JSON,
  appendGitignoreOnce,
  displayLogPath,
  displayStatePath,
  ensureStateDirs,
  exists,
  removeIfExists,
  statePath,
} from "./fs.js";
import { ConfigError, loadConfig, writeSampleConfig, type DevStateConfig } from "./config.js";
import { runCommand, terminateProcessGroups } from "./process.js";
import { READY_TIMEOUT_MS, POLL_INTERVAL_MS } from "./probes.js";
import { runSupervisor } from "./supervisor.js";
import {
  controlSocketPath,
  createStatus,
  isStatusStale,
  readControlJson,
  readStatusJson,
  readStatusMarkdown,
  staleStatus,
  statusToMarkdown,
  type StatusDocument,
  writeStatus,
} from "./status.js";

const USAGE = "usage: devstate init|start|stop|status|check";

export async function main(argv = process.argv.slice(2), root = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    console.error(USAGE);
    return 2;
  }

  try {
    if (command === "__supervisor") {
      const supervisorRoot = rest[0] === undefined ? root : resolve(rest[0]);
      const token = process.env.AGENT_DEV_CONTROL_TOKEN;
      if (token === undefined) {
        console.error("missing supervisor token");
        return 1;
      }
      await runSupervisor(supervisorRoot, token);
      return 0;
    }

    if (rest.length > 0) {
      console.error(USAGE);
      return 2;
    }

    switch (command) {
      case "init":
        return await initCommand(root);
      case "start":
        return await startCommand(root);
      case "stop":
        return await stopCommand(root);
      case "status":
        return await statusCommand(root);
      case "check":
        return await checkCommand(root);
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

async function initCommand(root: string): Promise<number> {
  await writeSampleConfig(root);
  await appendGitignoreOnce(root);
  console.log(`config: ${CONFIG_FILE}`);
  console.log(`ignored: ${displayStatePath()}/`);
  return 0;
}

async function startCommand(root: string): Promise<number> {
  const config = await loadConfig(root);
  await ensureStateDirs(root);

  if (await hasFreshSupervisor(root)) {
    console.error("supervisor already running");
    await printStatusMarkdown(root);
    return 1;
  }

  const status = createStatus(config, "starting");
  await writeStatus(root, status);

  const setupOk = await runCommandMap(root, config.setup, "setup", status, false);
  if (!setupOk) {
    status.state = "fail";
    await writeStatus(root, status);
    await printStatusMarkdown(root);
    return 1;
  }

  const checksOk = await runCommandMap(root, config.checks, "check", status, true);
  if (!checksOk) {
    status.state = "fail";
    await writeStatus(root, status);
    await printStatusMarkdown(root);
    return 1;
  }

  const token = randomUUID();
  const child = spawn(process.execPath, [currentCliPath(), "__supervisor", root], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      AGENT_DEV_CONTROL_TOKEN: token,
    },
    stdio: "ignore",
  });
  child.unref();

  const finalStatus = await waitForStartResult(root, Object.keys(config.services).length);
  await printStatusMarkdown(root);
  return finalStatus?.state === "ready" ? 0 : 1;
}

async function hasFreshSupervisor(root: string): Promise<boolean> {
  const control = await readControlJson(root);
  if (control === null) {
    return false;
  }

  const updatedAt = Date.parse(control.updatedAt);
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 10_000) {
    return true;
  }

  const socketPath = control.socketPath.startsWith(".")
    ? join(root, control.socketPath)
    : control.socketPath;
  await removeIfExists(socketPath);
  await removeIfExists(controlSocketPath(root));
  await removeIfExists(statePath(root, CONTROL_JSON));
  return false;
}

async function checkCommand(root: string): Promise<number> {
  const config = await loadConfig(root);
  await ensureStateDirs(root);
  const existing = await readStatusJson(root);
  const status = existing ?? createStatus(config, "stopped");
  ensureStatusMaps(status, config);

  const checksOk = await runCommandMap(root, config.checks, "check", status, true);
  status.state = checksOk ? status.state : "fail";
  await writeStatus(root, status);
  await printStatusMarkdown(root);
  return checksOk ? 0 : 1;
}

async function statusCommand(root: string): Promise<number> {
  const [status, markdown] = await Promise.all([readStatusJson(root), readStatusMarkdown(root)]);
  if (status === null || markdown === null) {
    console.error("missing status");
    return 1;
  }

  if (isStatusStale(status)) {
    const stale = staleStatus(status);
    process.stdout.write(statusToMarkdown(stale));
    return 1;
  }

  process.stdout.write(markdown);
  return status.state === "ready" ? 0 : 1;
}

async function stopCommand(root: string): Promise<number> {
  const control = await readControlJson(root);
  if (control !== null) {
    const socketPath = control.socketPath.startsWith(".")
      ? join(root, control.socketPath)
      : control.socketPath;
    if (await exists(socketPath)) {
      const stopped = await sendStop(socketPath, control.token);
      if (stopped) {
        console.log("stopped");
        return 0;
      }
    }

    if (Date.now() - Date.parse(control.updatedAt) < 10_000) {
      await terminateProcessGroups(control.servicePids ?? []);
      try {
        process.kill(control.supervisorPid, "SIGTERM");
      } catch {
        // The supervisor may already be gone.
      }
    }
  }

  await writeStoppedIfPossible(root);
  await removeIfExists(controlSocketPath(root));
  await removeIfExists(statePath(root, CONTROL_JSON));
  console.log("stopped");
  return 0;
}

async function runCommandMap(
  root: string,
  commands: DevStateConfig["checks"] | DevStateConfig["setup"],
  kind: "setup" | "check",
  status: StatusDocument,
  reflectChecks: boolean,
): Promise<boolean> {
  for (const [id, command] of Object.entries(commands)) {
    if (reflectChecks) {
      status.checks[id] = {
        ...status.checks[id],
        state: "running",
        log: displayLogPath(`check-${id}.txt`),
      };
      await writeStatus(root, status);
    }

    const result = await runCommand(root, command, `${kind}-${id}.txt`);
    if (reflectChecks) {
      status.checks[id] = {
        ...status.checks[id],
        state: result.ok ? "pass" : "fail",
        log: displayLogPath(`check-${id}.txt`),
      };
      await writeStatus(root, status);
    }
    if (!result.ok) {
      return false;
    }
  }
  return true;
}

function ensureStatusMaps(status: StatusDocument, config: DevStateConfig): void {
  const fresh = createStatus(config, status.state);
  status.primaryService = config.primaryService;
  for (const [id, check] of Object.entries(fresh.checks)) {
    status.checks[id] = { ...check, ...status.checks[id] };
    if (check.command !== undefined) {
      status.checks[id].command = check.command;
    }
  }
  for (const [id, service] of Object.entries(fresh.services)) {
    status.services[id] = { ...service, ...status.services[id] };
    if (service.command !== undefined) {
      status.services[id].command = service.command;
    }
  }
}

async function printStatusMarkdown(root: string): Promise<void> {
  const markdown = await readStatusMarkdown(root);
  if (markdown === null) {
    return;
  }
  process.stdout.write(markdown);
}

async function waitForStartResult(
  root: string,
  serviceCount: number,
): Promise<StatusDocument | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS * Math.max(serviceCount, 1) + 5000;
  while (Date.now() < deadline) {
    const status = await readStatusJson(root);
    if (status?.state === "ready" || status?.state === "fail") {
      return status;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return await readStatusJson(root);
}

async function sendStop(socketPath: string, token: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(false), 5000);

    function finish(value: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    }

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token, command: "stop" })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { ok?: unknown };
        finish(response.ok === true);
      } catch {
        finish(false);
      }
    });
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(false));
  });
}

async function writeStoppedIfPossible(root: string): Promise<void> {
  const status = await readStatusJson(root);
  if (status === null) {
    return;
  }
  status.state = "stopped";
  for (const service of Object.values(status.services)) {
    service.state = "stopped";
  }
  await writeStatus(root, status);
}

function currentCliPath(): string {
  return fileURLToPath(new URL("cli.js", import.meta.url));
}

function isDirectCliInvocation(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }

  const invokedPath = resolve(process.argv[1]);
  const modulePath = currentCliPath();
  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return invokedPath === modulePath;
  }
}

if (isDirectCliInvocation()) {
  const code = await main();
  process.exitCode = code;
}
