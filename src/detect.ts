import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ServiceEventsConfig } from "./config.ts";
import { CONFIG_FILE, exists } from "./fs.ts";

export type CandidateKind = "setup" | "check" | "service";
export type Confidence = "high" | "medium" | "low";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface DetectedCandidate {
  kind: CandidateKind;
  id: string;
  cmd: string[];
  cwd?: string;
  confidence: Confidence;
  selectedByDefault: boolean;
  reason: string;
  events?: ServiceEventsConfig;
}

export interface ProjectDetection {
  projectName: string;
  packageManager: PackageManager;
  packageManagerReason: string;
  scriptCount: number;
  hasPackageJson: boolean;
  hasGitignore: boolean;
  hasConfig: boolean;
  candidates: DetectedCandidate[];
}

interface PackageJsonInfo {
  name?: string;
  scripts: Record<string, string>;
}

const SETUP_SCRIPT_CONFIDENCE = new Map<string, Confidence>([
  ["setup", "high"],
  ["bootstrap", "high"],
  ["db:setup", "high"],
  ["db:migrate", "high"],
  ["prisma:generate", "high"],
  ["prepare", "medium"],
]);

const HIGH_CHECK_SCRIPTS = new Set(["check", "typecheck", "lint", "test:ci", "verify"]);
const MEDIUM_CHECK_SCRIPTS = new Set(["test", "format:check"]);
const HIGH_SERVICE_SCRIPTS = new Set(["dev", "storybook", "docs:dev"]);
const MEDIUM_SERVICE_SCRIPTS = new Set(["start", "serve", "preview", "docs"]);

const DEFAULT_SERVICE_EVENTS: ServiceEventsConfig = {
  url: { log: "(https?://\\S+)" },
  ready: { http: "$url", status: 200 },
};

export async function detectProject(root: string): Promise<ProjectDetection> {
  const packageJson = await readPackageJson(root);
  const packageManager = await detectPackageManager(root, packageJson !== null);
  const candidates: DetectedCandidate[] = [];
  const usedSetupIds = new Set<string>();
  const usedCheckIds = new Set<string>();
  const usedServiceIds = new Set<string>();

  candidates.push({
    kind: "setup",
    id: makeUniqueId("install", usedSetupIds),
    cmd: installCommand(packageManager.name),
    confidence: "high",
    selectedByDefault: true,
    reason: `${packageManager.name} install command`,
  });

  for (const [name, command] of Object.entries(packageJson?.scripts ?? {})) {
    const setupConfidence = SETUP_SCRIPT_CONFIDENCE.get(name);
    if (setupConfidence !== undefined) {
      candidates.push({
        kind: "setup",
        id: makeUniqueId(name, usedSetupIds),
        cmd: runScriptCommand(packageManager.name, name),
        confidence: setupConfidence,
        selectedByDefault: setupConfidence === "high",
        reason: `script "${name}" looks like project setup`,
      });
    }

    const check = detectCheckScript(name, command, packageManager.name, usedCheckIds);
    if (check !== null) {
      candidates.push(check);
    }

    const service = detectServiceScript(name, command, packageManager.name, usedServiceIds);
    if (service !== null) {
      candidates.push(service);
    }
  }

  selectDefaultService(candidates);

  return {
    projectName: packageJson?.name ?? "unnamed project",
    packageManager: packageManager.name,
    packageManagerReason: packageManager.reason,
    scriptCount: Object.keys(packageJson?.scripts ?? {}).length,
    hasPackageJson: packageJson !== null,
    hasGitignore: await exists(join(root, ".gitignore")),
    hasConfig: await exists(join(root, CONFIG_FILE)),
    candidates,
  };
}

export function defaultServiceEvents(): ServiceEventsConfig {
  return structuredClone(DEFAULT_SERVICE_EVENTS);
}

function detectCheckScript(
  name: string,
  command: string,
  packageManager: PackageManager,
  usedIds: Set<string>,
): DetectedCandidate | null {
  if (isLongRunningScript(name, command)) {
    return null;
  }

  const lowerName = name.toLowerCase();
  const lowerCommand = command.toLowerCase();
  let confidence: Confidence | null = null;
  let reason = "";

  if (HIGH_CHECK_SCRIPTS.has(lowerName)) {
    confidence = "high";
    reason = `standard finite check script "${name}"`;
  } else if (MEDIUM_CHECK_SCRIPTS.has(lowerName)) {
    confidence = "medium";
    reason = `common check script "${name}"`;
  } else if (runsKnownCheckTool(lowerCommand)) {
    confidence = "medium";
    reason = `script command runs a known check tool`;
  } else if (/\b(validate|audit|quality)\b/.test(lowerName)) {
    confidence = "low";
    reason = `script name suggests validation`;
  }

  if (confidence === null) {
    return null;
  }

  return {
    kind: "check",
    id: makeUniqueId(name, usedIds),
    cmd: runScriptCommand(packageManager, name),
    confidence,
    selectedByDefault: confidence === "high",
    reason,
  };
}

