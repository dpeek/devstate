# devstate spec

## Goal

`devstate` = agent-first dev loop supervisor.

One command starts setup/check/services. One status doc tells agent current health.

Tracked config: `devstate.json`.

Generated ignored state:

- `.devstate/status.md`
- `.devstate/status.json`
- `.devstate/logs/*.txt`
- `.devstate/control.json`
- `.devstate/control.sock`

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
SPEC.md
schema/v1.json
src/cli.ts
src/config.ts
src/status.ts
src/process.ts
src/supervisor.ts
src/probes.ts
src/fs.ts
src/graph.ts
src/index.ts
src/*.test.ts
```

`package.json`:

- name `devstate`
- version `0.1.0`
- type `module`
- bin `{ "devstate": "./dist/cli.js" }`
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

- `devstate init`
- `devstate start`
- `devstate stop`
- `devstate status`
- `devstate check`

Exit codes:

- `0` success/healthy
- `1` runtime/config/health failure
- `2` bad CLI usage

No prompts.

`init`:

- if `devstate.json` missing, write sample config.
- if `.gitignore` missing, create it.
- append `.devstate/` once.
- do not overwrite existing config.

`start`:

- load `devstate.json`.
- validate.
- if an existing supervisor heartbeat is fresh `<10s`, do not start another supervisor; print the status path and exit `1`.
- if an existing supervisor heartbeat is stale, remove stale control files/socket and continue.
- create `.devstate/`.
- run `setup` commands sequentially.
- write setup logs to `.devstate/logs/setup-<id>.txt`; setup commands are not included in public status.
- run `checks` sequentially.
- spawn detached supervisor.
- wait until all services ready or fail/timeout.
- print:
  - `status: .devstate/status.md`
  - `url: <primary url>` when known
- return.

`check`:

- load config.
- run `checks` only.
- update check logs/status.
- if all checks pass, preserve the existing aggregate state.
- if any check fails, set aggregate state `fail`.
- exit nonzero if any check fails.

`status`:

- read `.devstate/status.md`.
- recompute stale from `.devstate/status.json.updatedAt`.
- when stale, print stale Markdown but do not rewrite `status.md` or `status.json`.
- print Markdown.
- exit `0` only if aggregate state `ready`.
- exit `1` for `fail`, `stale`, `stopped`, missing status.

`stop`:

- send JSON line to control socket: `{ "token": "...", "command": "stop" }`.
- supervisor kills services, writes stopped status, removes socket.
- idempotent: no supervisor/status -> stopped success.
- fallback: if socket missing but control heartbeat fresh `<10s`, kill internal pid groups. If stale, do not kill pids.

## Config

Config file: `devstate.json`.

No shell strings. Commands use argv.

Shape:

```json
{
  "$schema": "https://unpkg.com/devstate/schema/v1.json",
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
- service with no `ready` probes is ready immediately after spawn succeeds.

Probe types:

```json
{ "type": "log", "match": "PASS" }
{ "type": "http", "url": "$url", "status": 200 }
```

`$url` = captured service URL.

HTTP probes:

- use `GET`.
- exact final response status must match configured `status`; not any `2xx`.
- each HTTP attempt times out after `2000ms`.
- redirects follow the platform `fetch` default.
- `$url` must already be captured before an HTTP probe using `$url` can pass.

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
- after `fail`, supervisor stays alive to keep heartbeat/control available until `stop`.
- no automatic shutdown on failure.

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
  "socketPath": ".devstate/control.sock",
  "updatedAt": "...",
  "servicePids": [456]
}
```

`servicePids` is internal only. It enables fallback stop when the socket is missing but heartbeat is fresh.

Control socket:

- macOS/Linux use Unix domain socket `.devstate/control.sock`.
- Windows is best-effort; named pipe support may be added, but Windows may fall back to pid-based stop.

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
    "start": "devstate start",
    "stop": "devstate stop",
    "status": "devstate status",
    "check": "devstate check"
  },
  "checks": {
    "check": { "state": "pass", "log": ".devstate/logs/check-check.txt" }
  },
  "services": {
    "web": {
      "state": "ready",
      "url": "http://localhost:3000",
      "log": ".devstate/logs/service-web.txt"
    }
  }
}
```

`status.md` caveman format:

```md
# devstate

state: ready
url: http://localhost:3000
updated: 2026-05-08T00:00:00.000Z
staleAfterMs: 10000

cmd.start: devstate start
cmd.stop: devstate stop
cmd.status: devstate status
cmd.check: devstate check

check.check: pass .devstate/logs/check-check.txt
service.web: ready http://localhost:3000 .devstate/logs/service-web.txt
```

## Tests

Use `node:test`, temp dirs, fixture Node scripts.

The package script is `node --test dist`; make sure compiled output has a runnable `dist` entry point, such as `src/index.ts` importing `*.test.ts`, or change the script and this spec together.

Must cover:

- config sample validates.
- bad ids, missing command, bad deps, cycles, bad probes fail.
- `init` writes config and appends `.devstate/` once.
- `start` runs setup -> checks -> services.
- repeated `start` with fresh heartbeat exits `1` and does not spawn duplicate services.
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
