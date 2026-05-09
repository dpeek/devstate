import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { sampleConfig, validateConfig, type DevStateConfig } from "./config.ts";
import { detectProject } from "./detect.ts";
import { statePath } from "./fs.ts";
import { readStatusJson } from "./status.ts";
import { formatWatchOutput } from "./watch.ts";

const cliExtension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const cliPath = fileURLToPath(new URL(`./cli${cliExtension}`, import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

before(() => {
  console.log("<run>");
  console.clear();
});

after(() => {
  console.log("<ready>");
});

test("current config sample validates and unsupported fields fail", () => {
  const config = validateConfig(sampleConfig);
  assert.equal(config.services.web?.cmd, "npm run dev");
  assert.equal(config.services.web?.events?.ready !== undefined, true);

  const withReadyDefault = validateConfig({
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    services: {
      web: {
        cmd: "npm run dev",
        events: { ready: { http: "http://127.0.0.1:3000" } },
      },
    },
  });
  assert.equal(
    "http" in withReadyDefault.services.web!.events!.ready!
      ? withReadyDefault.services.web!.events!.ready!.status
      : undefined,
    200,
  );

  const cases: Array<[string, unknown]> = [
    ["version", { ...clone(sampleConfig), version: 1 }],
    ["primaryService", { ...clone(sampleConfig), primaryService: "web" }],
    [
      "missing cmd",
      withWebService((service) => {
        delete (service as unknown as Record<string, unknown>).cmd;
      }),
    ],
    [
      "cmd array",
      withWebService((service) => {
        (service as unknown as Record<string, unknown>).cmd = ["npm", "run", "dev"];
      }),
    ],
    [
      "command",
      withWebService((service) => {
        (service as unknown as Record<string, unknown>).command = "npm";
      }),
    ],
    [
      "args",
      withWebService((service) => {
        (service as unknown as Record<string, unknown>).args = ["run", "dev"];
      }),
    ],
    [
      "top-level service url",
      withWebService((service) => {
        (service as unknown as Record<string, unknown>).url = {
          from: "log",
          match: "(https?://\\S+)",
        };
      }),
    ],
    [
      "top-level service ready",
      withWebService((service) => {
        (service as unknown as Record<string, unknown>).ready = [{ type: "log", match: "READY" }];
      }),
    ],
    [
      "awaitable",
      withWebService((service) => {
        (service as unknown as Record<string, unknown>).awaitable = true;
      }),
    ],
    [
      "bad dependency",
      withWebService((service) => {
        service.dependsOn = ["missing"];
      }),
    ],
    [
      "cycle",
      {
        ...clone(sampleConfig),
        services: {
          web: { ...clone(sampleConfig.services.web), dependsOn: ["test"] },
          test: { ...clone(sampleConfig.services.test), dependsOn: ["web"] },
        },
      },
    ],
    [
      "bad probe",
      withWebService((service) => {
        service.events = { ready: { log: "[" } };
      }),
    ],
  ];

  for (const [name, invalidConfig] of cases) {
    assert.throws(() => validateConfig(invalidConfig), { name: "ConfigError" }, name);
  }
});

test("cli runs when invoked through a symlinked bin path", async (t) => {
  const root = await tempDir(t);
  const binDir = join(root, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "devstate");
  await symlink(cliPath, binPath);
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      web: { cmd: shellCommand(process.execPath, "-e", "setInterval(() => {}, 1000)") },
    },
  });

  const check = await runCli(root, ["check"], 10_000, binPath);
  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, /# Dev Tool State/);
  assert.match(check.stdout, /- services: stopped/);
});

