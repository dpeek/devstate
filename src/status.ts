import { readFile } from "node:fs/promises";

import type { DevStateConfig } from "./config.ts";
import {
  CONTROL_JSON,
  CONTROL_SOCK,
  STATUS_JSON,
  STATUS_MD,
  displayLogPath,
  displayStatePath,
  readJsonFile,
  statePath,
  writeJsonFile,
  writeTextFile,
} from "./fs.ts";

export type AggregateState = "stopped" | "starting" | "running" | "fail" | "stale" | "timeout";
export type UnitState =
  | "pending"
  | "starting"
  | "running"
  | "pass"
  | "ready"
  | "fail"
  | "stopped"
  | "stale"
  | "timeout";

export interface CheckStatus {
  state: UnitState;
  log: string;
  command?: string;
  outputExcerpt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  finishedAt?: string;
}

export interface ServiceStatus {
  state: UnitState;
  url?: string;
  log: string;
  command?: string;
  awaitable?: boolean;
  outputExcerpt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  finishedAt?: string;
  lastRunAt?: string;
  lastIdleAt?: string;
  lastEventAt?: string;
  lastResult?: "pass" | "fail";
}

export interface StatusDocument {
  version: 1;
  state: AggregateState;
  startedAt: string;
  updatedAt: string;
  staleAfterMs: number;
  commands: CommandMap;
  checks: Record<string, CheckStatus>;
  services: Record<string, ServiceStatus>;
  summary?: {
    usage?: string;
    error?: string;
    message?: string;
    log?: string;
    outputExcerpt?: string;
  };
}

export interface ControlDocument {
  version: 1;
  token: string;
  supervisorPid: number;
  socketPath: string;
  updatedAt: string;
  servicePids?: number[];
}

export type CommandMap = typeof COMMANDS;

export const STALE_AFTER_MS = 10_000;
export const COMMANDS = {
  start: "devstate start",
  check: "devstate check",
  stop: "devstate stop",
} as const;

export function createStatus(config: DevStateConfig, state: AggregateState): StatusDocument {
  const now = new Date().toISOString();
  return {
    version: 1,
    state,
    startedAt: now,
    updatedAt: now,
    staleAfterMs: STALE_AFTER_MS,
    commands: COMMANDS,
    checks: Object.fromEntries(
      Object.keys(config.checks).map((id) => [
        id,
        {
          state: "pending" satisfies UnitState,
          log: displayLogPath(`check-${id}.txt`),
          command: commandToDisplay(config.checks[id]!),
        },
      ]),
    ),
    services: Object.fromEntries(
      Object.keys(config.services).map((id) => [
        id,
        {
          state: "pending" satisfies UnitState,
          log: displayLogPath(`service-${id}.txt`),
          command: commandToDisplay(config.services[id]!),
          awaitable: isAwaitableService(config, id),
        },
      ]),
    ),
  };
}

export function createEmptyStatus(
  state: AggregateState,
  summary?: StatusDocument["summary"],
): StatusDocument {
  const now = new Date().toISOString();
  const status: StatusDocument = {
    version: 1,
    state,
    startedAt: now,
    updatedAt: now,
    staleAfterMs: STALE_AFTER_MS,
    commands: COMMANDS,
    checks: {},
    services: {},
  };
  if (summary !== undefined) {
    status.summary = summary;
  }
  return status;
}

export function usageStatus(reason: string): StatusDocument {
  return createEmptyStatus("fail", { usage: reason });
}

export function errorStatus(message: string): StatusDocument {
  return createEmptyStatus("fail", { error: message });
}

export function messageStatus(message: string): StatusDocument {
  return createEmptyStatus("stopped", { message });
}

export async function readStatusJson(root: string): Promise<StatusDocument | null> {
  return readJsonFile<StatusDocument>(statePath(root, STATUS_JSON));
}

export async function readControlJson(root: string): Promise<ControlDocument | null> {
  return readJsonFile<ControlDocument>(statePath(root, CONTROL_JSON));
}

export async function writeStatus(root: string, status: StatusDocument): Promise<void> {
  status.updatedAt = new Date().toISOString();
  await writeJsonFile(statePath(root, STATUS_JSON), status);
  await writeTextFile(statePath(root, STATUS_MD), statusToMarkdown(status));
}

export async function writeControl(root: string, control: ControlDocument): Promise<void> {
  control.updatedAt = new Date().toISOString();
  await writeJsonFile(statePath(root, CONTROL_JSON), control);
}

export async function readStatusMarkdown(root: string): Promise<string | null> {
  try {
    return await readFile(statePath(root, STATUS_MD), "utf8");
  } catch {
    return null;
  }
}

