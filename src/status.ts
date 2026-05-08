import { readFile } from "node:fs/promises";

import type { DevStateConfig } from "./config.js";
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
} from "./fs.js";

export type AggregateState = "stopped" | "starting" | "ready" | "fail" | "stale";
export type UnitState = "pending" | "running" | "pass" | "ready" | "fail" | "stopped";

export interface CheckStatus {
  state: UnitState;
  log: string;
  command?: string;
}

export interface ServiceStatus {
  state: UnitState;
  url?: string;
  log: string;
  command?: string;
}

export interface StatusDocument {
  version: 1;
  state: AggregateState;
  url?: string;
  primaryService: string;
  startedAt: string;
  updatedAt: string;
  staleAfterMs: number;
  commands: {
    start: "devstate start";
    stop: "devstate stop";
    status: "devstate status";
    check: "devstate check";
  };
  checks: Record<string, CheckStatus>;
  services: Record<string, ServiceStatus>;
}

export interface ControlDocument {
  version: 1;
  token: string;
  supervisorPid: number;
  socketPath: string;
  updatedAt: string;
  servicePids?: number[];
}

export const STALE_AFTER_MS = 10_000;
export const COMMANDS = {
  start: "devstate start",
  stop: "devstate stop",
  status: "devstate status",
  check: "devstate check",
} as const;

export function createStatus(config: DevStateConfig, state: AggregateState): StatusDocument {
  const now = new Date().toISOString();
  return {
    version: 1,
    state,
    primaryService: config.primaryService,
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
        },
      ]),
    ),
  };
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
  const lines = ["# devstate", "", `- state: ${status.state}`];

  if (status.url !== undefined) {
    lines.push(`- url: ${status.url}`);
  }

  lines.push(
    `- updated: ${status.updatedAt}`,
    "",
    "## Commands",
    "",
    "```bash",
    `$ ${status.commands.start} # setup, check, start services`,
    `$ ${status.commands.check} # check`,
    `$ ${status.commands.status} # print this file`,
    `$ ${status.commands.stop} # check, stop services`,
    "```",
    "",
    "## Outputs",
    "",
    "```bash",
  );

  for (const [id, check] of Object.entries(status.checks)) {
    lines.push(`$ ${check.command ?? `check.${id}`} # ${check.log}`);
  }

  for (const [id, service] of Object.entries(status.services)) {
    lines.push(`$ ${service.command ?? `service.${id}`} # ${service.log}`);
  }

  lines.push("```");
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

function commandToDisplay(command: { command: string; args?: string[] }): string {
  return [command.command, ...(command.args ?? [])].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
