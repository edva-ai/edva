import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";

const PORT = 9093;

const mcp = new Server(
  { name: "dispatch-bridge", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: `You are receiving notifications from the background agent (email triage, scheduled tasks).

When a notification arrives:
1. Read the content — it's a summary meant for the user
2. Present it clearly and concisely
3. If it says "action needed", ask the user what they'd like to do

These are informational push messages. Keep responses short — the user is on their phone.`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "acknowledge",
      description: "Acknowledge a notification",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "acknowledge") {
    console.error(
      `[dispatch-bridge] Ack: ${request.params.arguments.message}`
    );
    return { content: [{ type: "text", text: "Acknowledged" }] };
  }
  return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
});

const httpServer = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      const message = payload.message || payload.task || JSON.stringify(payload);
      const source = payload.source || "agent";

      console.error(`[dispatch-bridge] Notification from ${source}: ${String(message).slice(0, 200)}`);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: message,
          meta: { source },
        },
      });

      res.writeHead(200);
      res.end("OK");
    } catch (err) {
      console.error(`[dispatch-bridge] Error: ${err.message}`);
      res.writeHead(500);
      res.end("Error");
    }
  });
});

httpServer.listen(PORT, () => {
  console.error(`[dispatch-bridge] Listening on port ${PORT}`);
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
