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
  displayLogPath,
  ensureStateDirs,
  exists,
  removeIfExists,
  statePath,
} from "./fs.ts";
import { ConfigError, loadConfig, type DevStateConfig } from "./config.ts";
import { runExistingConfigMenu, runOnboarding } from "./onboarding.ts";
import { runCommand, terminateProcessGroups } from "./process.ts";
import { READY_TIMEOUT_MS, POLL_INTERVAL_MS } from "./probes.ts";
import { runSupervisor } from "./supervisor.ts";
import {
  controlSocketPath,
  createEmptyStatus,
  createStatus,
  errorStatus,
  isStatusStale,
  messageStatus,
  readControlJson,
  readStatusJson,
  readStatusMarkdown,
  statusToMarkdown,
  usageStatus,
  type CheckStatus,
  type StatusDocument,
  writeStatus,
} from "./status.ts";
import { parseWatchArgs, watchStatus } from "./watch.ts";

const CHECK_IDLE_DEBOUNCE_MS = 500;

export async function main(argv = process.argv.slice(2), root = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;

  try {
    if (command === undefined) {
      return await noArgsCommand(root);
    }

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

    if (command === "--watch") {
      const options = parseWatchArgs(rest);
      if (options === null) {
        process.stdout.write(statusToMarkdown(usageStatus("invalid arguments")));
        return 2;
      }
      return await watchStatus(root, options);
    }

    if (rest.length > 0) {
      process.stdout.write(statusToMarkdown(usageStatus("invalid arguments")));
      return 2;
    }

    switch (command) {
      case "start":
        return await startCommand(root);
      case "stop":
        return await stopCommand(root);
      case "check":
        return await checkCommand(root);
      default:
        process.stdout.write(statusToMarkdown(usageStatus("invalid command")));
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stdout.write(statusToMarkdown(errorStatus(error.message)));
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(statusToMarkdown(errorStatus(message)));
    return 1;
  }
}

async function noArgsCommand(root: string): Promise<number> {
  const hasConfig = await exists(join(root, CONFIG_FILE));
  if (hasConfig) {
    if (!isInteractive()) {
      process.stdout.write(
        statusToMarkdown(
          usageStatus(
            `${CONFIG_FILE} exists; run \`devstate start\`, \`devstate check\`, or \`devstate stop\``,
          ),
        ),
      );
      return 2;
    }

    const config = await loadConfig(root);
    const action = await runExistingConfigMenu(config);
    if (action === "start") {
      return await startCommand(root);
    }
    if (action === "edit") {
      const result = await runOnboarding(root, config);
      if (result === "start") {
        return await startCommand(root);
      }
      return result === "cancelled" ? 130 : 0;
    }
    return action === "cancelled" ? 130 : 0;
  }

  if (!isInteractive()) {
    process.stdout.write(
      statusToMarkdown(
        usageStatus(
          `${CONFIG_FILE} not found; run \`npx devstate\` in an interactive terminal to create it`,
        ),
      ),
    );
    return 2;
  }

  const result = await runOnboarding(root);
  if (result === "start") {
    return await startCommand(root);
  }
  return result === "cancelled" ? 130 : 0;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function startCommand(root: string): Promise<number> {
  if (!(await exists(join(root, CONFIG_FILE)))) {
    process.stdout.write(
      statusToMarkdown(
        messageStatus(`${CONFIG_FILE} not found. Run \`npx devstate\` interactively to create it.`),
      ),
    );
    return 1;
  }

  const config = await loadConfig(root);
  await ensureStateDirs(root);

  const supervisor = await getSupervisorState(root, true);
  if (supervisor === "fresh") {
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

  let finalStatus = await waitForStartResult(root, Object.keys(config.services).length);
  if (finalStatus?.state !== "running" && finalStatus?.state !== "fail") {
    finalStatus = await markWaitTimeout(root, config);
  }
  await printStatusMarkdown(root);
  return finalStatus?.state === "running" ? 0 : 1;
}

async function checkCommand(root: string): Promise<number> {
  const config = await loadConfig(root);
  await ensureStateDirs(root);
  const existing = await readStatusJson(root);
  const status = existing ?? createStatus(config, "stopped");
  ensureStatusMaps(status, config);

  const checksOk = await runCommandMap(root, config.checks, "check", status, true);
  if (!checksOk) {
    status.state = "fail";
    await writeStatus(root, status);
    await printStatusMarkdown(root);
    return 1;
  }

  const supervisor = await getSupervisorState(root, false);
  if (supervisor === "stale") {
    const latest = (await readStatusJson(root)) ?? status;
    ensureStatusMaps(latest, config);
    mergeChecks(latest, status.checks);
    latest.state = "stale";
    await writeStatus(root, latest);
    await printStatusMarkdown(root);
    return 1;
  }

  if (supervisor === "none") {
    status.state = "stopped";
    for (const service of Object.values(status.services)) {
      service.state = "stopped";
    }
    await writeStatus(root, status);
    await printStatusMarkdown(root);
    return 0;
  }

  const result = await waitForCheckIdle(root, config, status.checks);
  await printStatusMarkdown(root);
  return result ? 0 : 1;
}

async function stopCommand(root: string): Promise<number> {
  await ensureStateDirs(root);
  const control = await readControlJson(root);
  if (control !== null) {
    const socketPath = control.socketPath.startsWith(".")
      ? join(root, control.socketPath)
      : control.socketPath;
    if (await exists(socketPath)) {
      const stopped = await sendStop(socketPath, control.token);
      if (stopped) {
        const status = await waitForStoppedStatus(root);
        process.stdout.write(statusToMarkdown(status));
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

  const status = await writeStoppedStatus(root);
  await removeIfExists(controlSocketPath(root));
  await removeIfExists(statePath(root, CONTROL_JSON));
  process.stdout.write(statusToMarkdown(status));
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
      const previous = status.checks[id] ?? {
        state: "pending",
        log: displayLogPath(`check-${id}.txt`),
      };
      status.checks[id] = {
        ...previous,
        state: "running",
        log: displayLogPath(`check-${id}.txt`),
      };
      delete status.checks[id]!.outputExcerpt;
      delete status.checks[id]!.exitCode;
      delete status.checks[id]!.signal;
      delete status.checks[id]!.finishedAt;
      await writeStatus(root, status);
    }

    const result = await runCommand(root, command, `${kind}-${id}.txt`);
    if (reflectChecks) {
      const previous = status.checks[id] ?? {
        state: "pending",
        log: displayLogPath(`check-${id}.txt`),
      };
      status.checks[id] = {
        ...previous,
        state: result.ok ? "pass" : "fail",
        log: displayLogPath(`check-${id}.txt`),
        exitCode: result.code,
        signal: result.signal,
        finishedAt: result.finishedAt,
      };
      if (result.outputExcerpt !== undefined) {
        status.checks[id].outputExcerpt = result.outputExcerpt;
      } else {
        delete status.checks[id].outputExcerpt;
      }
      await writeStatus(root, status);
    }
    if (!result.ok) {
      if (!reflectChecks) {
        status.summary = {
          error: `${kind} failed: ${id}`,
          log: displayLogPath(`${kind}-${id}.txt`),
        };
        if (result.outputExcerpt !== undefined) {
          status.summary.outputExcerpt = result.outputExcerpt;
        }
      }
      return false;
    }
  }
  return true;
}

function ensureStatusMaps(status: StatusDocument, config: DevStateConfig): void {
  const fresh = createStatus(config, status.state);
  status.version = fresh.version;
  status.commands = fresh.commands;
  status.staleAfterMs = fresh.staleAfterMs;
  delete status.summary;
  for (const [id, check] of Object.entries(fresh.checks)) {
    status.checks[id] = { ...check, ...status.checks[id] };
    if (check.command !== undefined) {
      status.checks[id]!.command = check.command;
    }
  }
  for (const id of Object.keys(status.checks)) {
    if (!Object.hasOwn(config.checks, id)) {
      delete status.checks[id];
    }
  }
  for (const [id, service] of Object.entries(fresh.services)) {
    status.services[id] = { ...service, ...status.services[id] };
    if (service.command !== undefined) {
      status.services[id]!.command = service.command;
    }
    status.services[id]!.awaitable = service.awaitable === true;
  }
  for (const id of Object.keys(status.services)) {
    if (!Object.hasOwn(config.services, id)) {
      delete status.services[id];
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
    if (status?.state === "running" || status?.state === "fail" || status?.state === "timeout") {
      return status;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return await readStatusJson(root);
}

async function waitForCheckIdle(
  root: string,
  config: DevStateConfig,
  checks: Record<string, CheckStatus>,
): Promise<boolean> {
  const finishedChecksAt = Date.now();
  const debounceUntil = finishedChecksAt + CHECK_IDLE_DEBOUNCE_MS;
  const awaitableCount = Object.values(config.services).filter(isAwaitableService).length;
  const deadline = Date.now() + Math.max(READY_TIMEOUT_MS * Math.max(awaitableCount, 1), 1000);
  let sawRunAfterChecks = false;

  while (Date.now() < deadline) {
    const status = (await readStatusJson(root)) ?? createStatus(config, "starting");
    ensureStatusMaps(status, config);
    mergeChecks(status, checks);
    if (isStatusStale(status)) {
      status.state = "stale";
      await writeStatus(root, status);
      return false;
    }

    sawRunAfterChecks ||= Object.values(status.services).some((service) =>
      timestampAfter(service.lastRunAt, finishedChecksAt),
    );

    const services = evaluateServices(status, config);
    if (services.failed) {
      status.state = "fail";
      await writeStatus(root, status);
      return false;
    }
    if (services.ok && (sawRunAfterChecks || Date.now() >= debounceUntil)) {
      status.state = "running";
      await writeStatus(root, status);
      return true;
    }

    await delay(POLL_INTERVAL_MS);
  }

  await markWaitTimeout(root, config, checks);
  return false;
}

function evaluateServices(
  status: StatusDocument,
  config: DevStateConfig,
): { ok: boolean; failed: boolean } {
  let ok = true;
  for (const [id, service] of Object.entries(config.services)) {
    const state = status.services[id]?.state;
    if (state === "fail" || state === "stale" || state === "timeout") {
      return { ok: false, failed: true };
    }
    if (isAwaitableService(service)) {
      ok &&= state === "pass";
      continue;
    }
    ok &&= state === "ready";
  }
  return { ok, failed: false };
}

async function markWaitTimeout(
  root: string,
  config: DevStateConfig,
  checks?: Record<string, CheckStatus>,
): Promise<StatusDocument> {
  const status = (await readStatusJson(root)) ?? createStatus(config, "timeout");
  ensureStatusMaps(status, config);
  if (checks !== undefined) {
    mergeChecks(status, checks);
  }
  status.state = "timeout";
  for (const [id] of Object.entries(config.services)) {
    const serviceStatus = status.services[id];
    if (serviceStatus === undefined) {
      continue;
    }
    if (
      serviceStatus.state === "fail" ||
      serviceStatus.state === "pass" ||
      serviceStatus.state === "ready"
    ) {
      continue;
    }
    serviceStatus.state = "timeout";
    serviceStatus.finishedAt = new Date().toISOString();
  }
  await writeStatus(root, status);
  return status;
}

function mergeChecks(status: StatusDocument, checks: Record<string, CheckStatus>): void {
  for (const [id, check] of Object.entries(checks)) {
    status.checks[id] = { ...status.checks[id], ...check };
  }
}

function isAwaitableService(service: DevStateConfig["services"][string]): boolean {
  const events = service.events;
  return events?.run !== undefined && events.pass !== undefined && events.fail !== undefined;
}

async function getSupervisorState(
  root: string,
  cleanupStale: boolean,
): Promise<"fresh" | "stale" | "none"> {
  const control = await readControlJson(root);
  if (control === null) {
    return "none";
  }

  const updatedAt = Date.parse(control.updatedAt);
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt < 10_000) {
    return "fresh";
  }

  if (cleanupStale) {
    const socketPath = control.socketPath.startsWith(".")
      ? join(root, control.socketPath)
      : control.socketPath;
    await removeIfExists(socketPath);
    await removeIfExists(controlSocketPath(root));
    await removeIfExists(statePath(root, CONTROL_JSON));
  }
  return "stale";
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

async function waitForStoppedStatus(root: string): Promise<StatusDocument> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await readStatusJson(root);
    if (status?.state === "stopped") {
      return status;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return await writeStoppedStatus(root);
}

async function writeStoppedStatus(root: string): Promise<StatusDocument> {
  const status = (await readStatusJson(root)) ?? createEmptyStatus("stopped");
  status.state = "stopped";
  delete status.summary;
  for (const service of Object.values(status.services)) {
    service.state = "stopped";
  }
  await writeStatus(root, status);
  return status;
}

function timestampAfter(value: string | undefined, time: number): boolean {
  if (value === undefined) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > time;
}

function currentCliPath(): string {
  return fileURLToPath(import.meta.url);
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
