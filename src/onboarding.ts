import * as p from "@clack/prompts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  type CommandConfig,
  type DevStateConfig,
  type ServiceEventsConfig,
  validateConfig,
} from "./config.ts";
import {
  CONFIG_FILE,
  appendGitignoreOnce,
  assertRelativePath,
  writeJsonFile,
} from "./fs.ts";
import { commandToDisplay } from "./status.ts";
import {
  defaultServiceEvents,
  detectProject,
  type CandidateKind,
  type Confidence,
  type DetectedCandidate,
  type ProjectDetection,
} from "./detect.ts";

export type OnboardingResult = "start" | "done" | "cancelled";
export type ExistingConfigAction = "start" | "edit" | "exit" | "cancelled";

interface EditableItem {
  key: string;
  kind: CandidateKind;
  id: string;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  events?: ServiceEventsConfig;
  confidence: Confidence;
  selected: boolean;
  reason: string;
}

type ServiceEventPreset = "http" | "log" | "watch" | "custom" | "none";

const CONFIG_SCHEMA = "https://unpkg.com/devstate/schema/v1.json";
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

class PromptCancelled extends Error {}

export async function runExistingConfigMenu(
  config: DevStateConfig,
): Promise<ExistingConfigAction> {
  try {
    p.intro("devstate");
    p.note(formatConfigSummary(config), "Current setup");
    const action = await prompt(
      p.select<Exclude<ExistingConfigAction, "cancelled">>({
        message: `${CONFIG_FILE} exists. What do you want to do?`,
        options: [
          { value: "start", label: "Start dev loop", hint: "run devstate start" },
          { value: "edit", label: "Review and edit", hint: "rerun setup assistant" },
          { value: "exit", label: "Exit" },
        ],
        initialValue: "start",
      }),
    );
    if (action === "exit") {
      p.outro("No changes made.");
    }
    return action;
  } catch (error) {
    if (error instanceof PromptCancelled) {
      return "cancelled";
    }
    throw error;
  }
}

export async function runOnboarding(
  root: string,
  existingConfig?: DevStateConfig,
): Promise<OnboardingResult> {
  try {
    const detection = await detectProject(root);
    const setupItems = buildInitialItems("setup", detection, existingConfig);
    const checkItems = buildInitialItems("check", detection, existingConfig);
    const serviceItems = buildInitialItems("service", detection, existingConfig);

    p.intro("devstate setup");

    const setup = setupItems.filter((item) => item.selected);
    const { checks, services } = await selectChecksAndServices(checkItems, serviceItems);
    const rawConfig = configForWrite(setup, checks, services);

    validateConfig(rawConfig);

    p.note(JSON.stringify(rawConfig, null, 2), CONFIG_FILE);
    p.note(formatFileOperations(detection), "File operations");
    const shouldWrite = await prompt(
      p.confirm({
        message: "Write this configuration?",
        initialValue: true,
      }),
    );
    if (!shouldWrite) {
      p.outro("No files written.");
      return "done";
    }

    await appendGitignoreOnce(root);
    await writeJsonFile(join(root, CONFIG_FILE), rawConfig);
    p.log.success(`${CONFIG_FILE} written`);

    const shouldStart = await prompt(
      p.confirm({
        message: "Run devstate start now?",
        initialValue: existingConfig === undefined,
      }),
    );
    p.outro(shouldStart ? "Starting dev loop." : "Setup complete.");
    return shouldStart ? "start" : "done";
  } catch (error) {
    if (error instanceof PromptCancelled) {
      return "cancelled";
    }
    throw error;
  }
}

function buildInitialItems(
  kind: CandidateKind,
  detection: ProjectDetection,
  existingConfig: DevStateConfig | undefined,
): EditableItem[] {
  const items: EditableItem[] = [];
  const usedIds = new Set<string>();
  const seenCommands = new Set<string>();

  if (existingConfig !== undefined) {
    for (const [id, command] of Object.entries(commandsForKind(existingConfig, kind))) {
      const item = itemFromCurrentConfig(kind, id, command);
      items.push(item);
      usedIds.add(item.id);
      seenCommands.add(commandKey(item));
    }
  }

  for (const candidate of detection.candidates.filter((value) => value.kind === kind)) {
    const key = commandKey(candidate);
    if (seenCommands.has(key)) {
      continue;
    }
    const item = itemFromCandidate(candidate, usedIds, existingConfig === undefined);
    items.push(item);
    usedIds.add(item.id);
    seenCommands.add(commandKey(item));
  }

  return items;
}

