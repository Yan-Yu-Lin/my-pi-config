import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createReadToolDefinition,
  getAgentDir,
  isReadToolResult,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type MemoryNote = {
  path: string;
  vault: string;
  stem: string;
  displayName: string;
  description?: string;
  outgoingTargets: string[];
  outgoing: string[];
};

type VaultIndex = {
  vault: string;
  notes: Map<string, MemoryNote>;
  byStem: Map<string, MemoryNote[]>;
  backlinks: Map<string, string[]>;
};

type MemoryState = {
  readFiles: string[];
  describedFiles: string[];
  shownRelations: string[];
  bootstrapInjected: boolean;
};

type RuntimeState = {
  workspaceId: string;
  workspaceDir: string;
  statePath: string;
  state: MemoryState;
};

const MEMORY_VAULTS = ["/Users/linyanyu/.claude/projects/-Users-linyanyu/memory"];
const VAULT_LABELS = new Map([[canonicalize(MEMORY_VAULTS[0]!), "Global"]]);
const BASE_DIR = join(getAgentDir(), "memory-wiki");
const MAX_SECTION_ITEMS = 16;

function sanitizeWorkspaceId(id: string) {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function canonicalize(path: string) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function stripLeadingAt(path: string) {
  return path.startsWith("@") ? path.slice(1) : path;
}

function normalizeInputPath(cwd: string, inputPath: string) {
  const stripped = stripLeadingAt(inputPath);
  return canonicalize(isAbsolute(stripped) ? stripped : resolve(cwd, stripped));
}

function emptyState(): MemoryState {
  return { readFiles: [], describedFiles: [], shownRelations: [], bootstrapInjected: false };
}

function statePaths(workspaceId: string) {
  const safe = sanitizeWorkspaceId(workspaceId || "global");
  const workspaceDir = join(BASE_DIR, "workspaces", safe);
  return {
    workspaceId: safe,
    workspaceDir,
    statePath: join(workspaceDir, "state.json"),
  };
}

function loadRuntime(ctx: ExtensionContext): RuntimeState {
  const paths = statePaths(ctx.sessionManager.getSessionId() || "global");
  mkdirSync(paths.workspaceDir, { recursive: true });
  if (!existsSync(paths.statePath)) return { ...paths, state: emptyState() };
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, "utf8")) as Partial<MemoryState>;
    return {
      ...paths,
      state: {
        readFiles: Array.isArray(parsed.readFiles) ? parsed.readFiles.filter((v): v is string => typeof v === "string") : [],
        describedFiles: Array.isArray(parsed.describedFiles) ? parsed.describedFiles.filter((v): v is string => typeof v === "string") : [],
        shownRelations: Array.isArray(parsed.shownRelations) ? parsed.shownRelations.filter((v): v is string => typeof v === "string") : [],
        bootstrapInjected: parsed.bootstrapInjected === true,
      },
    };
  } catch {
    return { ...paths, state: emptyState() };
  }
}

function saveRuntime(runtime: RuntimeState) {
  mkdirSync(dirname(runtime.statePath), { recursive: true });
  writeFileSync(runtime.statePath, `${JSON.stringify(runtime.state, null, 2)}\n`, "utf8");
}

function stateSet(values: string[]) {
  return new Set(values);
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function parseFrontmatter(text: string) {
  if (!text.startsWith("---")) return { frontmatter: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: text };
  const closeEnd = end + "\n---".length;
  return {
    frontmatter: text.slice(3, end).trim(),
    body: text.slice(closeEnd).replace(/^\s*\n/, ""),
  };
}

function unquoteYamlScalar(value: string) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function getDescription(text: string) {
  const { frontmatter } = parseFrontmatter(text);
  if (!frontmatter) return undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (!match) continue;
    const description = unquoteYamlScalar(match[1] ?? "");
    return description || undefined;
  }
  return undefined;
}

function stripFrontmatter(text: string) {
  return parseFrontmatter(text).body.trim();
}

function extractWikiLinks(text: string) {
  const seen = new Set<string>();
  const links: string[] = [];
  const regex = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const target = (match[1] ?? "").trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    links.push(target);
  }
  return links;
}

