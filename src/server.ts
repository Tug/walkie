import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { authMiddleware, loadAuthConfig, registerAuthRoutes } from "./auth.js";
import { agentOutput, fleetStatus, killWorker, sendToAgent, spawnWorker, taskHistory } from "./fleet.js";
import { getHealth, startHealthPoller } from "./health.js";
import { ask, resetSession } from "./orchestrator.js";
import { CONSENT_PROMPT_EN, consentValid } from "./risk.js";
import { voiceRouter } from "./voice.js";

const PORT = Number(process.env.PORT ?? 8787);
// Default loopback-only. Set HOST=0.0.0.0 to accept LAN clients (e.g. the mobile app
// on your wifi); auth is then the only gate, so mind the network you're on.
const HOST = process.env.HOST ?? "127.0.0.1";
const CONTROL = process.env.FLEET_CONTROL !== "off"; // set FLEET_CONTROL=off for a read-only surface

let authConfig: ReturnType<typeof loadAuthConfig>;
try {
  authConfig = loadAuthConfig(process.env);
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "walkie", version: "0.2.0" });

  server.registerTool(
    "fleet_status",
    {
      title: "Fleet status",
      description:
        "Snapshot of the local agent fleet: daemon state, repos, and each agent with live health " +
        "(working / idle / blocked+reason / dead, with since timestamps). Cheap and deterministic.",
      inputSchema: {},
    },
    async () => {
      const status = await fleetStatus();
      const enriched = {
        ...status,
        repos: status.repos.map((r) => ({
          ...r,
          agents: r.agents.map((a) => ({
            ...a,
            health: getHealth(`${r.tmux_session ?? `mc-${r.name}`}:${a.tmux_window ?? a.name}`),
          })),
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
    },
  );

  server.registerTool(
    "agent_output",
    {
      title: "Agent output",
      description: "Raw tail of one agent's terminal (tmux capture). Prefer ask_orchestrator for summaries.",
      inputSchema: {
        repo: z.string().describe("Repo name as shown in fleet_status"),
        agent: z.string().describe("Agent name, e.g. supervisor or clever-fox"),
        lines: z.number().int().min(10).max(2000).default(100),
      },
    },
    async ({ repo, agent, lines }) => ({
      content: [{ type: "text", text: await agentOutput(repo, agent, lines) }],
    }),
  );

  server.registerTool(
    "task_history",
    {
      title: "Task history",
      description: "Completed and past worker tasks for a repo.",
      inputSchema: { repo: z.string() },
    },
    async ({ repo }) => ({ content: [{ type: "text", text: await taskHistory(repo) }] }),
  );

  server.registerTool(
    "ask_orchestrator",
    {
      title: "Ask the orchestrator",
      description:
        "Ask the resident orchestrator agent (persistent, runs on the fleet machine) anything about the fleet: status digests, what changed, whether PRs need attention. It inspects logs itself and answers in short spoken-friendly prose. This is the preferred tool for any open question.",
      inputSchema: { question: z.string() },
    },
    async ({ question }) => ({ content: [{ type: "text", text: await ask(question) }] }),
  );

  if (CONTROL) {
    server.registerTool(
      "spawn_worker",
      {
        title: "Spawn worker",
        description:
          "Create a new worker agent on a repo with a one-task mission. It will open a PR when done.",
        inputSchema: { repo: z.string(), task: z.string().min(10) },
      },
      async ({ repo, task }) => ({ content: [{ type: "text", text: await spawnWorker(repo, task) }] }),
    );

    server.registerTool(
      "send_to_agent",
      {
        title: "Message an agent",
        description: "Type a message into a running agent's session (tmux). Use for steering or unblocking.",
        inputSchema: { repo: z.string(), agent: z.string(), text: z.string() },
      },
      async ({ repo, agent, text }) => ({
        content: [{ type: "text", text: await sendToAgent(repo, agent, text) }],
      }),
    );

    server.registerTool(
      "reset_orchestrator",
      {
        title: "Reset orchestrator session",
        description: "Start the resident orchestrator on a fresh conversation (keeps no chat history).",
        inputSchema: {},
      },
      async () => ({ content: [{ type: "text", text: await resetSession() }] }),
    );

    server.registerTool(
      "kill_worker",
      {
        title: "Remove a worker (destructive)",
        description:
          "DESTRUCTIVE: permanently removes a worker agent and its git worktree; any uncommitted " +
          "work is lost. Requires explicit spoken consent: ask the user to say exactly " +
          `"${CONSENT_PROMPT_EN}", then pass their words verbatim in the consent field.`,
        inputSchema: {
          agent: z.string().describe("Worker name to remove"),
          consent: z
            .string()
            .describe(`The user's verbatim spoken consent phrase, e.g. "${CONSENT_PROMPT_EN}"`),
        },
      },
      async ({ agent, consent }) => {
        if (!consentValid(consent)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Refused: removing ${agent} is destructive and needs explicit consent. ` +
                  `Tell the user it will permanently delete the worker and its uncommitted work, ` +
                  `then ask them to say exactly: "${CONSENT_PROMPT_EN}". Call again with that verbatim consent.`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: await killWorker(agent) }] };
      },
    );
  }

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS: lets the Expo web app (dev server on another port) call the MCP and voice
// endpoints. Auth stays bearer-token; no cookies involved.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

registerAuthRoutes(app, authConfig);

const requireAuth = authMiddleware(authConfig);
app.use((req, res, next) => {
  // Static shells hold no secrets; they authenticate in-page. /auth/* is public by nature.
  const isStaticShell = req.method === "GET" && (req.path === "/voice" || req.path.startsWith("/app"));
  if (req.path === "/healthz" || isStaticShell || req.path.startsWith("/auth/")) return next();
  return requireAuth(req, res, next);
});

// Expo web export (mobile/dist), when built: bun run --cwd mobile export:web
const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "mobile", "dist");
app.use("/app", express.static(WEB_DIST));

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(voiceRouter);

// Voice clients POST conversation events here (JSONL on disk) so sessions can be
// replayed and troubleshooted later, e.g. from a Claude Code session on this machine.
const LOG_DIR = join(homedir(), ".fleet-orchestrator", "voice-logs");
app.post("/voice/log", async (req, res) => {
  const { session, events } = req.body ?? {};
  if (typeof session !== "string" || !Array.isArray(events)) {
    return res.status(400).json({ error: "expected {session, events[]}" });
  }
  await mkdir(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const lines = events
    .slice(0, 100)
    .map((e) => JSON.stringify({ at: new Date().toISOString(), session, ...e }))
    .join("\n");
  await appendFile(join(LOG_DIR, `${day}.jsonl`), `${lines}\n`);
  res.json({ ok: true });
});

// Stateful streamable HTTP MCP: one transport per MCP session.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.all("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  let transport = sid ? transports.get(sid) : undefined;

  if (!transport) {
    if (req.method !== "POST") return res.status(400).json({ error: "no session" });
    const created = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, created);
      },
    });
    created.onclose = () => {
      if (created.sessionId) transports.delete(created.sessionId);
    };
    await buildServer().connect(created);
    transport = created;
  }

  await transport.handleRequest(req, res, req.body);
});

startHealthPoller();

app.listen(PORT, HOST, () => {
  console.log(
    `walkie MCP on http://${HOST}:${PORT}/mcp (auth: ${authConfig.mode}, control lane: ${CONTROL ? "on" : "off"})`,
  );
});
