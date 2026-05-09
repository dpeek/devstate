import { join } from "node:path";

import { CONFIG_FILE, assertRelativePath, readJsonFile } from "./fs.js";
import { GraphCycleError, topologicalSort } from "./graph.js";

export interface CommandConfig {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface LogEventProbeConfig {
  log: string;
}

export interface HttpEventProbeConfig {
  http: string;
  status: number;
}

export type EventProbeConfig = LogEventProbeConfig | HttpEventProbeConfig;

export interface ServiceEventsConfig {
  url?: LogEventProbeConfig;
  ready?: EventProbeConfig;
  run?: EventProbeConfig;
  pass?: EventProbeConfig;
  fail?: EventProbeConfig;
}

export interface ServiceConfig extends CommandConfig {
  events?: ServiceEventsConfig;
  dependsOn?: string[];
}

export interface DevStateConfig {
  $schema?: string;
  setup: Record<string, CommandConfig>;
  checks: Record<string, CommandConfig>;
  services: Record<string, ServiceConfig>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const sampleConfig: DevStateConfig = {
  $schema: "https://unpkg.com/devstate/schema/v1.json",
  setup: {
    install: {
      cmd: ["npm", "install"],
      cwd: ".",
      env: {},
    },
  },
  checks: {
    check: {
      cmd: ["npm", "run", "check"],
    },
  },
  services: {
    web: {
      cmd: ["npm", "run", "dev"],
      events: {
        url: { log: "(https?://\\S+)" },
        ready: { http: "$url", status: 200 },
      },
    },
    test: {
      cmd: ["npm", "run", "test", "--", "--watch"],
      events: {
        ready: { log: "watching" },
        run: { log: "run started" },
        pass: { log: "run passed" },
        fail: { log: "run failed" },
      },
      dependsOn: ["web"],
    },
  },
};

export async function loadConfig(root: string): Promise<DevStateConfig> {
  const raw = await readJsonFile<unknown>(join(root, CONFIG_FILE));
  if (raw === null) {
    throw new ConfigError(`${CONFIG_FILE} not found`);
  }
  return validateConfig(raw);
}

export function validateConfig(raw: unknown): DevStateConfig {
  const object = expectRecord(raw, "config");
  rejectUnknownKeys(object, ["$schema", "setup", "checks", "services"], "config");

  const setup = normalizeCommandMap(object.setup ?? {}, "setup");
  const checks = normalizeCommandMap(object.checks ?? {}, "checks");
  const services = normalizeServiceMap(object.services, "services");

  for (const [id, service] of Object.entries(services)) {
    for (const dependency of service.dependsOn ?? []) {
      if (!Object.hasOwn(services, dependency)) {
        throw new ConfigError(`service ${id} depends on unknown service ${dependency}`);
      }
    }
  }

  try {
    topologicalSort(Object.keys(services), (id) => services[id]?.dependsOn ?? []);
  } catch (error) {
    if (error instanceof GraphCycleError) {
      throw new ConfigError(error.message);
    }
    throw error;
  }

  const config: DevStateConfig = {
    setup,
    checks,
    services,
  };
  if (typeof object.$schema === "string") {
    config.$schema = object.$schema;
  }
  return config;
}

export function serviceStartOrder(config: DevStateConfig): string[] {
  return topologicalSort(
    Object.keys(config.services),
    (id) => config.services[id]?.dependsOn ?? [],
  );
}

function normalizeCommandMap(raw: unknown, label: string): Record<string, CommandConfig> {
  const object = expectRecord(raw, label);
  const commands: Record<string, CommandConfig> = {};
  for (const [id, value] of Object.entries(object)) {
    validateId(id, `${label} id`);
    commands[id] = normalizeCommand(value, `${label}.${id}`);
  }
  return commands;
}

function normalizeServiceMap(raw: unknown, label: string): Record<string, ServiceConfig> {
  const object = expectRecord(raw, label);
  const services: Record<string, ServiceConfig> = {};
  for (const [id, value] of Object.entries(object)) {
    validateId(id, `${label} id`);
    const command = normalizeCommand(value, `${label}.${id}`, ["dependsOn", "events"]);
    const serviceRaw = expectRecord(value, `${label}.${id}`);
    const service: ServiceConfig = { ...command };
    rejectUnknownKeys(
      serviceRaw,
      ["cmd", "cwd", "env", "dependsOn", "events"],
      `${label}.${id}`,
    );

    if (serviceRaw.events !== undefined) {
      service.events = normalizeEvents(serviceRaw.events, `${label}.${id}.events`);
    }

    if (serviceRaw.dependsOn !== undefined) {
      if (!Array.isArray(serviceRaw.dependsOn)) {
        throw new ConfigError(`${label}.${id}.dependsOn must be an array`);
      }
      service.dependsOn = serviceRaw.dependsOn.map((dependency, index) => {
        const dependencyId = expectString(dependency, `${label}.${id}.dependsOn[${index}]`);
        validateId(dependencyId, `${label}.${id}.dependsOn[${index}]`);
        return dependencyId;
      });
    }

    services[id] = service;
  }

  if (Object.keys(services).length === 0) {
    throw new ConfigError("services must contain at least one service");
  }

  return services;
}

function normalizeCommand(
  raw: unknown,
  label: string,
  extraAllowedKeys: string[] = [],
): CommandConfig {
  const object = expectRecord(raw, label);
  rejectUnknownKeys(object, ["cmd", "cwd", "env"], label, extraAllowedKeys);

  if (!Array.isArray(object.cmd)) {
    throw new ConfigError(`${label}.cmd must be a non-empty array`);
  }
  if (object.cmd.length === 0) {
    throw new ConfigError(`${label}.cmd must be a non-empty array`);
  }
  const cmd = object.cmd.map((arg, index) => {
    const value = expectString(arg, `${label}.cmd[${index}]`);
    if (value.length === 0) {
      throw new ConfigError(`${label}.cmd[${index}] must be a non-empty string`);
    }
    return value;
  });

  const normalized: CommandConfig = { cmd };
  if (object.cwd !== undefined) {
    const cwd = expectString(object.cwd, `${label}.cwd`);
    try {
      assertRelativePath(cwd, `${label}.cwd`);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : `${label}.cwd is invalid`);
    }
    normalized.cwd = cwd;
  }
  if (object.env !== undefined) {
    const envRaw = expectRecord(object.env, `${label}.env`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(envRaw)) {
      env[key] = expectString(value, `${label}.env.${key}`);
    }
    normalized.env = env;
  }
  return normalized;
}

function normalizeEvents(raw: unknown, label: string): ServiceEventsConfig {
  const object = expectRecord(raw, label);
  rejectUnknownKeys(object, ["url", "ready", "run", "pass", "fail"], label);

  const events: ServiceEventsConfig = {};
  if (object.url !== undefined) {
    events.url = normalizeLogProbe(object.url, `${label}.url`);
  }
  for (const name of ["ready", "run", "pass", "fail"] as const) {
    if (object[name] !== undefined) {
      events[name] = normalizeEventProbe(object[name], `${label}.${name}`);
    }
  }
  return events;
}

function normalizeEventProbe(raw: unknown, label: string): EventProbeConfig {
  const object = expectRecord(raw, label);
  rejectUnknownKeys(object, ["log", "http", "status"], label);

  const hasLog = object.log !== undefined;
  const hasHttp = object.http !== undefined;
  if (hasLog === hasHttp) {
    throw new ConfigError(`${label} must contain exactly one of log or http`);
  }
  if (hasLog) {
    return normalizeLogProbe(raw, label);
  }

  const http = expectString(object.http, `${label}.http`);
  if (http.length === 0) {
    throw new ConfigError(`${label}.http must be a non-empty string`);
  }
  const status = object.status ?? 200;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new ConfigError(`${label}.status must be an integer from 100 to 599`);
  }
  return { http, status };
}

function normalizeLogProbe(raw: unknown, label: string): LogEventProbeConfig {
  const object = expectRecord(raw, label);
  rejectUnknownKeys(object, ["log"], label);
  const log = expectString(object.log, `${label}.log`);
  if (log.length === 0) {
    throw new ConfigError(`${label}.log must be a non-empty string`);
  }
  compileRegex(log, `${label}.log`);
  return { log };
}

function validateId(id: string, label: string): void {
  if (!ID_RE.test(id)) {
    throw new ConfigError(`${label} must match ${ID_RE.source}`);
  }
}

function compileRegex(pattern: string, label: string): void {
  try {
    new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid regular expression";
    throw new ConfigError(`${label} must compile as a regular expression: ${message}`);
  }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${label} must be a string`);
  }
  return value;
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowedKeys: string[],
  label: string,
  extraAllowedKeys: string[] = [],
): void {
  const allowed = new Set([...allowedKeys, ...extraAllowedKeys]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${label}.${key} is not supported`);
    }
  }
}