function collectMarkdownFiles(dir: string) {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile() && path.endsWith(".md")) files.push(canonicalize(path));
    }
  }
  return files.sort();
}

function displayName(vault: string, path: string) {
  const rel = relative(vault, path).replaceAll("\\", "/");
  return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
}

function resolveLink(index: VaultIndex, linkTarget: string) {
  const direct = canonicalize(join(index.vault, `${linkTarget}.md`));
  const directNote = index.notes.get(direct);
  if (directNote) return directNote.path;

  const stem = linkTarget.includes("/") ? linkTarget.split("/").at(-1)! : linkTarget;
  const matches = index.byStem.get(stem) ?? [];
  if (matches.length === 1) return matches[0]!.path;
  if (matches.length > 1) {
    return [...matches].sort((a, b) => a.displayName.length - b.displayName.length)[0]!.path;
  }
  return undefined;
}

function buildVaultIndex(vaultInput: string): VaultIndex | undefined {
  const vault = canonicalize(vaultInput);
  if (!existsSync(vault)) return undefined;

  const notes = new Map<string, MemoryNote>();
  const byStem = new Map<string, MemoryNote[]>();

  for (const path of collectMarkdownFiles(vault)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const note: MemoryNote = {
      path,
      vault,
      stem: path.split("/").at(-1)!.replace(/\.md$/, ""),
      displayName: displayName(vault, path),
      description: getDescription(text),
      outgoingTargets: extractWikiLinks(text),
      outgoing: [],
    };
    notes.set(note.path, note);
    const bucket = byStem.get(note.stem) ?? [];
    bucket.push(note);
    byStem.set(note.stem, bucket);
  }

  const index: VaultIndex = { vault, notes, byStem, backlinks: new Map() };

  for (const note of notes.values()) {
    for (const target of note.outgoingTargets) {
      const resolved = resolveLink(index, target);
      if (!resolved || resolved === note.path) continue;
      note.outgoing.push(resolved);
      const backlinks = index.backlinks.get(resolved) ?? [];
      if (!backlinks.includes(note.path)) backlinks.push(note.path);
      index.backlinks.set(resolved, backlinks);
    }
  }

  for (const backlinks of index.backlinks.values()) backlinks.sort();
  return index;
}

function buildIndexes() {
  return MEMORY_VAULTS.map(buildVaultIndex).filter((index): index is VaultIndex => Boolean(index));
}

function findIndexForPath(indexes: VaultIndex[], path: string) {
  const canonical = canonicalize(path);
  return indexes.find((index) => index.notes.has(canonical));
}

function findMemoryNote(indexes: VaultIndex[], cwd: string, inputPath: string) {
  const absolutePath = normalizeInputPath(cwd, inputPath);
  const index = findIndexForPath(indexes, absolutePath);
  const note = index?.notes.get(absolutePath);
  if (!index || !note) return undefined;
  return { index, note };
}

function vaultLabel(index: VaultIndex) {
  return VAULT_LABELS.get(index.vault) ?? displayName(index.vault, index.vault) ?? "Memory";
}

function formatNote(note: MemoryNote, includeDescription: boolean) {
  if (includeDescription && note.description) return `${note.displayName} — ${note.description}`;
  return note.displayName;
}

function limitedLines(lines: string[]) {
  if (lines.length <= MAX_SECTION_ITEMS) return lines;
  const omitted = lines.length - MAX_SECTION_ITEMS;
  return [...lines.slice(0, MAX_SECTION_ITEMS), `... ${omitted} more omitted`];
}

function relationKey(kind: "out" | "in", from: string, to: string) {
  return `${kind}:${from}->${to}`;
}