function commandsForKind(
  config: DevStateConfig,
  kind: CandidateKind,
): Record<string, CommandConfig & { events?: ServiceEventsConfig }> {
  if (kind === "setup") {
    return config.setup;
  }
  if (kind === "check") {
    return config.checks;
  }
  return config.services;
}

function itemFromCurrentConfig(
  kind: CandidateKind,
  id: string,
  command: CommandConfig & { events?: ServiceEventsConfig },
): EditableItem {
  const item: EditableItem = {
    key: randomUUID(),
    kind,
    id,
    cmd: [...command.cmd],
    confidence: "high",
    selected: true,
    reason: "current devstate.json",
  };
  if (command.cwd !== undefined) {
    item.cwd = command.cwd;
  }
  if (command.env !== undefined) {
    item.env = { ...command.env };
  }
  if (kind === "service" && "events" in command && command.events !== undefined) {
    item.events = structuredClone(command.events);
  }
  return item;
}

function itemFromCandidate(
  candidate: DetectedCandidate,
  usedIds: Set<string>,
  useDetectedDefault: boolean,
): EditableItem {
  const item: EditableItem = {
    key: randomUUID(),
    kind: candidate.kind,
    id: uniqueId(candidate.id, usedIds),
    cmd: [...candidate.cmd],
    confidence: candidate.confidence,
    selected: useDetectedDefault && candidate.selectedByDefault,
    reason: candidate.reason,
  };
  if (candidate.cwd !== undefined) {
    item.cwd = candidate.cwd;
  }
  if (candidate.events !== undefined) {
    item.events = structuredClone(candidate.events);
  }
  return item;
}

async function selectChecksAndServices(
  checkItems: EditableItem[],
  serviceItems: EditableItem[],
): Promise<{ checks: EditableItem[]; services: EditableItem[] }> {
  const items = [...checkItems, ...serviceItems];
  while (true) {
    if (items.every((item) => item.kind !== "service")) {
      p.log.warn("No service scripts were detected. Add one service command.");
      const service = await promptCustomItem("service", new Set());
      service.selected = true;
      items.push(service);
    }

    const selectedKeys = await prompt(
      p.multiselect<string>({
        message: "Select checks and services",
        options: items.map((item) => ({
          value: item.key,
          label: `${item.kind}.${item.id}: ${commandToDisplay(item)}`,
          hint: `${item.selected ? "selected" : "optional"} - ${item.confidence} - ${item.reason}`,
        })),
        initialValues: items.filter((item) => item.selected).map((item) => item.key),
        required: true,
      }),
    );
    const selected = new Set(selectedKeys);
    for (const item of items) {
      item.selected = selected.has(item.key);
    }

    const checks = items.filter((item) => item.kind === "check" && item.selected);
    const services = items.filter((item) => item.kind === "service" && item.selected);
    if (services.length > 0) {
      return { checks, services };
    }
    p.log.warn("Select at least one service.");
  }
}

async function promptCustomItem(
  kind: CandidateKind,
  usedIds: Set<string>,
): Promise<EditableItem> {
  const id = await prompt(
    p.text({
      message: "ID",
      initialValue: defaultId(kind),
      validate(value) {
        return validatePromptId(value, usedIds);
      },
    }),
  );
  const command = await prompt(
    p.text({
      message: "Command",
      placeholder: kind === "service" ? "npm run dev" : "npm run check",
      validate(value) {
        return parseCommandForPrompt(value).error;
      },
    }),
  );
  const parsed = parseShellCommand(command);
  p.note(JSON.stringify(parsed), "Parsed argv");

  const cwd = await prompt(
    p.text({
      message: "Working directory",
      placeholder: "project root",
      validate(value) {
        return validateCwd(value);
      },
    }),
  );
  const envText = await prompt(
    p.text({
      message: "Environment JSON",
      placeholder: "{}",
      validate(value) {
        return parseEnvForPrompt(value).error;
      },
    }),
  );

  const item: EditableItem = {
    key: randomUUID(),
    kind,
    id,
    cmd: parsed,
    confidence: "high",
    selected: true,
    reason: "custom command",
  };
  if (cwd.trim().length > 0) {
    item.cwd = cwd.trim();
  }
  const env = parseEnv(envText);
  if (env !== undefined) {
    item.env = env;
  }
  if (kind === "service") {
    const events = await promptServiceEvents(undefined);
    if (events !== undefined) {
      item.events = events;
    }
  }
  return item;
}

