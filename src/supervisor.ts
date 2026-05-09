import { createWriteStream, type WriteStream } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
  loadConfig,
  serviceStartOrder,
  type DevStateConfig,
  type EventProbeConfig,
  type ServiceConfig,
} from "./config.ts";
import {
  displayControlSocketPath,
  controlSocketPath,
  createStatus,
  readStatusJson,
  type ServiceStatus,
  type StatusDocument,
  writeControl,
  writeStatus,
} from "./status.ts";
import {
  CONTROL_JSON,
  displayLogPath,
  logPath,
  outputExcerpt,
  removeIfExists,
  resolveCommandCwd,
  statePath,
  stripAnsi,
} from "./fs.ts";
import { terminateProcessGroups } from "./process.ts";
import { waitForReady } from "./probes.ts";

interface RunningService {
  id: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  logStream: WriteStream;
  service: ServiceConfig;
  exited: boolean;
  ready: boolean;
  url?: string;
  log: string;
  lastEventIndex?: number;
}

export async function runSupervisor(root: string, token: string): Promise<void> {
  const config = await loadConfig(root);
  let status = (await readStatusJson(root)) ?? createStatus(config, "starting");
  status.state = "starting";
  delete status.summary;
  await normalizeStatusForConfig(root, status, config);

  const socketPath = controlSocketPath(root);
  await removeIfExists(socketPath);

  const services = new Map<string, RunningService>();
  let shuttingDown = false;
  let statusWrite = Promise.resolve();

  const queueStatusWrite = (): Promise<void> => {
    statusWrite = statusWrite.catch(() => undefined).then(() => writeStatus(root, status));
    return statusWrite;
  };

  const writeControlFile = async (): Promise<void> => {
    await writeControl(root, {
      version: 1,
      token,
      supervisorPid: process.pid,
      socketPath: displayControlSocketPath(),
      updatedAt: new Date().toISOString(),
      servicePids: [...services.values()].map((service) => service.child.pid).filter(isNumber),
    });
  };

  const shutdownPromise = createDeferred<void>();
  const server = await startControlServer(socketPath, token, async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await shutdownServices([...services.values()], status, root, queueStatusWrite);
    clearInterval(heartbeat);
    server.close();
    await removeIfExists(socketPath);
    await removeIfExists(statePath(root, CONTROL_JSON));
    shutdownPromise.resolve();
  });

  const heartbeat = setInterval(() => {
    void writeControlFile();
    void queueStatusWrite();
  }, 1000);

  await writeControlFile();
  await queueStatusWrite();

  try {
    await startServiceGraph(
      config,
      status,
      root,
      services,
      queueStatusWrite,
      writeControlFile,
      () => shuttingDown,
    );
    if (!shuttingDown) {
      refreshAggregateState(status, config);
      await queueStatusWrite();
    }
  } catch {
    if (!shuttingDown) {
      status.state = "fail";
      await queueStatusWrite();
    }
  }

  await shutdownPromise.promise;
}

async function normalizeStatusForConfig(
  root: string,
  status: StatusDocument,
  config: DevStateConfig,
): Promise<void> {
  const fresh = createStatus(config, status.state);
  status.version = fresh.version;
  status.commands = fresh.commands;
  status.staleAfterMs = fresh.staleAfterMs;

  for (const [id, check] of Object.entries(fresh.checks)) {
    status.checks[id] = { ...check, ...status.checks[id] };
    if (check.command !== undefined) {
      status.checks[id].command = check.command;
    }
  }
  for (const id of Object.keys(status.checks)) {
    if (!Object.hasOwn(config.checks, id)) {
      delete status.checks[id];
    }
  }

  for (const [id, service] of Object.entries(fresh.services)) {
    status.services[id] = {
      ...service,
      state: "pending",
    };
  }
  for (const id of Object.keys(status.services)) {
    if (!Object.hasOwn(config.services, id)) {
      delete status.services[id];
    }
  }

  await writeStatus(root, status);
}