function buildReminder(index: VaultIndex, current: MemoryNote, runtime: RuntimeState) {
  const readFiles = stateSet(runtime.state.readFiles);
  const describedFiles = stateSet(runtime.state.describedFiles);
  const shownRelations = stateSet(runtime.state.shownRelations);
  const outboundLines: string[] = [];
  const inboundLines: string[] = [];

  addUnique(runtime.state.readFiles, current.path);
  readFiles.add(current.path);

  for (const targetPath of current.outgoing) {
    const target = index.notes.get(targetPath);
    if (!target) continue;
    const key = relationKey("out", current.path, target.path);
    if (shownRelations.has(key)) continue;
    if (readFiles.has(target.path) || describedFiles.has(target.path)) continue;
    if (!target.description) continue;

    outboundLines.push(formatNote(target, true));
    addUnique(runtime.state.describedFiles, target.path);
    addUnique(runtime.state.shownRelations, key);
    describedFiles.add(target.path);
    shownRelations.add(key);
  }

  for (const sourcePath of index.backlinks.get(current.path) ?? []) {
    const source = index.notes.get(sourcePath);
    if (!source) continue;
    const key = relationKey("in", source.path, current.path);
    if (shownRelations.has(key)) continue;

    const includeDescription = Boolean(source.description) && !readFiles.has(source.path) && !describedFiles.has(source.path);
    inboundLines.push(formatNote(source, includeDescription));
    if (includeDescription) {
      addUnique(runtime.state.describedFiles, source.path);
      describedFiles.add(source.path);
    }
    addUnique(runtime.state.shownRelations, key);
    shownRelations.add(key);
  }

  if (outboundLines.length === 0 && inboundLines.length === 0) return undefined;

  const lines = [`<memory-wiki-context file="${current.displayName}">`];
  if (outboundLines.length > 0) {
    lines.push("Outbound link descriptions not already shown:");
    lines.push(...limitedLines(outboundLines).map((line) => `- ${line}`));
  }
  if (inboundLines.length > 0) {
    if (outboundLines.length > 0) lines.push("");
    lines.push("Inbound backlinks (other memory files related to this file):");
    lines.push(...limitedLines(inboundLines).map((line) => `- ${line}`));
  }
  lines.push("</memory-wiki-context>");
  return lines.join("\n");
}

function buildBootstrap(indexes: VaultIndex[], runtime: RuntimeState) {
  const index = indexes.find((candidate) => candidate.notes.has(canonicalize(join(candidate.vault, "MEMORY.md"))));
  if (!index) return undefined;
  const memoryPath = canonicalize(join(index.vault, "MEMORY.md"));
  const memory = index.notes.get(memoryPath);
  if (!memory) return undefined;

  const parts: string[] = [];
  const rulesPath = canonicalize(join(index.vault, "_RULES.md"));
  if (existsSync(rulesPath)) {
    try {
      parts.push([`Memory wiki rules (${rulesPath}):`, stripFrontmatter(readFileSync(rulesPath, "utf8"))].join("\n\n"));
      addUnique(runtime.state.describedFiles, rulesPath);
    } catch {
      // ignore
    }
  }

  try {
    parts.push([`Memory entry file (${memoryPath}):`, stripFrontmatter(readFileSync(memoryPath, "utf8"))].join("\n\n"));
    addUnique(runtime.state.describedFiles, memoryPath);
  } catch {
    // ignore
  }

  // MEMORY.md is the entry page and already shows descriptions inline. Mark its resolved
  // linked notes as described so the reminder system does not repeat them immediately.
  for (const targetPath of memory.outgoing) {
    const target = index.notes.get(targetPath);
    if (target?.description) addUnique(runtime.state.describedFiles, target.path);
  }

  if (parts.length === 0) return undefined;
  runtime.state.bootstrapInjected = true;
  return parts.join("\n\n");
}

function appendContextToContent(content: (TextContent | ImageContent)[], context: string): (TextContent | ImageContent)[] {
  return [
    ...content,
    {
      type: "text",
      text: `\n\n${context}`,
    },
  ];
}

