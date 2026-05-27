import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type JobKind = "bash" | "subagent";
type JobStatus = "starting" | "running" | "done" | "error" | "aborted";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type JobSource = "package" | "user" | "project";

type JobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  pid?: number;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  logPath: string;
  outputPath: string;
  command?: string;
  agent?: string;
  agentSource?: JobSource;
  prompt?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  piSessionId?: string;
  sessionFile?: string;
  lastResult?: string;
  lastError?: string;
  exitCode?: number;
};

type Registry = {
  next: Record<string, number>;
  jobs: JobRecord[];
  workspaceId: string;
  workspaceDir: string;
  logDir: string;
  outputDir: string;
  registryPath: string;
  subagentSessionDir: string;
};

type AgentDefinition = {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt: string;
  source: JobSource;
  filePath: string;
};

type JsonRecord = Record<string, unknown>;

const EXTENSION_TOOLS = new Set([
  "background_bash",
  "subagent_start",
  "subagent_resume",
  "job_status",
  "job_output",
  "job_stop",
]);
const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const BASE_JOB_DIR = join(getAgentDir(), "background-jobs");
const PROJECT_AGENT_DIR = ".pi/subagents";
const USER_AGENT_DIR = join(getAgentDir(), "subagents");
const PACKAGE_AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "subagents");