async function startServiceGraph(
  config: DevStateConfig,
  status: StatusDocument,
  root: string,
  services: Map<string, RunningService>,
  queueStatusWrite: () => Promise<void>,
  writeControlFile: () => Promise<void>,
  isShuttingDown: () => boolean,
): Promise<void> {
  for (const id of serviceStartOrder(config)) {
    if (isShuttingDown() || status.state === "fail" || status.state === "timeout") {
      return;
    }
    const dependencies = config.services[id]?.dependsOn ?? [];
    if (dependencies.some((dependency) => !isServiceHealthyForDependency(status.services[dependency]))) {
      status.state = "fail";
      status.services[id] = {
        ...status.services[id],
        state: "fail",
        log: status.services[id]?.log ?? displayLogPath(`service-${id}.txt`),
      };
      await queueStatusWrite();
      return;
    }
    await startOneService(
      id,
      config.services[id]!,
      config,
      status,
      root,
      services,
      queueStatusWrite,
      writeControlFile,
      isShuttingDown,
    );
  }
}

async function startOneService(
  id: string,
  service: ServiceConfig,
  config: DevStateConfig,
  status: StatusDocument,
  root: string,
  services: Map<string, RunningService>,
  queueStatusWrite: () => Promise<void>,
  writeControlFile: () => Promise<void>,
  isShuttingDown: () => boolean,
): Promise<void> {
  const logName = `service-${id}.txt`;
  const logStream = createWriteStream(logPath(root, logName), { flags: "w" });
  const [command, ...args] = service.cmd;
  const child = spawn(command!, args, {
    cwd: resolveCommandCwd(root, service.cwd),
    env: { ...process.env, ...service.env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const running: RunningService = {
    id,
    child,
    logStream,
    service,
    exited: false,
    ready: false,
    log: "",
  };
  services.set(id, running);
  status.services[id] = {
    ...status.services[id],
    state: "starting",
    log: displayLogPath(logName),
    awaitable: isAwaitableService(service),
  };
  refreshAggregateState(status, config);
  await writeControlFile();
  await queueStatusWrite();

  const onChunk = (chunk: Buffer): void => {
    logStream.write(chunk);
    const cleaned = stripAnsi(chunk.toString("utf8"));
    running.log = `${running.log}${cleaned}`.slice(-1_000_000);

    let changed = captureUrl(running, service, status.services[id]!);
    changed = observeLogEvents(running, status.services[id]!, service, config, status) || changed;
    if (changed) {
      refreshAggregateState(status, config);
      void queueStatusWrite();
    }
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (error) => {
    logStream.write(`${error.message}\n`);
    running.log = `${running.log}${error.message}\n`;
    running.exited = true;
  });
  child.on("exit", (code, signal) => {
    running.exited = true;
    logStream.end();
    if (isShuttingDown()) {
      return;
    }
    status.services[id] = {
      ...status.services[id]!,
      state: "fail",
      exitCode: code,
      signal,
      finishedAt: new Date().toISOString(),
      outputExcerpt: outputExcerpt(running.log),
    };
    status.state = "fail";
    void queueStatusWrite();
  });

  const ready = await waitForReady(service, {
    getLog: () => running.log,
    getUrl: () => running.url,
    hasExited: () => running.exited,
  });

  if (!ready.ok) {
    const state = ready.reason === "ready timeout" ? "timeout" : "fail";
    status.services[id] = {
      ...status.services[id]!,
      state,
      finishedAt: new Date().toISOString(),
      outputExcerpt: outputExcerpt(running.log),
    };
    status.state = state === "timeout" ? "timeout" : "fail";
    await queueStatusWrite();
    return;
  }

  running.ready = true;
  captureUrl(running, service, status.services[id]!);
  const currentState = status.services[id]?.state;
  if (!isAwaitableService(service) || currentState === "starting" || currentState === "pending") {
    status.services[id] = {
      ...status.services[id]!,
      state: "ready",
      lastEventAt: new Date().toISOString(),
    };
  }
  refreshAggregateState(status, config);
  await queueStatusWrite();
}

function captureUrl(
  running: RunningService,
  service: ServiceConfig,
  serviceStatus: ServiceStatus,
): boolean {
  if (running.url !== undefined || service.events?.url === undefined) {
    return false;
  }

  const match = new RegExp(service.events.url.log).exec(running.log);
  if (match === null) {
    return false;
  }
  running.url = match[1] ?? match[0];
  serviceStatus.url = running.url;
  serviceStatus.lastEventAt = new Date().toISOString();
  return true;
}

function observeLogEvents(
  running: RunningService,
  serviceStatus: ServiceStatus,
  service: ServiceConfig,
  config: DevStateConfig,
  status: StatusDocument,
): boolean {
  const events = service.events;
  if (events === undefined) {
    return false;
  }

  let latest: { name: "run" | "pass" | "fail"; index: number } | undefined;
  for (const name of ["run", "pass", "fail"] as const) {
    const probe = events[name];
    if (probe === undefined || !isLogProbe(probe)) {
      continue;
    }
    const index = lastMatchIndex(probe.log, running.log);
    if (index !== null && (latest === undefined || index >= latest.index)) {
      latest = { name, index };
    }
  }
  if (latest === undefined) {
    return false;
  }
  if (latest.index === running.lastEventIndex) {
    return false;
  }
  running.lastEventIndex = latest.index;
  applyServiceEvent(latest.name, serviceStatus, running.log);
  refreshAggregateState(status, config);
  return true;
}

function applyServiceEvent(
  name: "run" | "pass" | "fail",
  serviceStatus: ServiceStatus,
  log: string,
): void {
  const now = new Date().toISOString();
  serviceStatus.lastEventAt = now;
  if (name === "run") {
    serviceStatus.state = "running";
    serviceStatus.lastRunAt = now;
    delete serviceStatus.lastResult;
    delete serviceStatus.outputExcerpt;
    delete serviceStatus.exitCode;
    delete serviceStatus.signal;
    delete serviceStatus.finishedAt;
    return;
  }
  serviceStatus.state = name;
  serviceStatus.lastIdleAt = now;
  serviceStatus.lastResult = name;
  if (name === "pass") {
    delete serviceStatus.outputExcerpt;
    delete serviceStatus.exitCode;
    delete serviceStatus.signal;
    delete serviceStatus.finishedAt;
    return;
  }
  serviceStatus.outputExcerpt = outputExcerpt(log);
}

function isLogProbe(probe: EventProbeConfig): probe is { log: string } {
  return "log" in probe;
}

function lastMatchIndex(pattern: string, text: string): number | null {
  const regex = new RegExp(pattern, "g");
  let lastIndex: number | null = null;
  for (;;) {
    const match = regex.exec(text);
    if (match === null) {
      return lastIndex;
    }
    lastIndex = match.index;
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }
}

function refreshAggregateState(status: StatusDocument, config: DevStateConfig): void {
  const serviceEntries = Object.entries(config.services);
  if (serviceEntries.length === 0) {
    status.state = "running";
    return;
  }

  let allHealthy = true;
  for (const [id, service] of serviceEntries) {
    const state = status.services[id]?.state;
    if (state === "fail" || state === "stale") {
      status.state = "fail";
      return;
    }
    if (state === "timeout") {
      status.state = "timeout";
      return;
    }
    if (isAwaitableService(service)) {
      if (state !== "pass") {
        allHealthy = false;
      }
      continue;
    }
    if (state !== "ready") {
      allHealthy = false;
    }
  }
  status.state = allHealthy ? "running" : "starting";
}

function isAwaitableService(service: ServiceConfig): boolean {
  const events = service.events;
  return events?.run !== undefined && events.pass !== undefined && events.fail !== undefined;
}

function isServiceHealthyForDependency(service: ServiceStatus | undefined): boolean {
  return service?.state === "ready" || service?.state === "pass";
}

async function shutdownServices(
  services: RunningService[],
  status: StatusDocument,
  root: string,
  queueStatusWrite: () => Promise<void>,
): Promise<void> {
  const pids = services.map((service) => service.child.pid).filter(isNumber);
  for (const service of services) {
    service.ready = false;
  }
  await terminateProcessGroups(pids);
  for (const service of services) {
    service.logStream.end();
    status.services[service.id] = {
      ...status.services[service.id]!,
      state: "stopped",
    };
  }
  status.state = "stopped";
  await queueStatusWrite();
}

async function startControlServer(
  socketPath: string,
  token: string,
  stop: () => Promise<void>,
): Promise<Server> {
  const server = createServer((socket) => handleControlSocket(socket, token, stop));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function handleControlSocket(socket: Socket, token: string, stop: () => Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      return;
    }

    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    void (async () => {
      try {
        const message = JSON.parse(line) as { token?: unknown; command?: unknown };
        if (message.token !== token || message.command !== "stop") {
          socket.write(`${JSON.stringify({ ok: false })}\n`);
          socket.end();
          return;
        }
        socket.write(`${JSON.stringify({ ok: true })}\n`);
        socket.end();
        await stop();
      } catch {
        socket.write(`${JSON.stringify({ ok: false })}\n`);
        socket.end();
      }
    })();
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}
