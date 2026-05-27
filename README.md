# my-pi-config

Personal Pi configuration and extensions.

## V1: background jobs + subagents

This package starts with a practical background job manager for Pi:

- run shell commands as managed background jobs
- start/resume/stop subagents as managed jobs
- stable IDs like `sh_001` and `sa_001`
- PID tracking while jobs are running
- per-session registries under `~/.pi/agent/background-jobs/workspaces/<session-id>/`
- subagent sessions stored separately from normal Pi `/resume` sessions
- bottom widget showing running/done/error jobs

Install locally while developing:

```bash
pi install /Users/linyanyu/my-pi-config
```

Then in Pi:

```text
/reload
/jobs list
/sub agents
```
