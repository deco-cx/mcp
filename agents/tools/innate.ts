import { z } from "zod";
import { createTool } from "@mastra/core";
import type { DecoAgent } from "../agent.ts";

const TextModelSchema = z.enum([
  "openai:gpt-4-turbo",
  "openai:gpt-4",
  "openai:gpt-4o",
  "openai:gpt-4o-mini",
  "openai:o1-preview",
  "openai:o1-mini",
  "openai:o1",
  "openai:o3-mini",
  "openai:gpt-4o-audio-preview",
  "openai:gpt-4.5-preview",
  "anthropic:claude-3-5-sonnet-latest",
  "anthropic:claude-3-7-sonnet-latest",
  "anthropic:claude-3-5-haiku-20241022",
  "google:gemini-2.0-flash",
  "google:gemini-2.0-flash-lite-preview-02-05",
  "google:gemini-1.5-pro-latest",
  "google:gemini-1.5-flash",
  "mistral:pixtral-large-latest",
  "mistral:mistral-large-latest",
  "mistral:mistral-small-latest",
  "mistral:pixtral-12b-2409",
  "deepseek:deepseek-chat",
  "deepseek:deepseek-reasoner",
  "perplexity:sonar-pro",
  "perplexity:sonar",
  "xai:grok-2-latest",
  "xai:grok-2-vision-latest",
  "perplexity:llama-3.1-sonar-small-128k-online",
  "perplexity:llama-3.1-sonar-large-128k-online",
  "perplexity:llama-3.1-sonar-huge-128k-online",
  "pinecone:*",
  "test:test-model",
])


const SSEConnectionSchema = z.object({
  type: z.literal("SSE"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

const WebsocketConnectionSchema = z.object({
  type: z.literal("Websocket"),
  url: z.string().url(),
});

const StdioConnectionSchema = z.object({
  type: z.literal("Stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
});

const DecoConnectionSchema = z.object({
  type: z.literal("Deco"),
  tenant: z.string(),
});

const FilterPatternSchema = z.object({
  startsWith: z.string(),
}).or(z.object({
  endsWith: z.string(),
})).or(z.object({
  matches: z.string(),
}));

export const MCPServerSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  connection: z.discriminatedUnion("type", [
    SSEConnectionSchema,
    WebsocketConnectionSchema,
    StdioConnectionSchema,
    DecoConnectionSchema,
  ]),
  filters: z.object({
    include: z.array(z.string().or(FilterPatternSchema)).optional(),
    exclude: z.array(z.string().or(FilterPatternSchema)).optional(),
  }).optional(),
});

export const ConnectToMCPServerInputSchema = MCPServerSchema;
export const ConnectToMCPServerOutputSchema = z.void();

export const DisconnectFromMCPServerInputSchema = z.object({
  name: z.string(),
});
export const DisconnectFromMCPServerOutputSchema = z.void();

export const ListConnectedMCPServersInputSchema = z.void();
export const ListConnectedMCPServersOutputSchema = z.array(MCPServerSchema);

export type TextModel = z.infer<typeof TextModelSchema>;
export type MCPServer = z.infer<typeof MCPServerSchema>;
export type DisconnectFromMCPServerInput = z.infer<
  typeof DisconnectFromMCPServerInputSchema
>;
export const ConfigurationSchema = z.object({
  name: z.string(),
  instructions: z.string(),
  model: TextModelSchema.optional(),
});

export const ConfigureInputSchema = ConfigurationSchema;
export const ConfigureOutputSchema = z.void();

export type Configuration = z.infer<typeof ConfigurationSchema>;

type ToolFactory = (agent: DecoAgent) => ReturnType<typeof createTool>;

const Keys = {
  MCP_SERVERS_KEY: "mcpServers",
}
function listConnectedMCPServers(agent: DecoAgent) {
  return createTool({
    id: listConnectedMCPServers.name,
    description: "List all connected MCPServers",
    execute: async () => {
      return await agent.state.storage.get<MCPServer[]>(Keys.MCP_SERVERS_KEY) ?? [];
    },
  });
}

function listKnownMCPServers() {
  return createTool({
    id: listKnownMCPServers.name,
    description: "List all known MCPServers",
    execute: () => {
      return Promise.resolve([
        {
          name: "deco-drive",
          connection: {
            type: "Deco",
            tenant: "localhost--mcp",
          },
          filters: {
            include: [{
              startsWith: "drive_",
            }],
          },
          description: "Tools for googledrive",
        },
        {
          name: "deco-resend",
          connection: {
            type: "Deco",
            tenant: "localhost--mcp",
          },
          filters: {
            include: [{
              startsWith: "resend_",
            }],
          },
          description: "Tools for e-mails using resend API",
        },
      ]);
    },
  });
}

function connectToMCPServer(agent: DecoAgent) {
  return createTool({
    id: connectToMCPServer.name,
    description: "Connect to a MCPServer",
    inputSchema: MCPServerSchema,
    execute: async ({ context }) => {
      const mcpServers = await agent.state.storage.get<MCPServer[]>(
        Keys.MCP_SERVERS_KEY,
      ) ?? [];

      // Replace existing server with the same name or add new one
      const index = mcpServers.findIndex((mcpServer) =>
        mcpServer.name === context.name
      );
      if (index !== -1) {
        mcpServers[index] = context;
      } else {
        mcpServers.push(context);
      }

      await agent.state.storage.put(Keys.MCP_SERVERS_KEY, mcpServers);
      await agent.updateTools();
    },
  });
}
function disconnectFromMCPServer(agent: DecoAgent) {
  return createTool({
    id: disconnectFromMCPServer.name,
    description: "Disconnect from a MCPServer",
    inputSchema: DisconnectFromMCPServerInputSchema,
    execute: async ({ context }) => {
      const mcpServers = await agent.state.storage.get<MCPServer[]>(
        Keys.MCP_SERVERS_KEY,
      );
      if (!mcpServers) {
        return;
      }
      const index = mcpServers.findIndex((mcpServer) => context.name === mcpServer.name);
      if (index !== -1) {
        mcpServers.splice(index, 1);
        await agent.state.storage.put(Keys.MCP_SERVERS_KEY, mcpServers);
        // Remove tools for this server
        await agent.updateTools();
      }
    },
  });
}
function configure(agent: DecoAgent) {
  return createTool({
    id: configure.name,
    description: "Configure the agent",
    inputSchema: ConfigurationSchema,
    execute: async ({ context }) => {
      await agent.configure(context);
    },
  });
}

function configuration(agent: DecoAgent) {
  return createTool({
    id: configuration.name,
    description: "Configure the agent",
    inputSchema: ConfigurationSchema,
    execute: async () => {
      return await agent.configuration();
    },
  });
}
const toolsFactory = {
  configuration, configure, listConnectedMCPServers, listKnownMCPServers, connectToMCPServer, disconnectFromMCPServer
} as const;

/**
 * Create a set of tools that are available to the agent
 * @param agent - The agent to create the tools for
 * @returns A record of tools
 */
export function createInnateTools(agent: DecoAgent) {
  const tools: Record<keyof typeof toolsFactory, ReturnType<typeof createTool>> = {} as Record<keyof typeof toolsFactory, ReturnType<typeof createTool>>;

  for (const create of Object.values(toolsFactory)) {
    const tool = create(agent);
    tools[tool.id as keyof typeof tools] = tool;
  }
  return tools;
};
createInnateTools satisfies (agent: DecoAgent) => Record<string, ReturnType<typeof createTool>>;