test("invalid usage prints Markdown to stdout and exits 2", async (t) => {
  const root = await tempDir(t);
  for (const command of ["bogus", "init", "status"]) {
    const result = await runCli(root, [command]);
    assert.equal(result.code, 2, command);
    assert.match(result.stdout, /# Dev Tool State/, command);
    assert.match(result.stdout, /- usage: invalid command/, command);
    assert.equal(result.stderr, "", command);
  }
});

test("no-arg non-interactive onboarding guidance exits 2", async (t) => {
  const root = await tempDir(t);
  const result = await runCli(root, []);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /# Dev Tool State/);
  assert.match(result.stdout, /run `npx devstate` in an interactive terminal/);
  assert.equal(result.stderr, "");
});

test("no-arg command prints current status when config exists", async (t) => {
  const root = await tempDir(t);
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      web: { cmd: shellCommand(process.execPath, "-e", "setInterval(() => {}, 1000)") },
    },
  });

  const missingStatus = await runCli(root, []);
  assert.equal(missingStatus.code, 1);
  assert.match(missingStatus.stdout, /# Dev Tool State/);
  assert.match(missingStatus.stdout, /No status file found\. Run `devstate start` first\./);

  const check = await runCli(root, ["check"]);
  assert.equal(check.code, 0, check.stderr);

  const status = await runCli(root, []);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /# Dev Tool State/);
  assert.match(status.stdout, /- services: stopped/);
  assert.equal(status.stderr, "");

  const json = await runCli(root, ["--json"]);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).state, "stopped");
  assert.equal(json.stderr, "");
});

test("start never creates missing config implicitly", async (t) => {
  const root = await tempDir(t);
  const result = await runCli(root, ["start"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /# Dev Tool State/);
  assert.match(result.stdout, /devstate\.json not found/);
  assert.match(result.stdout, /Run `npx devstate` interactively/);
  assert.equal(result.stderr, "");

  const json = await runCli(root, ["start", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout).summary.message.includes("devstate.json not found"), true);
  assert.equal(json.stderr, "");
});

test("watch reports missing status without starting services", async (t) => {
  const root = await tempDir(t);
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      web: { cmd: shellCommand(process.execPath, "-e", "setInterval(() => {}, 1000)") },
    },
  });

  const result = await runCli(root, ["--watch"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /# Dev Tool State/);
  assert.match(result.stdout, /Run `devstate start` first/);
  assert.equal(result.stderr, "");

  const invalid = await runCli(root, ["--watch", "--bogus"]);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stdout, /- usage: invalid arguments/);
});

test("check and stop support json but reject watch", async (t) => {
  const root = await tempDir(t);
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      web: { cmd: shellCommand(process.execPath, "-e", "setInterval(() => {}, 1000)") },
    },
  });

  const check = await runCli(root, ["check", "--json"]);
  assert.equal(check.code, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).state, "stopped");
  assert.equal(check.stderr, "");

  const stop = await runCli(root, ["stop", "--json"]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(JSON.parse(stop.stdout).state, "stopped");
  assert.equal(stop.stderr, "");

  for (const command of ["check", "stop"]) {
    const watched = await runCli(root, [command, "--watch"]);
    assert.equal(watched.code, 2, command);
    assert.match(watched.stdout, /- usage: invalid arguments/, command);
    assert.equal(watched.stderr, "", command);
  }
});

test("watch output clears TTY frames but stays plain for pipes", () => {
  assert.equal(formatWatchOutput("status", false), "status\n");
  assert.equal(formatWatchOutput("status\n", false), "status\n");
  assert.equal(formatWatchOutput("status", true), "\u001b[2J\u001b[Hstatus\n");
});

test("onboarding detection finds package manager, checks, and services", async (t) => {
  const root = await tempDir(t);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      scripts: {
        setup: "node setup.mjs",
        check: "tsc --noEmit",
        test: "vitest run",
        dev: "vite --host 127.0.0.1",
        "test:watch": "vitest --watch",
        build: "vite build",
      },
    }),
  );
  await writeFile(join(root, "package-lock.json"), "{}");

  const detection = await detectProject(root);
  assert.equal(detection.projectName, "fixture-app");
  assert.equal(detection.packageManager, "npm");
  assert.equal(detection.scriptCount, 6);

  const setup = detection.candidates.find(
    (candidate) => candidate.kind === "setup" && candidate.id === "setup",
  );
  assert.equal(setup?.cmd, "npm run setup");
  assert.equal(setup?.selectedByDefault, true);

  const check = detection.candidates.find(
    (candidate) => candidate.kind === "check" && candidate.id === "check",
  );
  assert.equal(check?.cmd, "npm run check");
  assert.equal(check?.confidence, "high");
  assert.equal(check?.selectedByDefault, true);

  const web = detection.candidates.find(
    (candidate) => candidate.kind === "service" && candidate.id === "web",
  );
  assert.equal(web?.cmd, "npm run dev");
  assert.equal(web?.selectedByDefault, true);
  assert.equal(web?.events?.url?.log, "(https?://\\S+)");

  const watch = detection.candidates.find(
    (candidate) => candidate.kind === "service" && candidate.id === "test-watch",
  );
  assert.equal(watch?.cmd, "npm run test:watch");
  assert.equal(watch?.events, undefined);

  assert.equal(
    detection.candidates.some(
      (candidate) => candidate.kind === "service" && candidate.id === "build",
    ),
    false,
  );
});