export function statusToMarkdown(status: StatusDocument): string {
  const lines = ["# Dev Tool State", "", "## Summary", ""];

  if (status.summary?.usage !== undefined) {
    lines.push(`- usage: ${status.summary.usage}`);
  } else if (status.summary?.error !== undefined) {
    lines.push(`- error: ${status.summary.error}`);
    if (status.summary.log !== undefined) {
      lines.push(`- log: \`${status.summary.log}\``);
    }
  } else if (status.summary?.message !== undefined) {
    lines.push(`- message: ${status.summary.message}`);
  } else {
    lines.push(`- checks: ${summarizeChecks(status.checks)}`);
    lines.push(`- services: ${summarizeServices(status)}`);
    const urls = serviceUrls(status);
    if (urls.length === 1) {
      lines.push(`- url: ${urls[0]}`);
    } else if (urls.length > 1) {
      lines.push(`- urls: ${urls.length}`);
    }
  }

  lines.push(`- updated: ${status.updatedAt}`, "", "## Commands", "");
  lines.push("- `devstate start`: run setup, checks, and services");
  lines.push("- `devstate check`: run checks and wait for awaitable services");
  lines.push("- `devstate stop`: stop services");

  if (status.summary?.outputExcerpt !== undefined) {
    lines.push(
      "",
      "```text",
      "Output excerpt, last 80 lines:",
      status.summary.outputExcerpt,
      "```",
    );
  }

  if (shouldRenderChecks(status)) {
    lines.push("", "## Checks", "");
    for (const [id, check] of Object.entries(status.checks)) {
      lines.push(unitLine(check, `check.${id}`));
      appendExcerpt(lines, check);
    }
  }

  if (shouldRenderServices(status)) {
    lines.push("", "## Services", "");
    for (const [id, service] of Object.entries(status.services)) {
      lines.push(unitLine(service, `service.${id}`, service.url));
      appendExcerpt(lines, service);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function isStatusStale(status: StatusDocument, now = Date.now()): boolean {
  const updatedAt = Date.parse(status.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return true;
  }
  return now - updatedAt > status.staleAfterMs;
}

export function staleStatus(status: StatusDocument): StatusDocument {
  return {
    ...status,
    state: "stale",
  };
}

export function controlSocketPath(root: string): string {
  return statePath(root, CONTROL_SOCK);
}

export function displayControlSocketPath(): string {
  return displayStatePath(CONTROL_SOCK);
}

export function commandToDisplay(command: { cmd: string[] }): string {
  return command.cmd.map(shellQuote).join(" ");
}

function summarizeChecks(checks: Record<string, CheckStatus>): string {
  const values = Object.values(checks);
  if (values.some((check) => check.state === "fail" || check.state === "timeout")) {
    return "fail";
  }
  if (values.some((check) => check.state === "running")) {
    return "running";
  }
  if (values.some((check) => check.state === "pending" || check.state === "starting")) {
    return "pending";
  }
  return "ok";
}

function summarizeServices(status: StatusDocument): string {
  if (status.state === "running") {
    return "running";
  }
  return status.state;
}

function serviceUrls(status: StatusDocument): string[] {
  return [...new Set(Object.values(status.services).flatMap((service) => service.url ?? []))];
}

function shouldRenderChecks(status: StatusDocument): boolean {
  if (Object.keys(status.checks).length === 0) {
    return false;
  }
  if (status.summary !== undefined) {
    return Object.values(status.checks).some((check) => check.outputExcerpt !== undefined);
  }
  if (status.state !== "stopped") {
    return true;
  }
  return Object.values(status.checks).some((check) => check.outputExcerpt !== undefined);
}

function shouldRenderServices(status: StatusDocument): boolean {
  if (Object.keys(status.services).length === 0) {
    return false;
  }
  if (status.summary !== undefined) {
    return Object.values(status.services).some((service) => service.outputExcerpt !== undefined);
  }
  if (status.state !== "stopped") {
    return true;
  }
  return Object.values(status.services).some((service) => service.outputExcerpt !== undefined);
}

function unitLine(
  unit: CheckStatus | ServiceStatus,
  fallbackCommand: string,
  url?: string,
): string {
  const parts = [`${stateIcon(unit.state)} ${unit.state} \`${unit.command ?? fallbackCommand}\``];
  if (url !== undefined) {
    parts.push(url);
  }
  parts.push(`\`${unit.log}\``);
  return `- ${parts.join(" | ")}`;
}

function appendExcerpt(lines: string[], unit: CheckStatus | ServiceStatus): void {
  if (unit.outputExcerpt === undefined) {
    return;
  }
  lines.push("", "```text", "Output excerpt, last 80 lines:", unit.outputExcerpt, "```");
}

function stateIcon(state: UnitState | "ok"): string {
  switch (state) {
    case "pass":
    case "ready":
    case "ok":
      return "🟢";
    case "running":
    case "starting":
    case "pending":
      return "🟠";
    case "fail":
    case "stale":
    case "timeout":
      return "🔴";
    case "stopped":
      return "⚪";
  }
}

function isAwaitableService(config: DevStateConfig, id: string): boolean {
  const events = config.services[id]?.events;
  return events?.run !== undefined && events.pass !== undefined && events.fail !== undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