async function promptServiceEvents(
  existing: ServiceEventsConfig | undefined,
): Promise<ServiceEventsConfig | undefined> {
  const preset = await prompt(
    p.select<ServiceEventPreset>({
      message: "Service events",
      options: [
        { value: "http", label: "Capture URL and HTTP ready", hint: "recommended for dev servers" },
        { value: "log", label: "Log ready pattern" },
        { value: "watch", label: "Watch run/pass/fail patterns" },
        { value: "custom", label: "Custom events JSON" },
        { value: "none", label: "No events" },
      ],
      initialValue: inferServiceEventPreset(existing),
    }),
  );

  if (preset === "http") {
    return defaultServiceEvents();
  }
  if (preset === "none") {
    return undefined;
  }
  if (preset === "log") {
    const ready = await promptRegex("Ready log pattern", logPattern(existing?.ready) ?? "ready|listening|started");
    return { ready: { log: ready } };
  }
  if (preset === "watch") {
    const ready = await promptRegex("Ready log pattern", logPattern(existing?.ready) ?? "watching");
    const run = await promptRegex("Run started pattern", logPattern(existing?.run) ?? "run started");
    const pass = await promptRegex("Run passed pattern", logPattern(existing?.pass) ?? "run passed");
    const fail = await promptRegex("Run failed pattern", logPattern(existing?.fail) ?? "run failed");
    return {
      ready: { log: ready },
      run: { log: run },
      pass: { log: pass },
      fail: { log: fail },
    };
  }

  const initialValue = existing === undefined ? "{}" : JSON.stringify(eventsForWrite(existing));
  const raw = await prompt(
    p.text({
      message: "Events JSON",
      initialValue,
      validate(value) {
        return parseEventsForPrompt(value).error;
      },
    }),
  );
  return parseEvents(raw);
}

async function promptRegex(message: string, initialValue: string): Promise<string> {
  return await prompt(
    p.text({
      message,
      initialValue,
      validate(value) {
        if (value === undefined || value.length === 0) {
          return "Enter a regular expression";
        }
        try {
          new RegExp(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "Invalid regular expression";
        }
      },
    }),
  );
}

function configForWrite(
  setup: EditableItem[],
  checks: EditableItem[],
  services: EditableItem[],
): unknown {
  return {
    $schema: CONFIG_SCHEMA,
    setup: commandMapForWrite(setup),
    checks: commandMapForWrite(checks),
    services: commandMapForWrite(services),
  };
}

function commandMapForWrite(items: EditableItem[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const item of items) {
    const command: Record<string, unknown> = { cmd: item.cmd };
    if (item.cwd !== undefined) {
      command.cwd = item.cwd;
    }
    if (item.env !== undefined) {
      command.env = item.env;
    }
    if (item.kind === "service" && item.events !== undefined) {
      command.events = eventsForWrite(item.events);
    }
    output[item.id] = command;
  }
  return output;
}

function eventsForWrite(events: ServiceEventsConfig): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (events.url !== undefined) {
    output.url = { log: events.url.log };
  }
  for (const key of ["ready", "run", "pass", "fail"] as const) {
    const probe = events[key];
    if (probe === undefined) {
      continue;
    }
    if ("log" in probe) {
      output[key] = { log: probe.log };
    } else {
      output[key] = probe.status === undefined || probe.status === 200
        ? { http: probe.http }
        : { http: probe.http, status: probe.status };
    }
  }
  return output;
}

function formatConfigSummary(config: DevStateConfig): string {
  return [
    ...formatCommandSection("Setup", config.setup),
    ...formatCommandSection("Checks", config.checks),
    ...formatCommandSection("Services", config.services),
  ].join("\n");
}

