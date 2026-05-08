# agent-dev-spec.md

## Goal

`agent-dev` = agent-first dev loop supervisor.

One command starts setup/check/services. One status doc tells agent current health.

Tracked config: `agent-dev.json`.

Generated ignored state:

- `.agent-dev/status.md`
- `.agent-dev/status.json`
- `.agent-dev/logs/*.txt`
- `.agent-dev/control.json`
- `.agent-dev/control.sock`

## Runtime

- Node `>=24.12`.
- TypeScript source, compiled JS.
- npm tooling.
- no runtime deps.
- dev deps: `typescript`, `@types/node`.
- macOS/Linux first. Windows best-effort.
- https://viteplus.dev/ (installed globally) for `vp check --fix`

## Package

Create files:

```txt
package.json
tsconfig.json
README.md
LICENSE
agent-dev-spec.md
schema/v1.json
src/cli.ts
src/config.ts
src/status.ts
src/process.ts
src/supervisor.ts
src/probes.ts
src/fs.ts
src/graph.ts
src/*.test.ts
```

`package.json`:

- name `agent-dev`
- version `0.1.0`
- type `module`
- bin `{ "agent-dev": "./dist/cli.js" }`
- files `["dist", "schema", "README.md", "LICENSE"]`
- scripts:
  - `build`: `tsc -p tsconfig.json`
  - `check`: `tsc --noEmit`
  - `test`: `npm run build && node --test dist`
  - `prepack`: `npm run test`
- engines `{ "node": ">=24.12" }`
- license `MIT`

## CLI

Commands:

- `agent-dev init`
- `agent-dev start`
- `agent-dev stop`
- `agent-dev status`
- `agent-dev check`

Exit codes:

- `0` success/healthy
- `1` runtime/config/health failure
- `2` bad CLI usage

No prompts.

`init`:

- if `agent-dev.json` missing, write sample config.
- if `.gitignore` missing, create it.
- append `.agent-dev/` once.
- do not overwrite existing config.

`start`:

- load `agent-dev.json`.
- validate.
- create `.agent-dev/`.
- run `setup` commands sequentially.
- run `checks` sequentially.
- spawn detached supervisor.
- wait until all services ready or fail/timeout.
- print:
  - `status: .agent-dev/status.md`
  - `url: <primary url>` when known
- return.

`check`:

- load config.
- run `checks` only.
- update check logs/status.
- exit nonzero if any check fails.

`status`:

- read `.agent-dev/status.md`.
- recompute stale from `.agent-dev/status.json.updatedAt`.
- print Markdown.
- exit `0` only if aggregate state `ready`.
- exit `1` for `fail`, `stale`, `stopped`, missing status.

`stop`:

- send JSON line to control socket: `{ "token": "...", "command": "stop" }`.
- supervisor kills services, writes stopped status, removes socket.
- idempotent: no supervisor/status -> stopped success.
- fallback: if socket missing but control heartbeat fresh `<10s`, kill internal pid groups. If stale, do not kill pids.

## Config

Config file: `agent-dev.json`.

No shell strings. Commands use argv.

Shape:

```json
{
  "$schema": "https://unpkg.com/agent-dev/schema/v1.json",
  "version": 1,
  "primaryService": "web",
  "setup": {
    "install": {
      "command": "npm",
      "args": ["install"],
      "cwd": ".",
      "env": {}
    }
  },
  "checks": {
    "check": {
      "command": "npm",
      "args": ["run", "check"]
    }
  },
  "services": {
    "web": {
      "command": "npm",
      "args": ["run", "dev"],
      "url": { "from": "log", "match": "(https?://\\S+)" },
      "ready": [{ "type": "http", "url": "$url", "status": 200 }]
    },
    "test": {
      "command": "npm",
      "args": ["run", "test", "--", "--watch"],
      "ready": [{ "type": "log", "match": "PASS" }],
      "dependsOn": ["web"]
    }
  }
}
```

Validation:

- `version` must be `1`.
- ids match `^[a-zA-Z][a-zA-Z0-9_-]*$`.
- `primaryService` exists in `services`.
- every command non-empty string.
- every `args` item string.
- `cwd` optional, relative path only.
- `env` optional string map.
- `dependsOn` service ids exist.
- dependency graph has no cycle.
- `ready` optional array.
- probe regex must compile.
- http status integer `100..599`.

## Probes

Defaults:

- ready timeout `30000ms`.
- poll every `250ms`.
- stdout/stderr merged to one log.
- raw logs preserved.
- ANSI stripped for matching only.

Probe types:

```json
{ "type": "log", "match": "PASS" }
{ "type": "http", "url": "$url", "status": 200 }
```

`$url` = captured service URL.

URL capture:

```json
"url": { "from": "log", "match": "(https?://\\S+)" }
```

First capture group wins. If no group, full match wins.

Setup/check health = process exit `0`.

## Supervisor

Start service graph by dependency readiness.

No restart.

Service exit:

- before ready -> `fail`
- after ready -> `fail`
- aggregate -> `fail`

Shutdown:

- kill child process groups with `SIGTERM`.
- wait `1500ms`.
- kill remaining with `SIGKILL`.
- write final stopped status.

No public status pid fields.

Internal `control.json` may contain:

```json
{
  "version": 1,
  "token": "...",
  "supervisorPid": 123,
  "socketPath": ".agent-dev/control.sock",
  "updatedAt": "..."
}
```

## Status

State vocab:

- aggregate: `stopped`, `starting`, `ready`, `fail`, `stale`
- units: `pending`, `running`, `pass`, `ready`, `fail`, `stopped`

`status.json`:

```json
{
  "version": 1,
  "state": "ready",
  "url": "http://localhost:3000",
  "primaryService": "web",
  "startedAt": "...",
  "updatedAt": "...",
  "staleAfterMs": 10000,
  "commands": {
    "start": "agent-dev start",
    "stop": "agent-dev stop",
    "status": "agent-dev status",
    "check": "agent-dev check"
  },
  "checks": {
    "check": { "state": "pass", "log": ".agent-dev/logs/check-check.txt" }
  },
  "services": {
    "web": {
      "state": "ready",
      "url": "http://localhost:3000",
      "log": ".agent-dev/logs/service-web.txt"
    }
  }
}
```

`status.md` caveman format:

```md
# agent-dev

state: ready
url: http://localhost:3000
updated: 2026-05-08T00:00:00.000Z
staleAfterMs: 10000

cmd.start: agent-dev start
cmd.stop: agent-dev stop
cmd.status: agent-dev status
cmd.check: agent-dev check

check.check: pass .agent-dev/logs/check-check.txt
service.web: ready http://localhost:3000 .agent-dev/logs/service-web.txt
```

## Tests

Use `node:test`, temp dirs, fixture Node scripts.

Must cover:

- config sample validates.
- bad ids, missing command, bad deps, cycles, bad probes fail.
- `init` writes config and appends `.agent-dev/` once.
- `start` runs setup -> checks -> services.
- service log URL capture works.
- http ready probe works.
- log ready probe works.
- status MD/JSON have no pid fields.
- stale status computed after old `updatedAt`.
- `status` exit `0` when ready, `1` when fail/stale/stopped.
- `check` runs checks only.
- failed check exits `1`.
- crashed service marks fail.
- `stop` stops services.
- double `stop` exits `0`.
