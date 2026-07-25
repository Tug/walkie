// Suggests which agent + model to use for a task. Two inputs: a seed heuristic (below) and the
// project's own memory (what actually worked here). The suggestion is advisory — the user or
// orchestrator decides and can override.
//
// walkie-specific economics: claude runs on the user's subscription (no marginal cost), while
// opencode/codex bill a provider API key. So the default leans claude unless a task profile
// clearly favors another agent's strength or memory says otherwise. The Kimi K3 signal (great
// at long-horizon terminal/agentic, security, dev tooling; weaker on web/dataviz/breadth;
// token-hungry) informs when opencode+kimi is worth the API spend.

import type { RunRecord } from "./memory.js";

export interface AgentSuggestion {
  agent: "claude" | "opencode" | "codex";
  model?: string;
  rationale: string;
}

const KIMI = "moonshot/kimi-k3";

// Task-profile keywords → when a non-claude agent's strength is worth the API cost.
const KIMI_STRENGTHS =
  /\b(refactor|migrat|script|automat|terminal|shell|cli|security|crypto|reverse|debug|rust|\.rs\b|golang|\.go\b)/i;
const CLAUDE_STRENGTHS =
  /\b(ui|frontend|react|css|design|dataviz|chart|visuali|python|java\b|c\+\+|breadth|docs|architecture)/i;

function heuristic(task: string): AgentSuggestion {
  if (CLAUDE_STRENGTHS.test(task)) {
    return {
      agent: "claude",
      rationale: "web/breadth/design task — claude's strength, and it's on your subscription (no API cost).",
    };
  }
  if (KIMI_STRENGTHS.test(task)) {
    return {
      agent: "opencode",
      model: KIMI,
      rationale:
        "long-horizon terminal/agentic or systems task — opencode+Kimi K3 excels here (costs provider API).",
    };
  }
  return {
    agent: "claude",
    rationale: "no strong signal — defaulting to claude (runs on your subscription, no marginal cost).",
  };
}

const sharedTerms = (a: string, b: string): number => {
  const A = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  return b
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3 && A.has(w)).length;
};

const wentWell = (r: RunRecord): boolean =>
  /(pr|opened|merged|green|success|done|passed)/i.test(`${r.outcome ?? ""} ${r.retro?.right ?? ""}`) &&
  !/(abandon|fail|broke|error|revert)/i.test(`${r.outcome ?? ""} ${r.retro?.wrong ?? ""}`);

/** Suggest an agent+model for a task, preferring what worked on similar tasks in this repo. */
export function suggestAgent(task: string, recent: RunRecord[]): AgentSuggestion {
  // Memory first: among similar past runs that went well, pick the most common agent+model.
  const similar = recent.filter((r) => wentWell(r) && sharedTerms(task, r.task) >= 2).slice(0, 20);
  if (similar.length > 0) {
    const tally = new Map<string, { agent: AgentSuggestion["agent"]; model?: string; n: number }>();
    for (const r of similar) {
      const key = `${r.agent}:${r.model ?? ""}`;
      const cur = tally.get(key) ?? { agent: r.agent as AgentSuggestion["agent"], model: r.model, n: 0 };
      cur.n += 1;
      tally.set(key, cur);
    }
    const best = [...tally.values()].sort((a, b) => b.n - a.n)[0];
    return {
      agent: best.agent,
      model: best.model,
      rationale: `memory: ${best.agent}${best.model ? ` (${best.model})` : ""} worked on ${best.n} similar task(s) in this repo.`,
    };
  }
  return heuristic(task);
}