function detectServiceScript(
  name: string,
  command: string,
  packageManager: PackageManager,
  usedIds: Set<string>,
): DetectedCandidate | null {
  const lowerName = name.toLowerCase();
  const lowerCommand = command.toLowerCase();
  const watchTest = isWatchTestService(lowerName, lowerCommand);
  let confidence: Confidence | null = null;
  let reason = "";

  if (watchTest) {
    confidence = "medium";
    reason = `watch-mode test service "${name}"`;
  } else if (isClearlyBuildOrCheckScript(lowerName, lowerCommand)) {
    return null;
  } else if (HIGH_SERVICE_SCRIPTS.has(lowerName)) {
    confidence = "high";
    reason = `standard long-running service script "${name}"`;
  } else if (MEDIUM_SERVICE_SCRIPTS.has(lowerName)) {
    confidence = "medium";
    reason = `common service script "${name}"`;
  }

  if (confidence === null) {
    return null;
  }

  const candidate: DetectedCandidate = {
    kind: "service",
    id: makeUniqueId(name === "dev" ? "web" : name, usedIds),
    cmd: runScriptCommand(packageManager, name),
    confidence,
    selectedByDefault: false,
    reason,
  };
  if (!watchTest && probablyHttpService(lowerName, lowerCommand)) {
    candidate.events = defaultServiceEvents();
  }
  return candidate;
}

function selectDefaultService(candidates: DetectedCandidate[]): void {
  const services = candidates.filter((candidate) => candidate.kind === "service");
  if (services.length === 0) {
    return;
  }

  const score = (candidate: DetectedCandidate): number => {
    const confidence =
      candidate.confidence === "high" ? 100 : candidate.confidence === "medium" ? 50 : 0;
    const commandName = candidate.cmd.at(-1) ?? "";
    const preference = [
      "dev",
      "storybook",
      "docs:dev",
      "start",
      "serve",
      "preview",
      "docs",
      "test:watch",
    ];
    const index = preference.indexOf(commandName);
    return confidence + (index === -1 ? 0 : preference.length - index);
  };

  const [best] = [...services].sort((a, b) => score(b) - score(a));
  if (best !== undefined) {
    best.selectedByDefault = true;
  }
}

async function detectPackageManager(
  root: string,
  hasPackageJson: boolean,
): Promise<{ name: PackageManager; reason: string }> {
  if (await exists(join(root, "package-lock.json"))) {
    return { name: "npm", reason: "package-lock.json" };
  }
  if (await exists(join(root, "pnpm-lock.yaml"))) {
    return { name: "pnpm", reason: "pnpm-lock.yaml" };
  }
  if (await exists(join(root, "yarn.lock"))) {
    return { name: "yarn", reason: "yarn.lock" };
  }
  if ((await exists(join(root, "bun.lock"))) || (await exists(join(root, "bun.lockb")))) {
    return { name: "bun", reason: "bun lockfile" };
  }
  if (hasPackageJson) {
    return { name: "npm", reason: "package.json" };
  }
  return { name: "npm", reason: "fallback" };
}

async function readPackageJson(root: string): Promise<PackageJsonInfo | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (!isRecord(raw)) {
    return { scripts: {} };
  }

  const scripts: Record<string, string> = {};
  if (isRecord(raw.scripts)) {
    for (const [name, value] of Object.entries(raw.scripts)) {
      if (typeof value === "string") {
        scripts[name] = value;
      }
    }
  }

  const info: PackageJsonInfo = { scripts };
  if (typeof raw.name === "string") {
    info.name = raw.name;
  }
  return info;
}

function installCommand(packageManager: PackageManager): string[] {
  return [packageManager, "install"];
}

function runScriptCommand(packageManager: PackageManager, script: string): string[] {
  return [packageManager, "run", script];
}

function isLongRunningScript(name: string, command: string): boolean {
  const lowerName = name.toLowerCase();
  const lowerCommand = command.toLowerCase();
  if (/\b(watch|dev|serve)\b/.test(lowerName)) {
    return true;
  }
  return /(^|\s)--watch(\s|$)/.test(lowerCommand);
}

function runsKnownCheckTool(command: string): boolean {
  return (
    /(^|[;&|]\s*)(tsc|eslint|biome)(\s|$)/.test(command) ||
    /\bvitest\s+run\b/.test(command) ||
    /(^|[;&|]\s*)jest(\s|$)/.test(command)
  );
}

function isWatchTestService(name: string, command: string): boolean {
  return (
    name === "test:watch" ||
    (/\bvitest\b/.test(command) && /(^|\s)--watch(\s|$)/.test(command)) ||
    (/\bjest\b/.test(command) && /(^|\s)--watch(\s|$)/.test(command))
  );
}

function isClearlyBuildOrCheckScript(name: string, command: string): boolean {
  if (/^(build|check|typecheck|lint|test|test:ci|verify|format|format:check)(:|$)/.test(name)) {
    return true;
  }
  return runsKnownCheckTool(command) && !isWatchTestService(name, command);
}

function probablyHttpService(name: string, command: string): boolean {
  return (
    /\b(dev|start|serve|preview|storybook|docs)\b/.test(name) ||
    /\b(next|vite|webpack-dev-server|astro|nuxt|svelte-kit|storybook|serve)\b/.test(command)
  );
}

function makeUniqueId(source: string, used: Set<string>): string {
  const base = sanitizeId(source);
  let id = base;
  let index = 2;
  while (used.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  used.add(id);
  return id;
}

function sanitizeId(source: string): string {
  const normalized = source
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const candidate = normalized.length === 0 ? "item" : normalized;
  return /^[a-zA-Z]/.test(candidate) ? candidate : `task-${candidate}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