function formatCommandSection(title: string, commands: Record<string, CommandConfig>): string[] {
  const entries = Object.entries(commands);
  if (entries.length === 0) {
    return [`${title}: none`];
  }
  return [`${title}:`, ...entries.map(([id, command]) => `  ${id}: ${commandToDisplay(command)}`)];
}

function formatFileOperations(detection: ProjectDetection): string {
  return [
    detection.hasGitignore ? "update .gitignore if needed" : "create .gitignore",
    detection.hasConfig ? `update ${CONFIG_FILE}` : `create ${CONFIG_FILE}`,
  ].join("\n");
}

function defaultId(kind: CandidateKind): string {
  switch (kind) {
    case "setup":
      return "setup";
    case "check":
      return "check";
    case "service":
      return "web";
  }
}

function validatePromptId(value: string | undefined, usedIds: Set<string>): string | undefined {
  if (value === undefined || value.length === 0) {
    return "Enter an ID";
  }
  if (!ID_RE.test(value)) {
    return `ID must match ${ID_RE.source}`;
  }
  if (usedIds.has(value)) {
    return "ID is already used in this section";
  }
  return undefined;
}

function validateCwd(value: string | undefined): string | undefined {
  const cwd = value?.trim() ?? "";
  if (cwd.length === 0) {
    return undefined;
  }
  try {
    assertRelativePath(cwd, "cwd");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid relative path";
  }
}

function parseCommandForPrompt(value: string | undefined): { error?: string } {
  if (value === undefined || value.trim().length === 0) {
    return { error: "Enter a command" };
  }
  try {
    parseShellCommand(value);
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not parse command" };
  }
}

function parseEnvForPrompt(value: string | undefined): { error?: string } {
  try {
    parseEnv(value ?? "");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid environment JSON" };
  }
}

function parseEventsForPrompt(value: string | undefined): { error?: string } {
  try {
    parseEvents(value ?? "");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid events JSON" };
  }
}

function parseEnv(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return undefined;
  }
  const raw = JSON.parse(trimmed) as unknown;
  if (!isRecord(raw)) {
    throw new Error("Environment must be a JSON object");
  }
  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(raw)) {
    if (typeof envValue !== "string") {
      throw new Error(`Environment value ${key} must be a string`);
    }
    env[key] = envValue;
  }
  return env;
}

function parseEvents(value: string): ServiceEventsConfig | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return undefined;
  }
  const raw = JSON.parse(trimmed) as unknown;
  const config = validateConfig({
    services: {
      web: {
        cmd: ["node", "-e", "setInterval(() => {}, 1000)"],
        events: raw,
      },
    },
  });
  return config.services.web?.events;
}

function parseShellCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    throw new Error("Command ends with an unfinished escape");
  }
  if (quote !== null) {
    throw new Error("Command has an unclosed quote");
  }
  if (current.length > 0) {
    args.push(current);
  }
  if (args.length === 0) {
    throw new Error("Command must contain at least one argument");
  }
  return args;
}

function inferServiceEventPreset(events: ServiceEventsConfig | undefined): ServiceEventPreset {
  if (events === undefined) {
    return "http";
  }
  if (events.run !== undefined || events.pass !== undefined || events.fail !== undefined) {
    return "watch";
  }
  if (events.url !== undefined || (events.ready !== undefined && "http" in events.ready)) {
    return "http";
  }
  if (events.ready !== undefined && "log" in events.ready) {
    return "log";
  }
  return "custom";
}

function logPattern(probe: ServiceEventsConfig["ready"]): string | undefined {
  return probe !== undefined && "log" in probe ? probe.log : undefined;
}

function uniqueId(preferred: string, usedIds: Set<string>): string {
  if (!usedIds.has(preferred)) {
    return preferred;
  }
  let index = 2;
  while (usedIds.has(`${preferred}-${index}`)) {
    index += 1;
  }
  return `${preferred}-${index}`;
}

function commandKey(command: Pick<EditableItem | DetectedCandidate, "cmd" | "cwd">): string {
  return JSON.stringify({ cmd: command.cmd, cwd: command.cwd ?? "." });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function prompt<T>(value: Promise<T | symbol>): Promise<T> {
  const result = await value;
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    throw new PromptCancelled();
  }
  return result;
}
