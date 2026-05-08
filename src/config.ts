import { join } from "node:path";

import { CONFIG_FILE, assertRelativePath, exists, readJsonFile, writeJsonFile } from "./fs.js";
import { GraphCycleError, topologicalSort } from "./graph.js";

export interface CommandConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface UrlCaptureConfig {
  from: "log";
  match: string;
}

export interface LogProbeConfig {
  type: "log";
  match: string;
}

export interface HttpProbeConfig {
  type: "http";
  url: string;
  status: number;
}

export type ProbeConfig = LogProbeConfig | HttpProbeConfig;

export interface ServiceConfig extends CommandConfig {
  url?: UrlCaptureConfig;
  ready?: ProbeConfig[];
  dependsOn?: string[];
}

export interface DevStateConfig {
  $schema?: string;
  version: 1;
  primaryService: string;
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
  version: 1,
  primaryService: "web",
  setup: {
    install: {
      command: "npm",
      args: ["install"],
      cwd: ".",
      env: {},
    },
  },
  checks: {
    check: {
      command: "npm",
      args: ["run", "check"],
    },
  },
  services: {
    web: {
      command: "npm",
      args: ["run", "dev"],
      url: { from: "log", match: "(https?://\\S+)" },
      ready: [{ type: "http", url: "$url", status: 200 }],
    },
    test: {
      command: "npm",
      args: ["run", "test", "--", "--watch"],
      ready: [{ type: "log", match: "PASS" }],
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

export async function writeSampleConfig(root: string): Promise<boolean> {
  const path = join(root, CONFIG_FILE);
  if (await exists(path)) {
    return false;
  }
  await writeJsonFile(path, sampleConfig);
  return true;
}

export function validateConfig(raw: unknown): DevStateConfig {
  const object = expectRecord(raw, "config");
  if (object.version !== 1) {
    throw new ConfigError("version must be 1");
  }

  const primaryService = expectString(object.primaryService, "primaryService");
  const setup = normalizeCommandMap(object.setup ?? {}, "setup");
  const checks = normalizeCommandMap(object.checks ?? {}, "checks");
  const services = normalizeServiceMap(object.services, "services");

  if (!Object.hasOwn(services, primaryService)) {
    throw new ConfigError("primaryService must exist in services");
  }

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
    version: 1,
    primaryService,
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
    const command = normalizeCommand(value, `${label}.${id}`);
    const serviceRaw = expectRecord(value, `${label}.${id}`);
    const service: ServiceConfig = { ...command };

    if (serviceRaw.url !== undefined) {
      const urlRaw = expectRecord(serviceRaw.url, `${label}.${id}.url`);
      if (urlRaw.from !== "log") {
        throw new ConfigError(`${label}.${id}.url.from must be "log"`);
      }
      const match = expectString(urlRaw.match, `${label}.${id}.url.match`);
      compileRegex(match, `${label}.${id}.url.match`);
      service.url = { from: "log", match };
    }

    if (serviceRaw.ready !== undefined) {
      if (!Array.isArray(serviceRaw.ready)) {
        throw new ConfigError(`${label}.${id}.ready must be an array`);
      }
      service.ready = serviceRaw.ready.map((probe, index) =>
        normalizeProbe(probe, `${label}.${id}.ready[${index}]`),
      );
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

function normalizeCommand(raw: unknown, label: string): CommandConfig {
  const object = expectRecord(raw, label);
  const command = expectString(object.command, `${label}.command`);
  if (command.length === 0) {
    throw new ConfigError(`${label}.command must be a non-empty string`);
  }

  const normalized: CommandConfig = { command };
  if (object.args !== undefined) {
    if (!Array.isArray(object.args)) {
      throw new ConfigError(`${label}.args must be an array`);
    }
    normalized.args = object.args.map((arg, index) => expectString(arg, `${label}.args[${index}]`));
  }
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

function normalizeProbe(raw: unknown, label: string): ProbeConfig {
  const object = expectRecord(raw, label);
  if (object.type === "log") {
    const match = expectString(object.match, `${label}.match`);
    compileRegex(match, `${label}.match`);
    return { type: "log", match };
  }
  if (object.type === "http") {
    const url = expectString(object.url, `${label}.url`);
    const status = object.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new ConfigError(`${label}.status must be an integer from 100 to 599`);
    }
    return { type: "http", url, status };
  }
  throw new ConfigError(`${label}.type must be "log" or "http"`);
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
