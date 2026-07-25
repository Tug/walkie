// Canonical session model + cross-agent tool taxonomy, ported from continuo (yoavf/continuo,
// Swift → TS). Adapters parse a provider's native session file into a CanonicalSession; the
// transcript renderer emits a portable, tool-vocabulary-translated handoff for another agent.

export type ConvAgent = "claude" | "codex" | "opencode";
export type CanonicalRole = "user" | "assistant" | "developer" | "system" | "tool" | "summary";

export interface CanonicalEvent {
  sourceProvider: ConvAgent;
  role: CanonicalRole;
  kind: "message" | "tool_use" | "tool_result" | "question" | "answer";
  text: string;
  toolName?: string;
  toolOp?: string; // universal operation, e.g. "shell.exec"
}

export interface CanonicalSession {
  sourceProvider: ConvAgent;
  sourceSessionID: string;
  sourcePath: string;
  title: string;
  cwd: string;
  model?: string;
  events: CanonicalEvent[];
}

// Native tool name → universal operation, per provider.
const TO_OP: Record<ConvAgent, Record<string, string>> = {
  claude: {
    Bash: "shell.exec",
    BashOutput: "shell.exec",
    KillShell: "shell.exec",
    Read: "file.read",
    NotebookRead: "file.read",
    Write: "file.write",
    Edit: "file.edit",
    MultiEdit: "file.edit",
    NotebookEdit: "file.edit",
    Glob: "file.glob",
    Grep: "search.content",
    WebSearch: "web.search",
    WebFetch: "web.fetch",
    Task: "agent.spawn",
    Agent: "agent.spawn",
    TodoWrite: "plan.update",
    TaskCreate: "plan.update",
    TaskUpdate: "plan.update",
  },
  codex: {
    shell: "shell.exec",
    exec: "shell.exec", // the current Codex CLI names its shell tool `exec`
    exec_command: "shell.exec",
    local_shell: "shell.exec",
    "container.exec": "shell.exec",
    apply_patch: "file.edit",
    read_file: "file.read",
    view_image: "file.read",
    web_search: "web.search",
    update_plan: "plan.update",
  },
  opencode: {
    bash: "shell.exec",
    read: "file.read",
    write: "file.write",
    edit: "file.edit",
    patch: "file.edit",
    glob: "file.glob",
    list: "file.glob",
    grep: "search.content",
    websearch: "web.search",
    webfetch: "web.fetch",
    task: "agent.spawn",
    todowrite: "plan.update",
    todoread: "plan.update",
  },
};

// Universal operation → native tool name, per provider.
const FROM_OP: Record<ConvAgent, Record<string, string>> = {
  claude: {
    "shell.exec": "Bash",
    "file.read": "Read",
    "file.write": "Write",
    "file.edit": "Edit",
    "file.glob": "Glob",
    "search.content": "Grep",
    "web.search": "WebSearch",
    "web.fetch": "WebFetch",
    "agent.spawn": "Task",
    "plan.update": "TodoWrite",
  },
  codex: {
    "shell.exec": "exec_command",
    "file.edit": "apply_patch",
    "file.write": "apply_patch",
    "plan.update": "update_plan",
    "web.search": "web_search",
  },
  opencode: {
    "shell.exec": "bash",
    "file.read": "read",
    "file.write": "write",
    "file.edit": "edit",
    "file.glob": "glob",
    "search.content": "grep",
    "web.search": "websearch",
    "web.fetch": "webfetch",
    "agent.spawn": "task",
    "plan.update": "todowrite",
  },
};

export const universalOperation = (provider: ConvAgent, toolName: string): string | undefined =>
  TO_OP[provider][toolName];

/** The tool name a renderer should emit for the target: translated when it maps, else original. */
export function renderedToolName(event: CanonicalEvent, target: ConvAgent): string {
  const original = event.toolName ?? "tool";
  const op = event.toolOp ?? universalOperation(event.sourceProvider, original);
  const mapped = op ? FROM_OP[target][op] : undefined;
  return mapped ?? original;
}

// --- shared helpers ---

export function readJsonl(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip */
    }
  }
  return out;
}

export const bounded = (s: string, limit = 60_000): string =>
  s.length > limit ? `${s.slice(0, limit)}\n…[truncated]` : s;

// Instruction/permission scaffolding injected by harnesses, not real user intent.
export function looksInjected(text: string): boolean {
  return /^<(permission|system-reminder|command-|user-prompt|environment|local-command)/.test(
    text.trimStart(),
  );
}

export function cleanTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const c = text.replace(/\n/g, " ").trim();
  return c ? c.slice(0, 90) : undefined;
}
