import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const STATE_DIR = ".devstate";
export const LOG_DIR = "logs";
export const CONFIG_FILE = "devstate.json";
export const STATUS_JSON = "status.json";
export const STATUS_MD = "status.md";
export const CONTROL_JSON = "control.json";
export const CONTROL_SOCK = "control.sock";
export const OUTPUT_EXCERPT_LINE_LIMIT = 80;
export const OUTPUT_EXCERPT_CHAR_LIMIT = 12_000;
export const OUTPUT_EXCERPT_LINE_CHAR_LIMIT = 1_000;

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function statePath(root: string, ...parts: string[]): string {
  return join(root, STATE_DIR, ...parts);
}

export function displayStatePath(...parts: string[]): string {
  return [STATE_DIR, ...parts].join("/");
}

export function logPath(root: string, name: string): string {
  return statePath(root, LOG_DIR, name);
}

export function displayLogPath(name: string): string {
  return displayStatePath(LOG_DIR, name);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureStateDirs(root: string): Promise<void> {
  await mkdir(statePath(root, LOG_DIR), { recursive: true });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: false });
}

export async function appendGitignoreOnce(root: string): Promise<void> {
  const gitignorePath = join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const lines = current.split(/\r?\n/);
  if (lines.includes(STATE_DIR)) {
    if (!(await exists(gitignorePath))) {
      await writeFile(gitignorePath, current);
    }
    return;
  }

  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await appendFile(gitignorePath, `${prefix}${STATE_DIR}\n`);
}

export function resolveCommandCwd(root: string, cwd?: string): string {
  return resolve(root, cwd ?? ".");
}

export function assertRelativePath(path: string, label: string): void {
  if (path.length === 0 || isAbsolute(path)) {
    throw new Error(`${label} must be a relative path`);
  }
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

export function outputExcerpt(input: string): string {
  const sanitized = stripAnsi(input)
    .split(/\r?\n/)
    .map((line) => truncateLine(line, OUTPUT_EXCERPT_LINE_CHAR_LIMIT))
    .slice(-OUTPUT_EXCERPT_LINE_LIMIT)
    .join("\n");
  if (sanitized.length <= OUTPUT_EXCERPT_CHAR_LIMIT) {
    return sanitized;
  }
  return sanitized.slice(-OUTPUT_EXCERPT_CHAR_LIMIT);
}

export async function fileAgeMs(path: string, now = Date.now()): Promise<number | null> {
  try {
    const info = await stat(path);
    return now - info.mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function truncateLine(line: string, limit: number): string {
  if (line.length <= limit) {
    return line;
  }
  return `${line.slice(0, limit)}...`;
}
