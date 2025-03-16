// deno-lint-ignore-file no-explicit-any
import type { ToolAction } from "@mastra/core";
import { Agent, type ToolsetsInput } from "@mastra/core/agent";
import { LibSQLVector } from "@mastra/core/vector/libsql";

import type { ActorState } from "@deco/actors";
import { Actor } from "@deco/actors";
import { Memory } from "@mastra/memory";
import type {
  CoreMessage,
  GenerateTextResult,
  LanguageModelV1,
  StreamTextResult,
  TextStreamPart,
} from "ai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AIAgent,
  Tool,
} from "./types.ts";
import { FSStore } from "./memory/fs.ts";
import type {
  Configuration,
  MCPServer,
  TextModel,
} from "./tools/innate.ts";
import { createInnateTools } from "./tools/innate.ts";

import * as fs from "node:fs/promises";
import process from "node:process";
import { createLLM } from "./models/providers.ts";
import { mcpServerTools } from "./utils.ts";

const DEFAULT_ACCOUNT_ID = "c95fc4cec7fc52453228d9db170c372c";
const DEFAULT_GATEWAY_ID = "deco-ai";
const Keys = {

  NAME_KEY: "name",
  INSTRUCTIONS_KEY: "instructions",
  MODEL_KEY: "model",
  API_KEY_KEY: "apiKey",
}

export interface Env {
  ANTHROPIC_API_KEY: string;
  GATEWAY_ID: string;
  ACCOUNT_ID: string;
  LIBSQL_URL: string;
  LIBSQL_AUTH_TOKEN: string;
}

export interface DecoAgentMetadata {
  principal?: string;
}

const DEFAULT_MODEL = `anthropic:claude-3-7-sonnet-20250219`;

@Actor()
export class DecoAgent implements AIAgent {
  private _agent?: Agent;
  private _model?: TextModel;
  private _apiKey?: string;
  private toolSet: ToolsetsInput = {};
  private innateTools: ReturnType<typeof createInnateTools>;
  public metadata?: DecoAgentMetadata;

  constructor(public readonly state: ActorState, private env: any) {
    this.env = { ...process.env, ...this.env };
    this.innateTools = createInnateTools(this);
    this.state.blockConcurrencyWhile(async () => {
      await this.init();
    });
  }
  enrichMetadata(m: DecoAgentMetadata, req: Request): DecoAgentMetadata {
    return {
      ...m,
      principal: req.headers.get("x-principal-id") ?? crypto.randomUUID(),
    };
  }

  async setModel(model: TextModel) {
    await this.state.storage.put(Keys.MODEL_KEY, model);
    this._model = model;
  }

  async getModel(): Promise<TextModel> {
    return this._model ??= await this.state.storage.get<TextModel>(Keys.MODEL_KEY) ??
      DEFAULT_MODEL;
  }

  private async getKey(): Promise<string> {
    return this._apiKey ??= await this.state.storage.get<TextModel>(Keys.API_KEY_KEY);
  }

  async configure(config: Configuration): Promise<void> {
    await Promise.all([
      this.state.storage.put(Keys.NAME_KEY, config.name),
      this.state.storage.put(Keys.INSTRUCTIONS_KEY, config.instructions),
      this.state.storage.put(Keys.MODEL_KEY, config.model),
    ]);
    await this.init();
  }

  public async updateTools(): Promise<void> {
    const mcpServers: MCPServer[] =
      await this.innateTools.listConnectedMCPServers.execute!({ context: {} });
    const newToolSet: Record<
      string,
      Record<string, ToolAction<any, any, any>>
    > = {
      native: this.innateTools,
    };

    await Promise.all(mcpServers.map(async (server) => {
      newToolSet[server.name] = await mcpServerTools(server);
    }));

    this.toolSet = newToolSet;
  }

