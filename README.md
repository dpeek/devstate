# devstate

`devstate` is an agent-first development loop supervisor. A project can define setup commands, checks, and long-running services in `devstate.json`; one command starts the loop and writes a stable status document for an agent to inspect.

## Install

```sh
npm install
npm run build
```

## Commands

```sh
devstate init
devstate start
devstate stop
devstate status
devstate check
```

`devstate start` runs setup commands, runs checks, starts the service graph, waits for readiness, and writes:

- `.devstate/status.md`
- `.devstate/status.json`
- `.devstate/logs/*.txt`
- `.devstate/control.json`
- `.devstate/control.sock`

The `.devstate/` directory is generated state and should be ignored by git.

## Configuration

Run `devstate init` to create a sample `devstate.json` and append `.devstate/` to `.gitignore`.

Commands are argv arrays, not shell strings:

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
    }
  }
}
```

## Status

Agents should read `.devstate/status.md` first. It is intentionally plain:

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
