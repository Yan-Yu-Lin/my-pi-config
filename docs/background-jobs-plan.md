# Background jobs + subagents plan

## V1 scope

Build a Pi extension that provides a unified background job registry.

Job kinds:

- `bash`: a background shell command
- `subagent`: a one-shot/resumable Pi subagent run

Every job has:

- stable internal ID (`sh_001`, `sa_001`)
- current OS PID while running
- status (`starting`, `running`, `done`, `error`, `aborted`)
- log path
- cwd
- creation/update timestamps

Subagent jobs also track:

- Pi session ID/file when discovered from JSON events
- model/thinking/tools
- agent definition name
- latest prompt/result/error

## User/model controls

Tools:

- `background_bash` — start a shell command as a managed job
- `subagent_start` — start a subagent job
- `subagent_resume` — resume an existing subagent session by internal ID
- `job_status` — list/check jobs
- `job_output` — show job output/result/log tail
- `job_stop` — terminate any running job by internal ID or PID

Commands:

- `/jobs list`
- `/jobs output <id>`
- `/jobs stop <id>`
- `/sub agents`
- `/sub start <prompt>`
- `/sub resume <id> <prompt>`

## Process model

Use `pi -p --mode json` for subagents in V1.

Rationale:

- emits a session event with ID
- exits after prompt completion
- can be resumed later with `--session <id>`
- simple to kill via PID

A later V2 may use RPC/SDK for long-lived multi-session supervision.

## Out of scope for V1

- switching the central transcript view
- managing multiple live Pi views/tabs
- persistent daemon that survives parent Pi exit