test("start runs setup, checks, service, captures URL, and stop is idempotent", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "record.mjs",
    "import { appendFileSync } from 'node:fs';\nappendFileSync('order.txt', `${process.argv[2]}\\n`);\n",
  );
  await writeScript(
    root,
    "service.mjs",
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync('order.txt', 'service\\n');",
      "console.log('listening http://127.0.0.1:4567');",
      "console.log('READY');",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {
      install: { cmd: shellCommand(process.execPath, "record.mjs", "setup") },
    },
    checks: {
      check: { cmd: shellCommand(process.execPath, "record.mjs", "check") },
    },
    services: {
      web: {
        cmd: shellCommand(process.execPath, "service.mjs"),
        events: {
          url: { log: "(http://\\S+)" },
          ready: { log: "READY" },
        },
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /# Dev Tool State/);
  assert.match(start.stdout, /- checks: ok/);
  assert.match(start.stdout, /- services: running/);
  assert.match(start.stdout, /- url: http:\/\/127\.0\.0\.1:4567/);
  assert.match(
    start.stdout,
    /🟢 pass `.*record\.mjs check` \| `\.devstate\/logs\/check-check\.txt`/,
  );
  assert.match(
    start.stdout,
    /🟢 ready `.*service\.mjs` \| http:\/\/127\.0\.0\.1:4567 \| `\.devstate\/logs\/service-web\.txt`/,
  );

  const order = (await readFile(join(root, "order.txt"), "utf8")).trim().split("\n");
  assert.deepEqual(order, ["setup", "check", "service"]);

  const statusJson = await readFile(statePath(root, "status.json"), "utf8");
  const statusMd = await readFile(statePath(root, "status.md"), "utf8");
  assert.equal(statusJson.toLowerCase().includes("pid"), false);
  assert.equal(statusMd.toLowerCase().includes("pid"), false);
  assert.equal(statusJson.includes("primaryService"), false);

  const status = await readStatusJson(root);
  assert.equal(status?.state, "running");
  assert.equal(status?.services.web?.url, "http://127.0.0.1:4567");

  const repeatedStart = await runCli(root, ["start"], 15_000);
  assert.equal(repeatedStart.code, 1);
  assert.match(repeatedStart.stdout, /# Dev Tool State/);
  assert.match(repeatedStart.stdout, /- services: running/);
  assert.equal(repeatedStart.stderr, "");
  assert.deepEqual((await readFile(join(root, "order.txt"), "utf8")).trim().split("\n"), order);

  const stop = await runCli(root, ["stop"], 15_000);
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /- services: stopped/);
  assert.doesNotMatch(stop.stdout, /## Services/);
  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
});

test("start supports json output", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "service.mjs",
    [
      "console.log('listening http://127.0.0.1:4568');",
      "console.log('READY');",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      web: {
        cmd: shellCommand(process.execPath, "service.mjs"),
        events: {
          url: { log: "(http://\\S+)" },
          ready: { log: "READY" },
        },
      },
    },
  });

  const start = await runCli(root, ["start", "--json"], 15_000);
  assert.equal(start.code, 0, start.stderr);
  const status = JSON.parse(start.stdout);
  assert.equal(status.state, "running");
  assert.equal(status.services.web.url, "http://127.0.0.1:4568");
  assert.equal(start.stderr, "");
  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
});