  private async init() {
    await this.updateTools();
    const name = await this.state.storage.get<string>(Keys.NAME_KEY);
    const instructions = await this.state.storage.get<string>(Keys.INSTRUCTIONS_KEY);
    if (!name || !instructions) {
      return;
    }

    const [model, apiKey] = await Promise.all([this.getModel(), this.getKey()]);
    this._agent = new Agent({
      memory: this.memory,
      name,
      instructions: `${instructions}\n\n
        You should use the following tools to help users to add MCPServers based on what they want to do,
        if they want to connect to their googledrive you should search for any MCPServer that meets their needs using: ${this.innateTools.listKnownMCPServers.id}
        if you want to take action based on already installed mcp servers you can use ${this.innateTools.listConnectedMCPServers.id}, you use use the same returned payload to create the MCP server using ${this.innateTools.connectToMCPServer.id}, ${this.innateTools.disconnectFromMCPServer.id}.
        You must tell users what you can do based on the tools available, whenever you think you cannot fulfill the user request, tell them that you cannot do that and try to find a MCPServer that can help them using the ${this.innateTools.listKnownMCPServers.id} tool.`,
      model: this.createLLM(apiKey ? { model, apiKey } : { model: model ?? DEFAULT_MODEL, apiKey: this.env?.ANTHROPIC_API_KEY }),
    });
  }

  private _memory?: Memory;
  private get memory(): Memory {
    return this._memory ??= new Memory({
      storage: new FSStore({
        basePath: `${Deno.cwd()}/.storage`,
        fs,
      }),
      vector: new LibSQLVector({
        connectionUrl: this.env?.LIBSQL_URL,
        authToken: this.env?.LIBSQL_AUTH_TOKEN,
      }),
    });
  }

  private createLLM({ model, apiKey }: { model: string, apiKey: string }): LanguageModelV1 {
    const [provider, providerModel] = model.split(":");
    const accountId = this.env?.ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;
    const gatewayId = this.env?.GATEWAY_ID ?? DEFAULT_GATEWAY_ID;
    return createLLM({
      apiKey,
      accountId,
      gatewayId,
      provider
    })(providerModel);
  }

  private get anonymous(): Agent {
    return new Agent({
      memory: this.memory,
      name: "Anonymous",
      instructions:
        "You should help users to configure yourself. Users should give you your name, instructions, and optionally a model (leave it default if the user don't mention it, don't force they to set it). This is your only task for now. Tell the user that you are ready to configure yourself when you have all the information.",
      model: this.createLLM({ model: DEFAULT_MODEL, apiKey: this.env?.ANTHROPIC_API_KEY }),
      tools: this.innateTools,
    });
  }
  private get agent(): Agent {
    return this._agent ?? this.anonymous;
  }

  toolset(): Record<string, Record<string, Tool>> {
    const mtoolset: Record<string, Record<string, Tool>> = {};
    for (const [setName, toolset] of Object.entries(this.toolSet)) {
      for (const [toolName, tool] of Object.entries(toolset)) {
        mtoolset[setName] = mtoolset[setName] ?? {};
        mtoolset[setName][toolName] = {
          name: toolName,
          description: tool.description,
          inputSchema: tool.inputSchema ? zodToJsonSchema(tool.inputSchema) : {
            type: "object",
            properties: {},
          },
        };
      }
    }
    return mtoolset;
  }

  async configuration(): Promise<Configuration> {
    return {
      name: this.agent.name,
      instructions: this.agent.instructions,
      model: await this.getModel(),
    };
  }

  async callTool(tool: string, input: any): Promise<any> {
    const [set, name] = tool.split(":");
    const toolset = this.toolSet[set];

    return await toolset[name]?.execute?.({ context: input }, {
      toolCallId: crypto.randomUUID(),
      messages: [],
    });
  }

  private get channel(): { threadId: string; resourceId: string } {
    const resource = this.metadata?.principal ?? crypto.randomUUID();
    const threadId = `${this.state.id}-${resource}`; // private thread with the given resource
    return {
      threadId,
      resourceId: resource,
    };
  }

  generate(
    payload: string | string[] | CoreMessage[],
  ): Promise<GenerateTextResult<any, any>> {
    return this.agent.generate(payload, {
      ...this.channel,
      toolsets: this.toolSet,
    });
  }

  async *stream(
    payload: string | string[] | CoreMessage[],
  ): AsyncIterableIterator<TextStreamPart<any>, StreamTextResult<any, any>> {
    const response = await this.agent.stream(payload, {
      ...this.channel,
      toolsets: this.toolSet,
    });
    // check this
    yield* response.fullStream;
    return response;
  }
}
