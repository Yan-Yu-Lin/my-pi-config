import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  isReadToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
  let indexes = buildIndexes();
  let runtime: RuntimeState | undefined;

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
