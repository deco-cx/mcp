// deno-lint-ignore-file no-explicit-any
import { getTools } from "@deco/mcp";
import { createTool, type ToolAction } from "@mastra/core";
import { jsonSchemaToModel } from "@mastra/core/utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MCPServer } from "./tools.ts";

const _mcpServerTools = async (
  mcpServer: MCPServer,
): Promise<Record<string, ToolAction<any, any, any>>> => {
  let transport: Transport | null = null;

  if (mcpServer.connection.type === "SSE") {
    transport = new SSEClientTransport(new URL(mcpServer.connection.url));
  } else if (mcpServer.connection.type === "Websocket") {
    transport = new WebSocketClientTransport(new URL(mcpServer.connection.url));
  } else if (mcpServer.connection.type === "Stdio") {
    transport = new StdioClientTransport(mcpServer.connection);
  }

  if (!transport) {
    return {};
  }

  const client = new Client(
    {
      name: mcpServer.name,
      version: "1.0.0",
    },
    {
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
    },
  );

  try {
    await client.connect(transport);
    const { tools: _mtools } = await client.listTools();
    const mtools: Record<string, ToolAction<any, any, any>> = Object
      .fromEntries(
        _mtools.map((tool: typeof _mtools[number]) => [
          tool.name,
          createTool({
            id: tool.name,
            description: tool.description! ?? "",
            inputSchema: jsonSchemaToModel(tool.inputSchema),
            execute: async ({ context }) => {
              return await client.callTool({
                name: tool.name,
                arguments: context,
              });
            },
          }),
        ]),
      );

    return mtools;
  } catch (err) {
    console.log("error when connecting to", mcpServer.name, err);
    return {};
  }
};

export const fetchMeta = async (baseUrl: string) => {
  const response = await fetch(new URL("/live/_meta", baseUrl));
  const meta: { schema: any } = await response.json();
  return meta;
};

const siteTools = async (
  site: string,
): Promise<Record<string, ToolAction<any, any, any>>> => {
  const baseUrl = `https://${site}.deco.site`;
  const meta = await fetchMeta(baseUrl);

  const tools = getTools(new Map(), meta.schema);

  const createdTools: Record<string, ReturnType<typeof createTool>> = {};
  for (const tool of tools) {
    try {
      const createdTool = createTool({
        id: tool.name,
        description: tool.description,
        inputSchema: jsonSchemaToModel(tool.inputSchema),
        outputSchema: jsonSchemaToModel(
          tool.outputSchema ?? {
            type: "object",
            additionalProperties: true,
          },
        ),
        execute: async ({ context }) => {
          const response = await fetch(
            new URL(`/live/invoke/${tool.resolveType}`, baseUrl),
            {
              method: "POST",
              body: typeof context === "string"
                ? context
                : JSON.stringify(context),
              headers: {
                "content-type": "application/json",
              },
            },
          );
          return await response.json();
        },
      });

      createdTools[tool.name] = createdTool;
    } catch (err) {
      console.error(err);
      // ignore
    }
  }
  return createdTools;
};

const matchesPattern = (
  toolName: string,
  pattern: string | {
    startsWith?: string;
    endsWith?: string;
    matches?: string;
  },
) => {
  if (typeof pattern === "string") {
    return toolName === pattern;
  }

  if ("startsWith" in pattern && pattern.startsWith) {
    return toolName.startsWith(pattern.startsWith);
  }

  if ("endsWith" in pattern && pattern.endsWith) {
    return toolName.endsWith(pattern.endsWith);
  }

  if ("matches" in pattern && pattern.matches) {
    // Convert glob pattern to RegExp
    const regexPattern = pattern.matches
      .replace(/\./g, "\\.")
      .replace(/\*/g, ".*");
    return new RegExp(`^${regexPattern}$`).test(toolName);
  }

  return false;
};

export const mcpServerTools = async (
  mcpServer: MCPServer,
): Promise<Record<string, ToolAction<any, any, any>>> => {
  const mtools = mcpServer.connection.type === "Deco"
    ? await siteTools(mcpServer.connection.tenant)
    : await _mcpServerTools(mcpServer);

  let selectedTools: Record<string, ToolAction> = {};

  const include = mcpServer.filters?.include ?? [];
  if (include.length > 0) {
    // Check each tool against include patterns
    for (const toolName of Object.keys(mtools)) {
      if (include.some((pattern) => matchesPattern(toolName, pattern))) {
        selectedTools[toolName] = mtools[toolName];
      }
    }
  } else {
    selectedTools = mtools;
  }

  const exclude = mcpServer.filters?.exclude ?? [];
  if (exclude.length > 0) {
    // Remove tools that match exclude patterns
    for (const toolName of Object.keys(selectedTools)) {
      if (exclude.some((pattern) => matchesPattern(toolName, pattern))) {
        delete selectedTools[toolName];
      }
    }
  }

  return selectedTools;
};
