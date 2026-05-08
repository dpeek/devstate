import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { sampleConfig, validateConfig, type DevStateConfig } from "./config.js";
import { ensureStateDirs, statePath } from "./fs.js";
import { createStatus, readStatusJson, statusToMarkdown, writeStatus } from "./status.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("config sample validates and invalid config fails", () => {
  assert.equal(validateConfig(sampleConfig).primaryService, "web");

  const cases: Array<[string, unknown]> = [
    [
      "bad id",
      {
        ...clone(sampleConfig),
        primaryService: "1bad",
        services: { "1bad": clone(sampleConfig.services.web) },
      },
    ],
    [
      "missing command",
      withWebService((service) => {
        delete (service as unknown as Record<string, unknown>).command;
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
        service.ready = [{ type: "log", match: "[" }];
      }),
    ],
  ];

  for (const [name, config] of cases) {
    assert.throws(() => validateConfig(config), { name: "ConfigError" }, name);
  }
});

test("init writes config and appends gitignore once", async (t) => {
  const root = await tempDir(t);

  assert.equal((await runCli(root, ["init"])).code, 0);
  assert.equal((await runCli(root, ["init"])).code, 0);

  const config = JSON.parse(await readFile(join(root, "devstate.json"), "utf8")) as DevStateConfig;
  assert.equal(config.version, 1);

  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  assert.equal(gitignore.split(/\r?\n/).filter((line) => line === ".devstate").length, 1);
});

test("cli runs when invoked through a symlinked bin path", async (t) => {
  const root = await tempDir(t);
  const binDir = join(root, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "devstate");
  await symlink(cliPath, binPath);

  const init = await runCli(root, ["init"], 10_000, binPath);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /config: devstate\.json/);
  assert.equal(JSON.parse(await readFile(join(root, "devstate.json"), "utf8")).version, 1);
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
    version: 1,
    primaryService: "web",
    setup: {
      install: { command: process.execPath, args: ["record.mjs", "setup"] },
    },
    checks: {
      check: { command: process.execPath, args: ["record.mjs", "check"] },
    },
    services: {
      web: {
        command: process.execPath,
        args: ["service.mjs"],
        url: { from: "log", match: "(http://\\S+)" },
        ready: [{ type: "log", match: "READY" }],
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /status: \.devstate\/status\.md/);
  assert.match(start.stdout, /url: http:\/\/127\.0\.0\.1:4567/);

  const order = (await readFile(join(root, "order.txt"), "utf8")).trim().split("\n");
  assert.deepEqual(order, ["setup", "check", "service"]);

  const statusJson = await readFile(statePath(root, "status.json"), "utf8");
  const statusMd = await readFile(statePath(root, "status.md"), "utf8");
  assert.equal(statusJson.toLowerCase().includes("pid"), false);
  assert.equal(statusMd.toLowerCase().includes("pid"), false);

  const status = await readStatusJson(root);
  assert.equal(status?.state, "ready");
  assert.equal(status?.services.web?.url, "http://127.0.0.1:4567");

  const repeatedStart = await runCli(root, ["start"], 15_000);
  assert.equal(repeatedStart.code, 1);
  assert.match(repeatedStart.stdout, /status: \.devstate\/status\.md/);
  assert.match(repeatedStart.stderr, /supervisor already running/);
  assert.deepEqual((await readFile(join(root, "order.txt"), "utf8")).trim().split("\n"), order);

  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
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
    version: 1,
    primaryService: "web",
    checks: {},
    setup: {},
    services: {
      web: {
        command: process.execPath,
        args: ["http-service.mjs"],
        url: { from: "log", match: "(http://\\S+)" },
        ready: [{ type: "http", url: "$url", status: 200 }],
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 0, start.stderr);
  assert.match(start.stdout, /url: http:\/\/127\.0\.0\.1:\d+/);
  assert.equal((await runCli(root, ["stop"], 15_000)).code, 0);
});

test("status exits 0 only for ready and recomputes stale", async (t) => {
  const root = await tempDir(t);
  await ensureStateDirs(root);
  const config = validateConfig(sampleConfig);
  const status = createStatus(config, "ready");
  status.url = "http://127.0.0.1:3000";
  status.services.web = {
    state: "ready",
    url: "http://127.0.0.1:3000",
    log: ".devstate/logs/service-web.txt",
  };
  await writeStatus(root, status);

  const ready = await runCli(root, ["status"]);
  assert.equal(ready.code, 0);
  assert.match(ready.stdout, /state: ready/);

  status.state = "fail";
  await writeStatus(root, status);
  assert.equal((await runCli(root, ["status"])).code, 1);

  status.state = "stopped";
  await writeStatus(root, status);
  assert.equal((await runCli(root, ["status"])).code, 1);

  status.state = "ready";
  status.updatedAt = "2000-01-01T00:00:00.000Z";
  await writeFile(statePath(root, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  await writeFile(statePath(root, "status.md"), statusToMarkdown(status));

  const stale = await runCli(root, ["status"]);
  assert.equal(stale.code, 1);
  assert.match(stale.stdout, /state: stale/);
});

test("check runs checks only and failed check exits 1", async (t) => {
  const root = await tempDir(t);
  await writeScript(
    root,
    "mark-check.mjs",
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('check-ran', 'yes');\n",
  );
  await writeScript(
    root,
    "mark-service.mjs",
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('service-ran', 'yes');\nsetInterval(() => {}, 1000);\n",
  );
  await writeScript(root, "fail.mjs", "process.exit(2);\n");
  await writeConfig(root, {
    version: 1,
    primaryService: "web",
    setup: {},
    checks: {
      check: { command: process.execPath, args: ["mark-check.mjs"] },
    },
    services: {
      web: {
        command: process.execPath,
        args: ["mark-service.mjs"],
        ready: [],
      },
    },
  });

  assert.equal((await runCli(root, ["check"])).code, 0);
  assert.equal(await readFile(join(root, "check-ran"), "utf8"), "yes");
  await assert.rejects(readFile(join(root, "service-ran"), "utf8"));

  const config = JSON.parse(await readFile(join(root, "devstate.json"), "utf8")) as DevStateConfig;
  config.checks = { check: { command: process.execPath, args: ["fail.mjs"] } };
  await writeConfig(root, config);
  assert.equal((await runCli(root, ["check"])).code, 1);
});

test("crashed service marks aggregate fail", async (t) => {
  const root = await tempDir(t);
  await writeScript(root, "crash.mjs", "console.log('starting');\nprocess.exit(3);\n");
  await writeConfig(root, {
    version: 1,
    primaryService: "web",
    setup: {},
    checks: {},
    services: {
      web: {
        command: process.execPath,
        args: ["crash.mjs"],
        ready: [{ type: "log", match: "READY" }],
      },
    },
  });

  const start = await runCli(root, ["start"], 15_000);
  assert.equal(start.code, 1);
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

function withWebService(
  mutator: (service: NonNullable<DevStateConfig["services"]["web"]>) => void,
): DevStateConfig {
  const config = clone(sampleConfig);
  mutator(config.services.web!);
  return config;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
