import { createWriteStream, type WriteStream } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
  loadConfig,
  serviceStartOrder,
  type DevStateConfig,
  type ServiceConfig,
} from "./config.js";
import {
  displayControlSocketPath,
  controlSocketPath,
  createStatus,
  readStatusJson,
  type StatusDocument,
  writeControl,
  writeStatus,
} from "./status.js";
import {
  CONTROL_JSON,
  logPath,
  removeIfExists,
  resolveCommandCwd,
  statePath,
  stripAnsi,
} from "./fs.js";
import { terminateProcessGroups } from "./process.js";
import { waitForReady } from "./probes.js";

interface RunningService {
  id: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  logStream: WriteStream;
  service: ServiceConfig;
  exited: boolean;
  ready: boolean;
  url?: string;
  log: string;
}

export async function runSupervisor(root: string, token: string): Promise<void> {
  const config = await loadConfig(root);
  let status = (await readStatusJson(root)) ?? createStatus(config, "starting");
  status.state = "starting";
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
    if (!shuttingDown && !isFailStatus(status)) {
      status.state = "ready";
      const primaryUrl = status.services[config.primaryService]?.url;
      if (primaryUrl === undefined) {
        delete status.url;
      } else {
        status.url = primaryUrl;
      }
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
  status.primaryService = config.primaryService;
  status.commands = fresh.commands;
  status.staleAfterMs = fresh.staleAfterMs;

  for (const [id, check] of Object.entries(fresh.checks)) {
    status.checks[id] ??= check;
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
    if (isShuttingDown() || status.state === "fail") {
      return;
    }
    const dependencies = config.services[id]?.dependsOn ?? [];
    if (dependencies.some((dependency) => status.services[dependency]?.state !== "ready")) {
      status.state = "fail";
      status.services[id] = {
        state: "fail",
        log: status.services[id]?.log ?? `.devstate/logs/service-${id}.txt`,
      };
      await queueStatusWrite();
      return;
    }
    await startOneService(
      id,
      config.services[id]!,
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
  status: StatusDocument,
  root: string,
  services: Map<string, RunningService>,
  queueStatusWrite: () => Promise<void>,
  writeControlFile: () => Promise<void>,
  isShuttingDown: () => boolean,
): Promise<void> {
  const logName = `service-${id}.txt`;
  const logStream = createWriteStream(logPath(root, logName), { flags: "w" });
  const child = spawn(service.command, service.args ?? [], {
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
    state: "running",
    log: `.devstate/logs/${logName}`,
  };
  await writeControlFile();
  await queueStatusWrite();

  const onChunk = (chunk: Buffer): void => {
    logStream.write(chunk);
    const cleaned = stripAnsi(chunk.toString("utf8"));
    running.log = `${running.log}${cleaned}`.slice(-1_000_000);
    captureUrl(running, service);
    if (running.url !== undefined) {
      status.services[id] = {
        ...status.services[id]!,
        url: running.url,
      };
      if (id === status.primaryService) {
        status.url = running.url;
      }
    }
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (error) => {
    logStream.write(`${error.message}\n`);
    running.exited = true;
  });
  child.on("exit", () => {
    running.exited = true;
    logStream.end();
    if (isShuttingDown()) {
      return;
    }
    if (!running.ready) {
      status.services[id] = {
        ...status.services[id]!,
        state: "fail",
      };
      status.state = "fail";
      void queueStatusWrite();
      return;
    }
    status.services[id] = {
      ...status.services[id]!,
      state: "fail",
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
    status.services[id] = {
      ...status.services[id]!,
      state: "fail",
    };
    status.state = "fail";
    await queueStatusWrite();
    return;
  }

  running.ready = true;
  captureUrl(running, service);
  status.services[id] = {
    ...status.services[id]!,
    state: "ready",
  };
  if (running.url !== undefined) {
    status.services[id]!.url = running.url;
    if (id === status.primaryService) {
      status.url = running.url;
    }
  }
  await queueStatusWrite();
}

function captureUrl(running: RunningService, service: ServiceConfig): void {
  if (running.url !== undefined || service.url === undefined) {
    return;
  }

  const match = new RegExp(service.url.match).exec(running.log);
  if (match === null) {
    return;
  }
  running.url = match[1] ?? match[0];
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

function isFailStatus(status: StatusDocument): boolean {
  return status.state === "fail";
}