function sanitizeWorkspaceId(id: string) {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function getWorkspaceId(ctx: ExtensionContext) {
  return sanitizeWorkspaceId(ctx.sessionManager.getSessionId() || "global");
}

function registryPaths(workspaceId: string) {
  const workspaceDir = join(BASE_JOB_DIR, "workspaces", sanitizeWorkspaceId(workspaceId));
  return {
    workspaceId: sanitizeWorkspaceId(workspaceId),
    workspaceDir,
    logDir: join(workspaceDir, "logs"),
    outputDir: join(workspaceDir, "outputs"),
    registryPath: join(workspaceDir, "registry.json"),
    subagentSessionDir: join(workspaceDir, "subagent-sessions"),
  };
}

function ensureDirs(registry: Pick<Registry, "logDir" | "outputDir" | "subagentSessionDir">) {
  mkdirSync(registry.logDir, { recursive: true });
  mkdirSync(registry.outputDir, { recursive: true });
  mkdirSync(registry.subagentSessionDir, { recursive: true });
}

function now() {
  return Date.now();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function messageContentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function normalizeTools(tools: string[] | undefined) {
  const input = tools && tools.length > 0 ? tools : DEFAULT_SUBAGENT_TOOLS;
  return [...new Set(input.map((tool) => tool.trim()).filter(Boolean))].filter((tool) => !EXTENSION_TOOLS.has(tool));
}

function emptyRegistry(workspaceId: string): Registry {
  const paths = registryPaths(workspaceId);
  return { next: { sh: 1, sa: 1 }, jobs: [], ...paths };
}

function loadRegistry(workspaceId: string): Registry {
  const registry = emptyRegistry(workspaceId);
  ensureDirs(registry);
  if (!existsSync(registry.registryPath)) return registry;
  try {
    const parsed = JSON.parse(readFileSync(registry.registryPath, "utf8")) as Partial<Pick<Registry, "next" | "jobs">>;
    registry.next = { sh: parsed.next?.sh ?? 1, sa: parsed.next?.sa ?? 1 };
    registry.jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs.map((job) => ({
          ...job,
          outputPath: job.outputPath ?? (job.kind === "bash" ? job.logPath : join(registry.outputDir, `${job.id}.md`)),
        }))
      : [];
    return registry;
  } catch {
    return registry;
  }
}

function saveRegistry(registry: Registry) {
  ensureDirs(registry);
  writeFileSync(registry.registryPath, `${JSON.stringify({ next: registry.next, jobs: registry.jobs }, null, 2)}\n`, "utf8");
}

function createJob(registry: Registry, kind: JobKind, cwd: string): JobRecord {
  const prefix = kind === "bash" ? "sh" : "sa";
  const count = registry.next[prefix] ?? 1;
  registry.next[prefix] = count + 1;
  const id = `${prefix}_${String(count).padStart(3, "0")}`;
  const createdAt = now();
  const logPath = join(registry.logDir, `${id}.log`);
  const job: JobRecord = {
    id,
    kind,
    status: "starting",
    cwd,
    createdAt,
    updatedAt: createdAt,
    logPath,
    outputPath: kind === "bash" ? logPath : join(registry.outputDir, `${id}.md`),
  };
  registry.jobs.push(job);
  saveRegistry(registry);
  return job;
}

function updateJob(registry: Registry, id: string, patch: Partial<JobRecord>) {
  const job = registry.jobs.find((candidate) => candidate.id === id);
  if (!job) return undefined;
  Object.assign(job, patch, { updatedAt: now() });
  saveRegistry(registry);
  return job;
}

function findJob(registry: Registry, idOrPid: string) {
  const byId = registry.jobs.find((job) => job.id === idOrPid);
  if (byId) return byId;
  const pid = Number(idOrPid);
  if (Number.isInteger(pid)) return registry.jobs.find((job) => job.pid === pid);
  return undefined;
}

function processAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reconcileRunningJobs(registry: Registry) {
  let changed = false;
  for (const job of registry.jobs) {
    if ((job.status === "starting" || job.status === "running") && job.pid && !processAlive(job.pid)) {
      job.status = "error";
      job.lastError = job.lastError ?? "Process is no longer running; parent extension did not observe completion.";
      job.pid = undefined;
      job.updatedAt = now();
      changed = true;
    }
  }
  if (changed) saveRegistry(registry);
}

function appendLog(job: JobRecord, text: string) {
  mkdirSync(dirname(job.logPath), { recursive: true });
  writeFileSync(job.logPath, text, { flag: "a", encoding: "utf8" });
}

function formatJobLine(job: JobRecord) {
  const icon = job.status === "running" || job.status === "starting" ? "⏳" : job.status === "done" ? "✓" : "✗";
  const label = job.kind === "subagent" ? job.agent ?? "subagent" : job.command ?? "bash";
  const pid = job.pid ? ` pid:${job.pid}` : "";
  const session = job.piSessionId ? ` session:${job.piSessionId.slice(0, 8)}` : "";
  return `${icon} ${job.id} ${job.status} ${label}${pid}${session}`;
}

function isJobRecord(value: unknown): value is JobRecord {
  return isRecord(value) && typeof value.id === "string" && (value.kind === "bash" || value.kind === "subagent");
}

function formatJobLineStyled(job: JobRecord, theme: ExtensionContext["ui"]["theme"]) {
  const iconColor = job.status === "done" ? "success" : job.status === "running" || job.status === "starting" ? "warning" : "error";
  const icon = job.status === "running" || job.status === "starting" ? "⏳" : job.status === "done" ? "✓" : "✗";
  const label = job.kind === "subagent" ? job.agent ?? "subagent" : job.command ?? "bash";
  const pid = job.pid ? theme.fg("dim", ` pid:${job.pid}`) : "";
  const session = job.piSessionId ? theme.fg("dim", ` session:${job.piSessionId.slice(0, 8)}`) : "";
  return `${theme.fg(iconColor, icon)} ${theme.fg("warning", job.id)} ${theme.fg(iconColor, job.status)} ${theme.fg("toolTitle", label)}${pid}${session}`;
}

function updateWidget(ctx: ExtensionContext, registry: Registry) {
  if (!ctx.hasUI) return;
  reconcileRunningJobs(registry);
  const recent = registry.jobs.slice(-5);
  if (recent.length === 0) {
    ctx.ui.setWidget("background-jobs", undefined);
    return;
  }
  const running = registry.jobs.filter((job) => job.status === "running" || job.status === "starting").length;
  const lines = [
    `${ctx.ui.theme.fg("warning", "Background jobs")}: ${running} running · ${registry.jobs.length} total`,
    ...recent.map((job) => formatJobLineStyled(job, ctx.ui.theme)),
  ];
  ctx.ui.setWidget("background-jobs", lines, { placement: "belowEditor" });
}

async function tailFile(path: string, maxLines: number) {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trimEnd();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function tailFileSync(path: string, maxLines: number) {
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trimEnd();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

function oneLine(text: string, maxChars: number) {
  return truncateText(text.replace(/\s+/g, " ").trim(), maxChars);
}

function xmlEscape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getJobSummary(job: JobRecord, maxChars = 1200) {
  const source = job.lastResult || job.lastError || tailFileSync(job.logPath, 20) || "(no output)";
  return truncateText(source.trim(), maxChars);
}

function buildTaskNotificationContent(job: JobRecord) {
  const summary = getJobSummary(job, 2000);
  const action = job.kind === "subagent" ? job.prompt : job.command;
  return [
    "<task-notification>",
    `  <job-id>${xmlEscape(job.id)}</job-id>`,
    `  <kind>${xmlEscape(job.kind)}</kind>`,
    `  <status>${xmlEscape(job.status)}</status>`,
    job.agent ? `  <agent>${xmlEscape(job.agent)}</agent>` : undefined,
    job.piSessionId ? `  <session-id>${xmlEscape(job.piSessionId)}</session-id>` : undefined,
    action ? `  <task>${xmlEscape(action)}</task>` : undefined,
    `  <summary>${xmlEscape(summary)}</summary>`,
    `  <output-path>${xmlEscape(job.outputPath)}</output-path>`,
    `  <log-path>${xmlEscape(job.logPath)}</log-path>`,
    "</task-notification>",
  ].filter(Boolean).join("\n");
}

function renderTaskNotification(job: JobRecord, expanded: boolean, theme: ExtensionContext["ui"]["theme"]) {
  const summary = getJobSummary(job, expanded ? 4000 : 220);
  const actionLabel = job.kind === "subagent" ? "Prompt" : "Command";
  const action = job.kind === "subagent" ? job.prompt : job.command;

  if (!expanded) {
    const suffix = summary ? theme.fg("dim", ` — ${oneLine(summary, 180)}`) : "";
    return `${formatJobLineStyled(job, theme)}${suffix}`;
  }

  const lines = [
    formatJobLineStyled(job, theme),
    action ? `${theme.fg("muted", `${actionLabel}:`)} ${action}` : undefined,
    job.piSessionId ? `${theme.fg("muted", "Session:")} ${job.piSessionId}` : undefined,
    `${theme.fg("muted", "Full output:")} ${job.outputPath}`,
    `${theme.fg("muted", "Log:")} ${job.logPath}`,
    "",
    theme.fg("muted", "Summary / tail:"),
    summary,
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function parseToolList(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

async function loadAgentsFromDir(dir: string, source: JobSource): Promise<AgentDefinition[]> {
  try {
    await access(dir);
  } catch {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = join(dir, entry.name);
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    if (!content) continue;
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const name = asString(frontmatter.name) ?? basename(entry.name, ".md");
    const description = asString(frontmatter.description) ?? "Subagent";
    agents.push({
      name,
      description,
      model: asString(frontmatter.model),
      thinking: isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
      tools: parseToolList(frontmatter.tools),
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

async function discoverAgents(cwd: string) {
  const packageAgents = await loadAgentsFromDir(PACKAGE_AGENT_DIR, "package");
  const userAgents = await loadAgentsFromDir(USER_AGENT_DIR, "user");
  const projectAgents = await loadAgentsFromDir(resolve(cwd, PROJECT_AGENT_DIR), "project");
  const map = new Map<string, AgentDefinition>();
  for (const agent of packageAgents) map.set(agent.name, agent);
  for (const agent of userAgents) map.set(agent.name, agent);
  for (const agent of projectAgents) map.set(agent.name, agent);
  return [...map.values()];
}

async function writeTempPrompt(registry: Registry, id: string, prompt: string) {
  const dir = join(registry.workspaceDir, "tmp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-system.md`);
  await writeFile(path, prompt, { encoding: "utf8", mode: 0o600 });
  return path;
}

function buildModelArgs(model: string | undefined, thinking: ThinkingLevel | undefined) {
  const args: string[] = [];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  return args;
}

function extractFinalAssistantText(event: JsonRecord) {
  const messages = event.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return undefined;
}

function readJsonLines(buffer: string, chunk: string, onLine: (line: string) => void) {
  const combined = buffer + chunk;
  const lines = combined.split("\n");
  const nextBuffer = lines.pop() ?? "";
  for (const line of lines) onLine(line);
  return nextBuffer;
}

function startBashJob(
  registry: Registry,
  ctx: ExtensionContext,
  command: string,
  cwd: string,
  name: string | undefined,
) {
  const job = createJob(registry, "bash", cwd);
  job.command = name ? `${name}: ${command}` : command;
  saveRegistry(registry);

  appendLog(job, `$ ${command}\n\n`);
  const child = spawn(process.env.SHELL ?? "/bin/bash", ["-lc", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bindChild(registry, ctx, job, child, true);
  return job;
}

function bindChild(
  registry: Registry,
  ctx: ExtensionContext,
  job: JobRecord,
  child: ChildProcess,
  reportCompletion: boolean,
) {
  updateJob(registry, job.id, { pid: child.pid, status: "running" });
  updateWidget(ctx, registry);

  child.stdout?.on("data", (data: Buffer) => appendLog(job, data.toString()));
  child.stderr?.on("data", (data: Buffer) => appendLog(job, data.toString()));
  child.on("error", (error) => {
    updateJob(registry, job.id, { status: "error", pid: undefined, lastError: error.message });
    updateWidget(ctx, registry);
  });
  child.on("close", (code, signal) => {
    const status: JobStatus = signal ? "aborted" : code === 0 ? "done" : "error";
    const current = updateJob(registry, job.id, {
      status,
      pid: undefined,
      exitCode: code ?? undefined,
      lastError: status === "error" ? `Process exited with code ${code}` : undefined,
      outputPath: job.logPath,
    });
    updateWidget(ctx, registry);
    if (reportCompletion && current) reportJobCompletion(current);
  });
}

function startSubagentJob(
  registry: Registry,
  ctx: ExtensionContext,
  options: {
    prompt: string;
    agent?: AgentDefinition;
    model?: string;
    thinking?: ThinkingLevel;
    tools?: string[];
    cwd: string;
    session?: string;
    reportCompletion?: boolean;
  },
) {
  const job = options.session
    ? findJob(registry, options.session) ?? createJob(registry, "subagent", options.cwd)
    : createJob(registry, "subagent", options.cwd);
  if (job.kind !== "subagent") throw new Error(`${job.id} is not a subagent job`);

  const tools = normalizeTools(options.tools ?? options.agent?.tools);
  const model = options.model ?? options.agent?.model;
  const thinking = options.thinking ?? options.agent?.thinking;
  const prompt = options.prompt;
  const agent = options.agent;
  Object.assign(job, {
    status: "starting" as JobStatus,
    cwd: options.cwd,
    prompt,
    agent: agent?.name ?? job.agent ?? "general",
    agentSource: agent?.source ?? job.agentSource,
    model: model ?? job.model,
    thinking: thinking ?? job.thinking,
    tools,
    lastResult: undefined,
    lastError: undefined,
    updatedAt: now(),
  });
  saveRegistry(registry);

  ensureDirs(registry);
  const args = [
    "-p",
    "--mode",
    "json",
    "--session-dir",
    registry.subagentSessionDir,
    ...buildModelArgs(model, thinking),
    "--tools",
    tools.join(","),
  ];
  if (job.piSessionId || job.sessionFile) args.push("--session", job.sessionFile ?? job.piSessionId!);

  let tempSystemPath: string | undefined;
  const start = async () => {
    if (agent?.systemPrompt.trim()) {
      tempSystemPath = await writeTempPrompt(registry, job.id, agent.systemPrompt);
      args.push("--append-system-prompt", tempSystemPath);
    }
    args.push(prompt);

    appendLog(job, `Subagent ${job.id} started\nPrompt: ${prompt}\n\n`);
    const child = spawn("pi", args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    bindJsonSubagent(registry, ctx, job, child, options.reportCompletion ?? true, tempSystemPath);
  };
  void start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    updateJob(registry, job.id, { status: "error", lastError: message, pid: undefined });
    updateWidget(ctx, registry);
  });
  return job;
}

function bindJsonSubagent(
  registry: Registry,
  ctx: ExtensionContext,
  job: JobRecord,
  child: ChildProcess,
  reportCompletion: boolean,
  tempSystemPath: string | undefined,
) {
  updateJob(registry, job.id, { pid: child.pid, status: "running" });
  updateWidget(ctx, registry);

  const stream = createWriteStream(job.logPath, { flags: "a" });
  let stdoutBuffer = "";
  let stderr = "";
  let finalText = "";

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      stream.write(`${line}\n`);
      return;
    }
    if (!isRecord(event)) return;

    if (event.type === "session") {
      const sessionId = asString(event.id);
      const sessionFile = asString(event.sessionFile) ?? asString(event.file);
      updateJob(registry, job.id, { piSessionId: sessionId, sessionFile });
      stream.write(`[session ${sessionId ?? "unknown"}]\n`);
    }

    if (event.type === "tool_execution_start") {
      const tool = asString(event.toolName) ?? "tool";
      stream.write(`\n[tool start] ${tool}\n`);
    }

    if (event.type === "tool_execution_end") {
      const tool = asString(event.toolName) ?? "tool";
      const isError = event.isError === true ? " error" : "";
      stream.write(`[tool end] ${tool}${isError}\n`);
    }

    if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && typeof update.delta === "string") stream.write(update.delta);
    }

    if (event.type === "agent_end") {
      finalText = extractFinalAssistantText(event) ?? finalText;
      if (finalText) {
        mkdirSync(dirname(job.outputPath), { recursive: true });
        writeFileSync(job.outputPath, `${finalText}\n`, "utf8");
        updateJob(registry, job.id, { lastResult: finalText, outputPath: job.outputPath });
      }
    }
  };

  child.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer = readJsonLines(stdoutBuffer, data.toString(), processLine);
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
    stream.write(data.toString());
  });
  child.on("error", (error) => {
    updateJob(registry, job.id, { status: "error", pid: undefined, lastError: error.message });
    updateWidget(ctx, registry);
  });
  child.on("close", (code, signal) => {
    if (stdoutBuffer.trim()) processLine(stdoutBuffer);
    stream.end();
    if (tempSystemPath) void unlink(tempSystemPath).catch(() => undefined);
    const status: JobStatus = signal ? "aborted" : code === 0 ? "done" : "error";
    const current = updateJob(registry, job.id, {
      status,
      pid: undefined,
      exitCode: code ?? undefined,
      lastResult: finalText || job.lastResult,
      outputPath: job.outputPath,
      lastError: status === "error" ? stderr.trim() || `Subagent exited with code ${code}` : undefined,
    });
    updateWidget(ctx, registry);
    if (reportCompletion && current) reportJobCompletion(current);
  });
}

let reportJobCompletion: (job: JobRecord) => void = () => undefined;

async function stopJob(registry: Registry, idOrPid: string, force: boolean) {
  const job = findJob(registry, idOrPid);
  if (!job) return `Unknown job: ${idOrPid}`;
  if (!job.pid || !processAlive(job.pid)) {
    updateJob(registry, job.id, { status: job.status === "running" ? "error" : job.status, pid: undefined });
    return `${job.id} is not running`;
  }
  process.kill(job.pid, force ? "SIGKILL" : "SIGTERM");
  updateJob(registry, job.id, { status: "aborted" });
  return `${force ? "Killed" : "Terminated"} ${job.id} pid:${job.pid}`;
}

function renderJobMessage(job: JobRecord) {
  const header = `${formatJobLine(job)}\n`;
  const summary = getJobSummary(job, 4000);
  return `${header}\n${summary}\n\nFull output: ${job.outputPath}\nLog: ${job.logPath}`;
}

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const);

export default function (pi: ExtensionAPI) {
  let registry = loadRegistry("global");
  reconcileRunningJobs(registry);
  let latestCtx: ExtensionContext | undefined;

  reportJobCompletion = (job) => {
    if (latestCtx?.hasUI) latestCtx.ui.notify(`${job.id} ${job.status}`, job.status === "done" ? "info" : "warning");
    pi.sendMessage({
      customType: "task-notification",
      content: buildTaskNotificationContent(job),
      display: true,
      details: job,
    }, { deliverAs: "followUp", triggerTurn: true });
  };

  pi.registerMessageRenderer("task-notification", (message, options, theme) => {
    const job = isJobRecord(message.details) ? message.details : undefined;
    if (!job) return new Text(messageContentText(message.content), 0, 0);
    return new Text(renderTaskNotification(job, options.expanded, theme), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    registry = loadRegistry(getWorkspaceId(ctx));
    reconcileRunningJobs(registry);
    updateWidget(ctx, registry);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget("background-jobs", undefined);
  });

  pi.registerTool({
    name: "background_bash",
    label: "Background Bash",
    description: "Run a shell command as a managed background job. Returns a stable job ID; use job_status, job_output, and job_stop to manage it.",
    promptSnippet: "Run long-lived shell commands in the background as managed jobs.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run." }),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to current project." })),
      name: Type.Optional(Type.String({ description: "Optional human-readable job name." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const job = startBashJob(registry, ctx, params.command, cwd, params.name);
      return { content: [{ type: "text", text: `Started ${job.id} pid:${job.pid ?? "pending"}\nLog: ${job.logPath}` }], details: job };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("background_bash"))} ${theme.fg("dim", oneLine(args.command, 120))}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const job = isJobRecord(result.details) ? result.details : undefined;
      if (!job) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "Started background job", 0, 0);
      return new Text(`${formatJobLineStyled(job, theme)}\n${theme.fg("dim", `Full output: ${job.outputPath}`)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start a background Pi subagent. Returns a stable subagent/job ID immediately. Subagents are resumable by ID.",
    promptSnippet: "Start a background subagent for delegated work.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Task prompt for the subagent." }),
      agent: Type.Optional(Type.String({ description: "Agent definition name. Defaults to general if available." })),
      model: Type.Optional(Type.String({ description: "Pi model pattern/id, e.g. openai-codex/gpt-5.5." })),
      thinking: Type.Optional(ThinkingSchema),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist. Extension tools are always removed." })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to current project." })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion instead of returning immediately. Defaults to false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const agents = await discoverAgents(ctx.cwd);
      const requested = params.agent ?? "general";
      const agent = agents.find((candidate) => candidate.name === requested);
      const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      const job = startSubagentJob(registry, ctx, {
        prompt: params.prompt,
        agent,
        model: params.model,
        thinking: params.thinking,
        tools: params.tools,
        cwd,
        reportCompletion: params.wait ? false : true,
      });
      if (params.wait) {
        while (job.status === "starting" || job.status === "running") await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        return { content: [{ type: "text", text: renderJobMessage(job) }], details: job };
      }
      return { content: [{ type: "text", text: `Started subagent ${job.id} pid:${job.pid ?? "pending"}\nUse job_status/job_output/job_stop with id ${job.id}.` }], details: job };
    },
    renderCall(args, theme) {
      const agent = args.agent ?? "general";
      const mode = args.wait ? "foreground" : "background";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent_start"))} ${theme.fg("warning", agent)} ${theme.fg("dim", `(${mode})`)}\n${theme.fg("dim", oneLine(args.prompt, 180))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const job = isJobRecord(result.details) ? result.details : undefined;
      if (!job) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "Started subagent", 0, 0);
      return new Text(`${formatJobLineStyled(job, theme)}\n${theme.fg("dim", `Prompt: ${oneLine(job.prompt ?? "", 180)}`)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description: "Resume an existing subagent by stable ID with a new prompt. Creates a new process/PID bound to the same subagent ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Subagent ID, e.g. sa_001." }),
      prompt: Type.String({ description: "Follow-up prompt." }),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(ThinkingSchema),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion. Defaults to false." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const job = findJob(registry, params.id);
      if (!job) return { content: [{ type: "text", text: `Unknown subagent ${params.id}` }], details: { error: "unknown" } };
      if (job.kind !== "subagent") return { content: [{ type: "text", text: `${params.id} is not a subagent` }], details: job };
      if (!job.piSessionId && !job.sessionFile) return { content: [{ type: "text", text: `${params.id} has no captured Pi session yet` }], details: job };
      if (job.pid && processAlive(job.pid)) return { content: [{ type: "text", text: `${params.id} is already running pid:${job.pid}` }], details: job };
      const resumed = startSubagentJob(registry, ctx, {
        prompt: params.prompt,
        model: params.model ?? job.model,
        thinking: params.thinking ?? job.thinking,
        tools: job.tools,
        cwd: job.cwd,
        session: job.id,
        reportCompletion: params.wait ? false : true,
      });
      if (params.wait) {
        while (resumed.status === "starting" || resumed.status === "running") await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        return { content: [{ type: "text", text: renderJobMessage(resumed) }], details: resumed };
      }
      return { content: [{ type: "text", text: `Resumed ${resumed.id} pid:${resumed.pid ?? "pending"}` }], details: resumed };
    },
  });

  pi.registerTool({
    name: "job_status",
    label: "Job Status",
    description: "List background jobs or show one job by ID/PID.",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Job ID or PID. Omit to list recent jobs." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      reconcileRunningJobs(registry);
      updateWidget(ctx, registry);
      const jobs = params.id ? [findJob(registry, params.id)].filter((job): job is JobRecord => Boolean(job)) : registry.jobs.slice(-20);
      if (jobs.length === 0) return { content: [{ type: "text", text: params.id ? `Unknown job ${params.id}` : "No jobs" }], details: { jobs: [] } };
      return { content: [{ type: "text", text: jobs.map(formatJobLine).join("\n") }], details: { jobs } };
    },
  });

  pi.registerTool({
    name: "job_output",
    label: "Job Output",
    description: "Show result/log output for any background job or subagent.",
    parameters: Type.Object({
      id: Type.String({ description: "Job ID or PID." }),
      lines: Type.Optional(Type.Number({ description: "Log tail lines. Defaults to 80." })),
    }),
    async execute(_toolCallId, params) {
      const job = findJob(registry, params.id);
      if (!job) return { content: [{ type: "text", text: `Unknown job ${params.id}` }], details: { id: params.id, error: "unknown" } };
      const log = await tailFile(job.logPath, params.lines ?? 80);
      const result = job.lastResult ? `\n\nFinal result:\n${job.lastResult}` : "";
      const error = job.lastError ? `\n\nError:\n${job.lastError}` : "";
      return { content: [{ type: "text", text: `${formatJobLine(job)}\nLog: ${job.logPath}\n\n${log}${result}${error}` }], details: { id: job.id, error: "" } };
    },
  });

  pi.registerTool({
    name: "job_stop",
    label: "Stop Job",
    description: "Terminate any running background job/subagent by stable ID or PID.",
    parameters: Type.Object({
      id: Type.String({ description: "Job ID or PID." }),
      force: Type.Optional(Type.Boolean({ description: "Use SIGKILL instead of SIGTERM." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      latestCtx = ctx;
      const message = await stopJob(registry, params.id, params.force ?? false);
      updateWidget(ctx, registry);
      return { content: [{ type: "text", text: message }], details: { message } };
    },
  });

  pi.registerCommand("jobs", {
    description: "Manage background jobs: list | output <id> | stop <id>",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const [command, id] = args.trim().split(/\s+/, 2);
      if (!command || command === "list") {
        reconcileRunningJobs(registry);
        ctx.ui.notify((registry.jobs.slice(-20).map(formatJobLine).join("\n") || "No jobs"), "info");
      } else if (command === "output" && id) {
        const job = findJob(registry, id);
        if (!job) ctx.ui.notify(`Unknown job ${id}`, "warning");
        else ctx.ui.notify(await tailFile(job.logPath, 80), "info");
      } else if ((command === "stop" || command === "kill") && id) {
        ctx.ui.notify(await stopJob(registry, id, command === "kill"), "info");
      } else {
        ctx.ui.notify("Usage: /jobs list | /jobs output <id> | /jobs stop <id>", "warning");
      }
      updateWidget(ctx, registry);
    },
  });

  pi.registerCommand("sub", {
    description: "Manage subagents: agents | start <prompt> | resume <id> <prompt>",
    handler: async (args, ctx) => {
      latestCtx = ctx;
      const trimmed = args.trim();
      const agents = await discoverAgents(ctx.cwd);
      if (!trimmed || trimmed === "agents") {
        ctx.ui.notify(agents.map((agent) => `${agent.name} (${agent.source}) - ${agent.description}`).join("\n") || "No subagent definitions", "info");
        return;
      }
      if (trimmed.startsWith("resume ")) {
        const [, id, ...rest] = trimmed.split(/\s+/);
        if (!id || rest.length === 0) {
          ctx.ui.notify("Usage: /sub resume <id> <prompt>", "warning");
          return;
        }
        const job = findJob(registry, id);
        if (!job || job.kind !== "subagent") {
          ctx.ui.notify(`Unknown subagent ${id}`, "warning");
          return;
        }
        startSubagentJob(registry, ctx, { prompt: rest.join(" "), cwd: job.cwd, session: job.id, tools: job.tools, model: job.model, thinking: job.thinking });
        ctx.ui.notify(`Resumed ${job.id}`, "info");
        updateWidget(ctx, registry);
        return;
      }
      const prompt = trimmed.startsWith("start ") ? trimmed.slice("start ".length) : trimmed;
      const agent = agents.find((candidate) => candidate.name === "general");
      const job = startSubagentJob(registry, ctx, { prompt, agent, cwd: ctx.cwd });
      ctx.ui.notify(`Started ${job.id}`, "info");
      updateWidget(ctx, registry);
    },
  });
}
