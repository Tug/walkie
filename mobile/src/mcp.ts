export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: object;
}

/** Minimal MCP client over streamable HTTP, mirroring public/voice.html. */
export class McpClient {
  private sid: string | null = null;
  private id = 0;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sid ? { "mcp-session-id": this.sid } : {}),
    };
  }

  private async request(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (res.status === 401) throw new Error("Fleet token rejected");
    this.sid = res.headers.get("mcp-session-id") || this.sid;
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const reply = events.find((d) => d.id === id);
    if (reply?.error) throw new Error(reply.error.message);
    return reply?.result;
  }

  async init(): Promise<McpTool[]> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "walkie-mobile", version: "0.1" },
    });
    await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const { tools } = await this.request("tools/list", {});
    return tools;
  }

  async call(name: string, args: object): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args });
    return (result?.content || []).map((c: any) => c.text ?? "").join("\n") || "(empty result)";
  }
}