test("http ready probe waits for captured service URL", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "http-service.mjs",
    [
      "import http from 'node:http';",
      "const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
      "server.listen(0, '127.0.0.1', () => {",
      "  const address = server.address();",
      "  console.log(`URL http://127.0.0.1:${address.port}`);",
      "});",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n"),
  );
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    checks: {},
    setup: {},
    services: {
      web: {
        cmd: shellCommand(process.execPath, "http-service.mjs"),
        events: {
          url: { log: "(http://\\S+)" },
          ready: { http: "$url" },
        },
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /url: http:\/\/127\.0\.0\.1:\d+/);
  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
});

test("check runs checks when stopped and failed check includes bounded excerpt", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "mark-check.mjs",
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('check-ran', 'yes');\n",
  );
  await writeScript(
    root,
    "mark-shell.mjs",
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('shell-ran', 'yes');\n",
  );
  await writeScript(
    root,
    "mark-service.mjs",
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('service-ran', 'yes');\nsetInterval(() => {}, 1000);\n",
  );
  await writeScript(
    root,
    "fail.mjs",
    "console.log('\\u001b[31mfirst line\\u001b[0m');\nfor (let i = 0; i < 100; i += 1) console.log(`line ${i}`);\nprocess.exit(2);\n",
  );
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {
      check: {
        cmd: [
          shellCommand(process.execPath, "mark-check.mjs"),
          shellCommand(process.execPath, "mark-shell.mjs"),
        ].join(" && "),
      },
    },
    services: {
      web: {
        cmd: shellCommand(process.execPath, "mark-service.mjs"),
      },
    },
  });

  const check = await runCli(root, ["check"]);
  assert.equal(check.code, 0);
  assert.match(check.stdout, /# Dev Tool State/);
  assert.match(check.stdout, /- services: stopped/);
  assert.doesNotMatch(check.stdout, /## Checks/);
  assert.equal(await readFile(join(root, "check-ran"), "utf8"), "yes");
  assert.equal(await readFile(join(root, "shell-ran"), "utf8"), "yes");
  await assert.rejects(readFile(join(root, "service-ran"), "utf8"));

  const config = JSON.parse(await readFile(join(root, "devstate.json"), "utf8")) as DevStateConfig;
  config.checks = { check: { cmd: shellCommand(process.execPath, "fail.mjs") } };
  await writeConfig(root, config);
  const failedCheck = await runCli(root, ["check"]);
  assert.equal(failedCheck.code, 1);
  assert.match(failedCheck.stdout, /- checks: fail/);
  assert.match(failedCheck.stdout, /🔴 fail `.*fail\.mjs` \| `\.devstate\/logs\/check-check\.txt`/);
  assert.match(failedCheck.stdout, /Output excerpt, last 80 lines:/);
  // oxlint-disable-next-line
  assert.doesNotMatch(failedCheck.stdout, /\u001b/);
  assert.doesNotMatch(failedCheck.stdout, /line 0/);
  assert.match(failedCheck.stdout, /line 99/);
});

test("check waits for an awaitable service to become idle", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "trigger-check.mjs",
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('trigger', String(Date.now()));\n",
  );
  await writeScript(
    root,
    "watch-service.mjs",
    [
      "import { existsSync, unlinkSync } from 'node:fs';",
      "console.log('watching');",
      "console.log('run started');",
      "setTimeout(() => console.log('run passed'), 100);",
      "let busy = false;",
      "setInterval(() => {",
      "  if (busy || !existsSync('trigger')) return;",
      "  busy = true;",
      "  unlinkSync('trigger');",
      "  console.log('run started');",
      "  setTimeout(() => { console.log('run passed'); busy = false; }, 300);",
      "}, 50);",
      "process.on('SIGTERM', () => process.exit(0));",
    ].join("\n"),
  );
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {
      test: { cmd: shellCommand(process.execPath, "trigger-check.mjs") },
    },
    services: {
      test: {
        cmd: shellCommand(process.execPath, "watch-service.mjs"),
        events: {
          ready: { log: "watching" },
          run: { log: "run started" },
          pass: { log: "run passed" },
          fail: { log: "run failed" },
        },
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 0, start.stderr);

  const check = await runCli(root, ["check"], 15_000);
  assert.equal(check.code, 0, check.stderr);
  assert.match(
    check.stdout,
    /🟢 pass `.*watch-service\.mjs` \| `\.devstate\/logs\/service-test\.txt`/,
  );
  const status = await readStatusJson(root);
  assert.equal(status?.services.test?.state, "pass");
  assert.equal(status?.services.test?.lastResult, "pass");
  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
});

