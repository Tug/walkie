import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { agentOutput, fleetStatus, sendToAgent, spawnWorker, taskHistory } from "./fleet.js";
import { getHealth, startHealthPoller } from "./health.js";
import { ask, resetSession } from "./orchestrator.js";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.FLEET_TOKEN;
const CONTROL = process.env.FLEET_CONTROL !== "off"; // set FLEET_CONTROL=off for a read-only surface

if (!TOKEN || TOKEN.length < 24) {
  console.error("Refusing to start: set FLEET_TOKEN to a random secret of at least 24 chars.");
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
  }

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`walkie MCP on http://127.0.0.1:${PORT}/mcp (control lane: ${CONTROL ? "on" : "off"})`);
});
