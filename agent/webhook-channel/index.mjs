import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "http";

const PORT = 9092;

const mcp = new Server(
  { name: "webhook-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
      logging: {},
    },
    instructions: `You are receiving task requests via webhook.

When a task arrives:
1. Read the task description
2. Apply the task delegation rules from CLAUDE.md
3. Execute the task if within autonomous scope
4. If the task requires approval, draft the output and notify via Slack

Response format: Lead with the answer, keep it short.`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a response back through the webhook channel",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "reply") {
    console.error(
      `[webhook-channel] Reply: ${request.params.arguments.message}`
    );
    return { content: [{ type: "text", text: "Reply acknowledged" }] };
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
      const task = payload.task || payload.message || JSON.stringify(payload);

      console.error(`[webhook-channel] Task received: ${String(task).slice(0, 200)}`);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `Task request received:\n\n${task}`,
          meta: { source: "webhook" },
        },
      });

      res.writeHead(200);
      res.end("OK");
    } catch (err) {
      console.error(`[webhook-channel] Error: ${err.message}`);
      res.writeHead(500);
      res.end("Error");
    }
  });
});

httpServer.listen(PORT, () => {
  console.error(`[webhook-channel] HTTP server listening on port ${PORT}`);
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