test("run events clear awaitable service logs", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "watch-service.mjs",
    [
      "process.stdout.write('boot output\\nrun started\\nstale first output\\n');",
      "setTimeout(() => console.log('run passed'), 50);",
      "setTimeout(() => {",
      "  console.log('between run stale output');",
      "  console.log('run started');",
      "  console.log('fresh failure output');",
      "  setTimeout(() => console.log('run failed'), 50);",
      "}, 250);",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      test: {
        cmd: shellCommand(process.execPath, "watch-service.mjs"),
        events: {
          ready: { log: "boot output" },
          run: { log: "run started" },
          pass: { log: "run passed" },
          fail: { log: "run failed" },
        },
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 0, start.stderr);
  await waitForServiceState(root, "test", "fail");

  const serviceLog = await waitForFileText(statePath(root, "logs", "service-test.txt"), (text) =>
    text.includes("run failed"),
  );
  assert.doesNotMatch(serviceLog, /boot output/);
  assert.doesNotMatch(serviceLog, /stale first output/);
  assert.doesNotMatch(serviceLog, /between run stale output/);
  assert.match(serviceLog, /run started/);
  assert.match(serviceLog, /fresh failure output/);
  assert.match(serviceLog, /run failed/);
  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
});

test("crashed service marks aggregate fail and includes excerpt", async (t) => {
  const root = await tempDir(t);
  await writeScript(root, "crash.mjs", "console.log('starting');\nprocess.exit(3);\n");
  await writeConfig(root, {
    $schema: "https://unpkg.com/devstate/schema/v1.json",
    setup: {},
    checks: {},
    services: {
      web: {
        cmd: shellCommand(process.execPath, "crash.mjs"),
        events: { ready: { log: "READY" } },
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 1);
  assert.match(start.stdout, /- services: fail/);
  assert.match(start.stdout, /Output excerpt, last 80 lines:/);
  assert.match(start.stdout, /starting/);
  const status = await readStatusJson(root);
  assert.equal(status?.state, "fail");
  assert.equal(status?.services.web?.state, "fail");
  await runCli(root, ["stop"], 15_000);
});

async function tempDir(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devstate-"));
  t.after(async () => {
    await runCli(root, ["stop"], 15_000).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeScript(root: string, name: string, source: string): Promise<void> {
  await writeFile(join(root, name), source);
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  await writeFile(join(root, "devstate.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function runCli(
  root: string,
  args: string[],
  timeoutMs = 10_000,
  entryPath = cliPath,
): Promise<CliResult> {
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout, stderr: `${stderr}timeout\n` });
    }, timeoutMs);

    function finish(result: CliResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

async function waitForServiceState(
  root: string,
  id: string,
  state: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatusJson(root);
    if (status?.services[id]?.state === state) {
      return;
    }
    await delay(50);
  }
  assert.fail(`timed out waiting for service ${id} to become ${state}`);
}

async function waitForFileText(
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    try {
      latest = await readFile(path, "utf8");
      if (predicate(latest)) {
        return latest;
      }
    } catch {
      // The writer may not have created the file yet.
    }
    await delay(50);
  }
  assert.fail(`timed out waiting for ${path}`);
}

function withWebService(
  mutator: (service: NonNullable<DevStateConfig["services"]["web"]>) => void,
): DevStateConfig {
  const config = clone(sampleConfig);
  mutator(config.services.web!);
  return config;
}

function shellCommand(...args: string[]): string {
  return args.map(shellArg).join(" ");
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
