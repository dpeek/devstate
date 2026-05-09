import { existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CONFIG_FILE,
  STATUS_JSON,
  STATUS_MD,
  displayStatePath,
  exists,
  statePath,
} from "./fs.ts";
import { createEmptyStatus, statusToMarkdown } from "./status.ts";

export interface WatchOptions {
  json: boolean;
  wait: boolean;
}

export async function watchStatus(root: string, options: WatchOptions): Promise<number> {
  const statusFile = options.json ? STATUS_JSON : STATUS_MD;
  const path = statePath(root, statusFile);

  if (!options.wait && !(await exists(join(root, CONFIG_FILE)))) {
    writeMissingConfig(options);
    return 1;
  }

  const initial = await readStatus(path, options.json);
  if (!initial.ok && !options.wait) {
    writeMissingStatus(options);
    return 1;
  }

  return await waitForChanges(root, path, options, initial.ok ? initial.text : undefined);
}

export function parseWatchArgs(args: string[]): WatchOptions | null {
  const options: WatchOptions = { json: false, wait: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--wait") {
      options.wait = true;
    } else {
      return null;
    }
  }
  return options;
}

async function waitForChanges(
  root: string,
  path: string,
  options: WatchOptions,
  initialText: string | undefined,
): Promise<number> {
  let lastPrinted = "";
  let pending: NodeJS.Timeout | undefined;
  let close: (code?: number) => void = () => undefined;

  const printLatest = async (): Promise<void> => {
    const result = await readStatus(path, options.json);
    if (!result.ok) {
      if (!options.wait) {
        writeUnreadableStatus(options);
        close(1);
      }
      return;
    }
    if (result.text === lastPrinted) {
      return;
    }
    lastPrinted = result.text;
    process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  };

  if (initialText !== undefined) {
    lastPrinted = initialText;
    process.stdout.write(initialText.endsWith("\n") ? initialText : `${initialText}\n`);
  } else {
    await printLatest();
  }

  return await new Promise<number>((resolve) => {
    const interval = options.wait ? setInterval(() => void printLatest(), 1000) : undefined;
    const watcher = existsSync(statePath(root))
      ? watch(statePath(root), { persistent: true }, (_event, filename) => {
          if (filename?.toString() !== (options.json ? STATUS_JSON : STATUS_MD)) {
            return;
          }
          if (pending !== undefined) {
            clearTimeout(pending);
          }
          pending = setTimeout(() => {
            void printLatest();
          }, 50);
        })
      : undefined;

    close = (code = 0): void => {
      watcher?.close();
      if (interval !== undefined) {
        clearInterval(interval);
      }
      if (pending !== undefined) {
        clearTimeout(pending);
      }
      resolve(code);
    };
    process.once("SIGINT", () => close(0));
    process.once("SIGTERM", () => close(0));
  });
}

async function readStatus(path: string, json: boolean): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    const text = await readFile(path, "utf8");
    if (!json) {
      return { ok: true, text };
    }
    const parsed = JSON.parse(text) as unknown;
    return { ok: true, text: `${JSON.stringify(parsed, null, 2)}\n` };
  } catch {
    return { ok: false };
  }
}

function writeMissingConfig(options: WatchOptions): void {
  if (options.json) {
    process.stderr.write(`${CONFIG_FILE} not found\n`);
    return;
  }
  process.stdout.write(errorMarkdown(`\`${CONFIG_FILE}\` not found. Run \`npx devstate\` interactively first.`));
}

function writeMissingStatus(options: WatchOptions): void {
  if (options.json) {
    process.stderr.write(`${displayStatePath(STATUS_JSON)} not found\n`);
    return;
  }
  process.stdout.write(errorMarkdown(`No status file found. Run \`devstate start\` first.`));
}

function writeUnreadableStatus(options: WatchOptions): void {
  const file = displayStatePath(options.json ? STATUS_JSON : STATUS_MD);
  if (options.json) {
    process.stderr.write(`Unable to read ${file}\n`);
    return;
  }
  process.stdout.write(errorMarkdown(`Unable to read \`${file}\`.`));
}

function errorMarkdown(message: string): string {
  return statusToMarkdown(createEmptyStatus("stopped", { message }));
}
