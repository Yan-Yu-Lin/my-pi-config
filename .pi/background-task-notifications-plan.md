# Background task notification plan

## Goal

Every managed background task should notify the main agent when it completes, whether the task is a background bash command or a subagent.

This notification should be runtime/system generated, not a human/user message.

## Desired flow

1. Main agent starts a background job (`background_bash` or `subagent_start`).
2. Tool returns immediately with a stable job ID (`sh_001`, `sa_001`) and current PID if available.
3. Main agent can continue working.
4. When the job completes, the extension injects a `task-notification` custom message into the session with `deliverAs: "followUp"` and `triggerTurn: true`.
5. The model sees a structured notification containing status, tail/summary, and a path to full output.
6. The terminal UI shows a compact/foldable card, not a fake user message.

## Notification content

Model-visible content should be compact and structured:

```xml
<task-notification>
  <job-id>sa_001</job-id>
  <kind>subagent</kind>
  <status>done</status>
  <summary>Short tail/result snippet...</summary>
  <output-path>/path/to/full-output.md</output-path>
  <log-path>/path/to/log</log-path>
</task-notification>
```

For bash jobs, `summary` is the log tail. For subagents, `summary` is the final result snippet.

Full output should be saved to disk and referenced by path rather than always injected into model context.

## UI behavior

Collapsed view:

```text
✓ sa_001 done general — short summary...
```

Expanded view (`Ctrl+O`):

```text
✓ sa_001 done general session:019e...
Prompt/Command: ...
Summary/Tail: ...
Full output: /path/to/output
Log: /path/to/log
```

No extra noisy title like `Background job update` unless needed.

## Semantics

Use `pi.sendMessage(...)`, not `pi.sendUserMessage(...)`.

The message is a runtime custom message (`customType: "task-notification"`), not something the user typed.

Subagent completion and background bash completion are the same kind of event: a managed background job completed.