function textContent(content: string | (TextContent | ImageContent)[]) {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

function splitMemoryReminder(content: (TextContent | ImageContent)[]) {
  const textBlocks = content.filter((part): part is TextContent => part.type === "text");
  const combined = textBlocks.map((part) => part.text).join("\n");
  const match = /<memory-wiki-context[^>]*>([\s\S]*?)<\/memory-wiki-context>/.exec(combined);
  if (!match) {
    return {
      fileText: combined,
      reminder: undefined,
      outboundCount: 0,
      inboundCount: 0,
    };
  }

  const reminder = match[1]!.trim();
  const fileText = combined.replace(match[0], "").trimEnd();
  const outboundSection = /Outbound link descriptions not already shown:\n([\s\S]*?)(?:\n\nInbound backlinks|$)/.exec(reminder)?.[1] ?? "";
  const inboundSection = /Inbound backlinks \(other memory files related to this file\):\n([\s\S]*)$/.exec(reminder)?.[1] ?? "";
  const countItems = (section: string) => section.split(/\r?\n/).filter((line) => line.startsWith("- ")).length;

  return {
    fileText,
    reminder,
    outboundCount: countItems(outboundSection),
    inboundCount: countItems(inboundSection),
  };
}

function oneLine(text: string, max = 160) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function memorySummary(outboundCount: number, inboundCount: number) {
  const parts: string[] = [];
  if (outboundCount > 0) parts.push(`${outboundCount} outbound description${outboundCount === 1 ? "" : "s"}`);
  if (inboundCount > 0) parts.push(`${inboundCount} inbound backlink${inboundCount === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "no new reminders";
}

type CardBg = "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

function memoryCard(lines: string[], theme: ExtensionContext["ui"]["theme"], options: { top?: number; bottom?: number; bg?: CardBg } = {}): Component {
  const top = options.top ?? 0;
  const bottom = options.bottom ?? 0;
  const bg = options.bg ?? "customMessageBg";
  return {
    invalidate() {},
    render(width: number) {
      const paint = (line: string) => {
        const padding = Math.max(0, width - visibleWidth(line));
        return theme.bg(bg, line + " ".repeat(padding));
      };
      const rendered: string[] = [];
      for (let i = 0; i < top; i++) rendered.push(paint(""));
      const contentWidth = Math.max(1, width - 2);
      for (const line of lines) {
        if (line === "") {
          rendered.push(paint(""));
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(line, contentWidth)) {
          rendered.push(paint(` ${wrapped} `));
        }
      }
      for (let i = 0; i < bottom; i++) rendered.push(paint(""));
      return rendered;
    },
  };
}

function toolBg(context: { isPartial: boolean; isError: boolean }): CardBg {
  if (context.isPartial) return "toolPendingBg";
  return context.isError ? "toolErrorBg" : "toolSuccessBg";
}

export default function (pi: ExtensionAPI) {
  let indexes = buildIndexes();
  let runtime: RuntimeState | undefined;

  pi.registerMessageRenderer("memory-wiki-bootstrap", (message, { expanded }, theme) => {
    const content = textContent(message.content);
    const hint = keyHint("app.tools.expand", "to expand");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    if (!expanded) {
      box.addChild(new Text(`${theme.fg("customMessageLabel", theme.bold("memory wiki"))} ${theme.fg("muted", "bootstrap injected")} ${theme.fg("dim", `(${hint})`)}`, 0, 0));
      return box;
    }
    box.addChild(new Text(`${theme.fg("customMessageLabel", theme.bold("memory wiki bootstrap"))}\n\n${content}`, 0, 0));
    return box;
  });

  const baseRead = createReadToolDefinition(process.cwd());
  pi.registerTool({
    ...baseRead,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const read = createReadToolDefinition(ctx.cwd);
      return read.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const memory = findMemoryNote(indexes, context.cwd, args.path);
      if (!memory) {
        const parts = [theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", args.path)];
        if (args.offset || args.limit) {
          const opts: string[] = [];
          if (args.offset) opts.push(`offset=${args.offset}`);
          if (args.limit) opts.push(`limit=${args.limit}`);
          parts[0] += theme.fg("dim", ` (${opts.join(", ")})`);
        }
        return memoryCard(parts, theme, { top: 1, bg: toolBg(context) });
      }

      const label = `${vaultLabel(memory.index)}/${memory.note.displayName}.md`;
      const text = `${theme.fg("customMessageLabel", theme.bold("recall memory"))} ${theme.fg("accent", label)}`;
      return memoryCard([text], theme, { top: 1 });
    },
    renderResult(result, options, theme, context) {
      const memory = findMemoryNote(indexes, context.cwd, context.args.path);
      if (!memory) {
        if (options.isPartial) return memoryCard([theme.fg("warning", "Reading...")], theme, { bottom: 1, bg: "toolPendingBg" });
        const firstText = result.content.find((part) => part.type === "text")?.text;
        const firstImage = result.content.find((part) => part.type === "image");
        if (firstImage) return memoryCard([theme.fg("success", "Image loaded")], theme, { bottom: 1, bg: toolBg(context) });
        if (!firstText) return memoryCard([theme.fg("error", "No content")], theme, { bottom: 1, bg: toolBg(context) });
        const lineCount = firstText.split("\n").length;
        const lines = [theme.fg("success", `${lineCount} lines`)];
        if (options.expanded) lines.push("", ...firstText.split(/\r?\n/));
        return memoryCard(lines, theme, { bottom: 1, bg: toolBg(context) });
      }

      if (options.isPartial) return memoryCard([theme.fg("customMessageLabel", "[memory] recalling...")], theme, { bottom: 1 });
      if (context.isError) {
        const firstText = result.content.find((part) => part.type === "text")?.text ?? "read failed";
        return memoryCard([theme.fg("error", `[memory] ${oneLine(firstText)}`)], theme, { bottom: 1 });
      }

      const { fileText, reminder, outboundCount, inboundCount } = splitMemoryReminder(result.content);
      const summary = memorySummary(outboundCount, inboundCount);
      if (!options.expanded) {
        return memoryCard([theme.fg("customMessageLabel", `[reminder] ${summary}`)], theme, { bottom: 1 });
      }

      const lines = [
        theme.fg("customMessageLabel", theme.bold("recalled file content")),
        "",
        ...(fileText ? fileText.split(/\r?\n/) : [theme.fg("dim", "(no text content)")]),
        "",
        theme.fg("customMessageLabel", theme.bold("memory reminders")),
        theme.fg("customMessageLabel", `[reminder] ${summary}`),
        ...(reminder ? ["", ...reminder.split(/\r?\n/).map((line) => theme.fg("customMessageLabel", line))] : []),
      ];
      return memoryCard(lines, theme, { bottom: 1 });
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime = loadRuntime(ctx);
    indexes = buildIndexes();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    runtime ??= loadRuntime(ctx);
    if (runtime.state.bootstrapInjected) return;
    indexes = buildIndexes();
    const bootstrap = buildBootstrap(indexes, runtime);
    if (!bootstrap) return;
    saveRuntime(runtime);
    return {
      message: {
        customType: "memory-wiki-bootstrap",
        content: bootstrap,
        display: true,
      },
    };
  });

  pi.on("tool_result", async (event, ctx): Promise<{ content?: (TextContent | ImageContent)[] } | undefined> => {
    if (!isReadToolResult(event) || event.isError) return;
    const inputPath = typeof event.input.path === "string" ? event.input.path : undefined;
    if (!inputPath) return;

    runtime ??= loadRuntime(ctx);
    const absolutePath = normalizeInputPath(ctx.cwd, inputPath);
    const index = findIndexForPath(indexes, absolutePath);
    if (!index) return;
    const note = index.notes.get(absolutePath);
    if (!note) return;

    const reminder = buildReminder(index, note, runtime);
    saveRuntime(runtime);
    if (!reminder) return;

    return {
      content: appendContextToContent(event.content, reminder),
    };
  });

  pi.registerCommand("memory", {
    description: "Manage memory wiki state: state | reset | reindex",
    handler: async (args, ctx) => {
      runtime = loadRuntime(ctx);
      const command = args.trim() || "state";
      if (command === "reset") {
        runtime.state = emptyState();
        saveRuntime(runtime);
        ctx.ui.notify(`Memory wiki state reset: ${runtime.statePath}`, "info");
        return;
      }
      if (command === "reindex") {
        indexes = buildIndexes();
        ctx.ui.notify(`Memory wiki reindexed: ${indexes.reduce((sum, index) => sum + index.notes.size, 0)} notes`, "info");
        return;
      }
      ctx.ui.notify(
        [
          `Memory wiki state: ${runtime.statePath}`,
          `Read files: ${runtime.state.readFiles.length}`,
          `Descriptions shown: ${runtime.state.describedFiles.length}`,
          `Relations shown: ${runtime.state.shownRelations.length}`,
          `Bootstrap injected: ${runtime.state.bootstrapInjected}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
