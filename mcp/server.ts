import {
  type AppManifest,
  context,
  type Deco,
  type DecoMiddlewareContext,
  type JSONSchema7,
  type Schemas,
} from "@deco/deco";
import type { Context, MiddlewareHandler, Next } from "@hono/hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { HttpServerTransport } from "./http.ts";
import { compose, type RequestMiddleware } from "./middleware.ts";
import { State } from "./state.ts";
import { dereferenceSchema } from "./utils.ts";
import { WebSocketServerTransport } from "./websocket.ts";

const idFromDefinition = (definition: string) => {
  const [_, __, id] = definition.split("/");
  return id;
};

const IS_DEBUG = Deno.env.get("DEBUG") === "1";
const RESOLVABLE_DEFINITION = "#/definitions/Resolvable";

function setupMcpServer<TManifest extends AppManifest>(
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
) {
  const mcp = new McpServer({
    name: `deco-site-${crypto.randomUUID()}`,
    version: context.deploymentId ?? "unknown",
  }, {
    capabilities: {
      tools: {},
    },
  });

  registerTools(mcp, deco, options);

  return { mcp };
}

export interface Options<TManifest extends AppManifest> {
  include?: Array<keyof (TManifest["actions"] & TManifest["loaders"])>;
  exclude?: Array<keyof (TManifest["actions"] & TManifest["loaders"])>;
  blocks?: Array<keyof TManifest>;
  basePath?: string;
  /**
   * Custom path for MCP messages endpoint. Defaults to /mcp/messages if not provided.
   */
  mcpPath?: string;
  middlewares?: {
    listTools?: ListToolsMiddleware[];
    callTool?: CallToolMiddleware[];
  };
}

interface RootSchema extends JSONSchema7 {
  inputSchema?: string;
  outputSchema?: string;
}

// Add slugify helper function
const slugify = (name: string) => {
  return name.replace(/[./]/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
};
export interface Tool {
  name: string;
  icon?: string;
  resolveType: string;
  appName?: string;
  description: string;
  outputSchema: JSONSchema7;
  inputSchema: JSONSchema7;
}

export const getTools = <TManifest extends AppManifest>(
  toolNames: Map<string, string>,
  schemas?: Schemas,
  options?: Options<TManifest>,
  apps?: Record<string, { namespace: string }>,
): Tool[] => {
  if (!schemas) return [];

  const blocks = options?.blocks ?? ["loaders", "actions"];

  // Get available functions from all specified blocks
  const availableFunctions = blocks.flatMap((block) => {
    const blockSchema = schemas?.root[block as keyof typeof schemas["root"]] ??
      { anyOf: [] };
    return "anyOf" in blockSchema ? blockSchema.anyOf ?? [] : [];
  });

  const tools = availableFunctions.map(
    (func) => {
      func = func as RootSchema;
      if (!func.$ref || func.$ref === RESOLVABLE_DEFINITION) return;
      const funcDefinition = schemas.definitions[idFromDefinition(func.$ref)];
      const resolveType =
        (funcDefinition.properties?.__resolveType as { default: string })
          .default;

      if (
        options?.include &&
        !options.include.includes(
          resolveType as typeof options.include[number],
        )
      ) return;

      if (
        options?.exclude &&
        options.exclude.includes(
          resolveType as typeof options.exclude[number],
        )
      ) return;

      const getInputSchemaId = () => {
        if ("inputSchema" in func) {
          return func.inputSchema as string;
        }
        const props = funcDefinition.allOf ?? [];
        const propsSchema = props[0];
        const ref = (propsSchema as JSONSchema7)?.$ref;
        return ref;
      };

      const ref = getInputSchemaId();
      const rawInputSchema = ref
        ? schemas.definitions[idFromDefinition(ref)]
        : undefined;

      // Dereference the input schema
      const inputSchema = rawInputSchema
        ? dereferenceSchema(
          rawInputSchema as JSONSchema7,
          schemas.definitions,
        )
        : undefined;

      const outputSchemaId = "outputSchema" in func
        ? func.outputSchema as string
        : undefined;

      const rawOutputSchema = outputSchemaId
        ? schemas.definitions[idFromDefinition(outputSchemaId)]
        : undefined;

      const selfReference = (rawOutputSchema?.anyOf ?? [])[0];

      const outputSchema = selfReference
        ? dereferenceSchema(
          selfReference as JSONSchema7,
          schemas.definitions,
        )
        : undefined;

      const isInternal = (funcDefinition as { internal?: boolean })?.internal ??
        (inputSchema as { internal?: boolean })?.internal ?? false;
      if (isInternal) return;

      // Handle tool name slugification and clashes
      let toolName = (funcDefinition as { name?: string })?.name ??
        (inputSchema as { name?: string })?.name ??
        slugify(funcDefinition.title ?? resolveType);
      let idx = 1;

      while (
        toolNames.has(toolName) && toolNames.get(toolName) !== resolveType
      ) {
        toolName = `${toolName}-${idx}`;
        idx++;
      }
      toolNames.set(toolName, resolveType);

      const normalizeSchema = (schema?: JSONSchema7): JSONSchema7 => {
        return schema && "type" in schema && schema.type === "object"
          ? schema
          : {
            type: "object",
            additionalProperties: true,
          };
      };

      const icon = (funcDefinition as { logo?: string }).logo;

      return {
        name: toolName,
        resolveType,
        appName: apps?.[resolveType]?.namespace,
        description: funcDefinition.description ?? inputSchema?.description ??
          resolveType,
        icon,
        outputSchema: normalizeSchema(outputSchema),
        inputSchema: normalizeSchema(inputSchema),
      };
    },
  );

  return tools.filter((tool) => tool !== undefined);
};

export interface ListToolsResult {
  tools: Tool[];
  [key: string]: unknown;
}

export type ListToolsMiddleware = RequestMiddleware<
  z.infer<typeof ListToolsRequestSchema>,
  ListToolsResult
>;

export type CallToolMiddleware = RequestMiddleware<
  z.infer<typeof CallToolRequestSchema>,
  z.infer<typeof CallToolResultSchema>
>;

function registerTools<TManifest extends AppManifest>(
  mcp: McpServer,
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
) {
  // Add map to store slugified names to original names
  let toolNames: null | Map<string, string> = null;
  const loadTools = async (): Promise<ListToolsResult> => {
    toolNames ??= new Map<string, string>();
    const meta = await deco.meta().then((v) => v?.value);
    if (!meta) return { tools: [] };
    const schemas = meta.schema;
    return {
      tools: getTools(
        toolNames,
        schemas,
        options,
        meta?.manifest?.blocks?.apps,
      ),
    };
  };

  const listTools: ListToolsMiddleware = compose(
    ...(options?.middlewares?.listTools ?? []),
    loadTools,
  );

  mcp.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await listTools(request);
  });

  const invokeTool = async (
    req: z.infer<typeof CallToolRequestSchema>,
  ): Promise<z.infer<typeof CallToolResultSchema>> => {
    IS_DEBUG && console.log(req);
    try {
      const state = State.active() ?? await deco.prepareState({
        req: {
          raw: new Request("http://localhost:8000"),
          param: () => ({}),
        },
      });
      // Use the original name from the map when invoking
      if (!toolNames) {
        await loadTools();
      }
      const originalName = toolNames!.get(req.params.name);
      if (!originalName) {
        throw new Error(`Tool not found: ${req.params.name}`);
      }
      const result = await deco.invoke(
        originalName as `#${string}`,
        // deno-lint-ignore no-explicit-any
        req.params.arguments ?? {} as any,
        undefined,
        state,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        isError: false,
        // deno-lint-ignore no-explicit-any
        structuredContent: result as any,
      };
    } catch (err) {
      console.error(err);

      return {
        isError: true,
        structuredContent: {
          status: typeof err === "object" && err !== null && "status" in err
            ? (err as { status: string }).status
            : undefined,
          message: err instanceof Error ? err.message : `${err}`,
          stack: err instanceof Error ? err.stack : undefined,
        },
      };
    }
  };

  const callToolMiddleware: CallToolMiddleware = compose(
    ...(options?.middlewares?.callTool ?? []),
    invokeTool,
  );

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await callToolMiddleware(req);
  });
}

const MESSAGES_ENDPOINT = "/mcp/messages";
export function mcpServer<TManifest extends AppManifest>(
  deco: Deco<TManifest>,
  options?: Options<TManifest>,
): MiddlewareHandler {
  return async (_c: Context, next: Next) => {
    const { mcp } = setupMcpServer(deco, options);
    const c = _c as DecoMiddlewareContext;
    const path = new URL(c.req.url).pathname;
    const basePath = options?.basePath ?? "";

    // Handle WebSocket upgrade if requested
    if (
      path === `${basePath}/mcp/ws` &&
      c.req.raw.headers.get("upgrade") === "websocket"
    ) {
      const { response, socket } = Deno.upgradeWebSocket(c.req.raw);
      const transport = new WebSocketServerTransport();
      transport.acceptWebSocket(socket);
      mcp.server.connect(transport);
      return response;
    }

    // Main message endpoint - handles both stateless requests and SSE upgrades
    const mcpPath = options?.mcpPath ?? MESSAGES_ENDPOINT;
    if (path === `${options?.basePath ?? ""}${mcpPath}`) {
      // Check if this is a browser request (HTML acceptance)
      const acceptHeader = c.req.header("accept") || "";
      const isHTMLRequest = acceptHeader.includes("text/html");
      
      if (isHTMLRequest) {
        // Return HTML page for browser requests
        const currentUrl = c.req.url.replace(/^http:/, 'https:');
        
        // Get tools data directly
        const meta = await deco.meta().then((v) => v?.value);
        const tools = meta ? getTools(new Map<string, string>(), meta.schema, options, meta?.manifest?.blocks?.apps) : [];
        const toolsHtml = tools.length > 0 
          ? tools.map((tool: Tool) => `
              <div class="tool-card">
                <div class="tool-name">${tool.name}</div>
                <div class="tool-description">${tool.description || 'No description available'}</div>
                ${tool.appName ? `<div class="tool-app">${tool.appName}</div>` : ''}
              </div>
            `).join('')
          : '<div class="no-tools">No tools available</div>';
        const htmlResponse = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP Server</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #ffffff;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 40px;
            line-height: 1.6;
            color: #000000;
        }
        
        .container {
            background: #ffffff;
            border: 2px solid #000000;
            padding: 80px 60px;
            max-width: 720px;
            width: 100%;
            position: relative;
        }
        
        .container::before {
            content: '';
            position: absolute;
            top: 8px;
            left: 8px;
            right: -8px;
            bottom: -8px;
            background: #000000;
            z-index: -1;
        }
        
        .header {
            margin-bottom: 60px;
            text-align: center;
        }
        
        h1 {
            color: #000000;
            font-size: 3.5rem;
            font-weight: 900;
            letter-spacing: -0.02em;
            margin-bottom: 20px;
            text-transform: uppercase;
        }
        
        .mcp-link {
            color: #000000;
            text-decoration: none;
            position: relative;
            transition: all 0.3s ease;
        }
        
        .mcp-link::after {
            content: '';
            position: absolute;
            bottom: -4px;
            left: 0;
            width: 100%;
            height: 3px;
            background: #000000;
            transform: scaleX(0);
            transform-origin: right;
            transition: transform 0.3s ease;
        }
        
        .mcp-link:hover::after {
            transform: scaleX(1);
            transform-origin: left;
        }
        
        .subtitle {
            color: #666666;
            font-size: 1.25rem;
            font-weight: 400;
            letter-spacing: 0.05em;
            text-transform: uppercase;
        }
        
        .url-section {
            margin-bottom: 60px;
        }
        
        .tools-section {
            margin-bottom: 60px;
        }
        
        .tools-section h2 {
            color: #000000;
            font-size: 1.5rem;
            font-weight: 900;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            margin-bottom: 30px;
            text-align: center;
        }
        

        
        .tools-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }
        
        .tool-card {
            border: 2px solid #000000;
            padding: 24px;
            background: #ffffff;
            position: relative;
            transition: all 0.3s ease;
        }
        
        .tool-card::before {
            content: '';
            position: absolute;
            top: 4px;
            left: 4px;
            right: -4px;
            bottom: -4px;
            background: #000000;
            z-index: -1;
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        
        .tool-card:hover::before {
            opacity: 1;
        }
        
        .tool-card:hover {
            transform: translate(-4px, -4px);
        }
        
        .tool-card:hover .tool-name {
            color: #ffffff;
        }
        
        .tool-card:hover .tool-description {
            color: #cccccc;
        }
        
        .tool-card:hover .tool-app {
            color: #000000;
            background: #ffffff;
        }
        
        .tool-name {
            font-size: 1.125rem;
            font-weight: 700;
            color: #000000;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.02em;
        }
        
        .tool-description {
            color: #666666;
            font-size: 0.9rem;
            line-height: 1.4;
            margin-bottom: 16px;
        }
        
        .tool-app {
            font-size: 0.8rem;
            color: #000000;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            border: 1px solid #000000;
            padding: 4px 8px;
            display: inline-block;
            background: #f5f5f5;
        }
        
        .no-tools {
            text-align: center;
            color: #666666;
            font-style: italic;
            padding: 40px;
        }
        
        .url-section label {
            display: block;
            margin-bottom: 20px;
            font-weight: 700;
            color: #000000;
            font-size: 1.125rem;
            letter-spacing: -0.01em;
        }
        
        .url-input-container {
            display: flex;
            gap: 16px;
            align-items: stretch;
            margin-bottom: 20px;
        }
        
        .url-input {
            flex: 1;
            padding: 18px 24px;
            border: 2px solid #000000;
            font-size: 16px;
            font-family: 'Monaco', 'Courier New', monospace;
            background-color: #f5f5f5;
            color: #000000;
            transition: all 0.2s ease;
        }
        
        .url-input:focus {
            outline: none;
            background-color: #ffffff;
        }
        
        .copy-button {
            padding: 18px 32px;
            background: #000000;
            color: #ffffff;
            border: 2px solid #000000;
            cursor: pointer;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            transition: all 0.2s ease;
            position: relative;
            overflow: hidden;
        }
        
        .copy-button:hover {
            background: #ffffff;
            color: #000000;
        }
        
        .copy-button:active {
            transform: scale(0.98);
        }
        
        .success-message {
            padding: 16px 24px;
            background: #000000;
            color: #ffffff;
            font-weight: 600;
            display: none;
            text-align: center;
            letter-spacing: 0.02em;
        }
        
        @keyframes fadeIn {
            from {
                opacity: 0;
            }
            to {
                opacity: 1;
            }
        }
        
        .footer {
            text-align: center;
            padding-top: 40px;
            border-top: 2px solid #000000;
        }
        
        .deco-logo {
            width: 140px;
            height: auto;
            margin-bottom: 20px;
            filter: grayscale(100%) contrast(200%);
            opacity: 0.9;
            transition: opacity 0.3s ease;
        }
        
        .deco-logo:hover {
            opacity: 1;
        }
        
        .footer-text {
            color: #000000;
            font-size: 1rem;
            font-weight: 500;
            letter-spacing: 0.02em;
        }
        
        .deco-link {
            color: #000000;
            text-decoration: none;
            font-weight: 700;
            position: relative;
        }
        
        .deco-link::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            width: 100%;
            height: 2px;
            background: #000000;
            transform: scaleX(0);
            transform-origin: right;
            transition: transform 0.3s ease;
        }
        
        .deco-link:hover::after {
            transform: scaleX(1);
            transform-origin: left;
        }
        
        @media (max-width: 720px) {
            body {
                padding: 20px;
            }
            
            .container {
                padding: 60px 40px;
            }
            
            h1 {
                font-size: 2.5rem;
            }
            
            .url-input-container {
                flex-direction: column;
                gap: 16px;
            }
            
            .url-input, .copy-button {
                width: 100%;
            }
            
            .deco-logo {
                width: 120px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>This is an <a href="https://modelcontextprotocol.io/introduction" class="mcp-link" target="_blank">MCP</a></h1>
            <p class="subtitle">Model Context Protocol Server</p>
        </div>
        
        <main class="url-section">
            <label for="mcp-url">Use in your agents using the following URL:</label>
            <div class="url-input-container">
                <input type="text" id="mcp-url" class="url-input" value="${currentUrl}" readonly>
                <button class="copy-button" onclick="copyUrl()">COPY</button>
            </div>
            <div id="success-message" class="success-message">URL COPIED TO CLIPBOARD</div>
        </main>
        
        <section class="tools-section">
            <h2>AVAILABLE TOOLS</h2>
            <div class="tools-list">${toolsHtml}</div>
        </section>
        
        <div class="footer">
            <a href="https://github.com/deco-cx/apps" target="_blank">
                <img src="https://i.imgur.com/SxsbOMg.png" alt="Deco Logo" class="deco-logo">
            </a>
            <p class="footer-text">MCP created with <a href="https://github.com/deco-cx/apps" class="deco-link" target="_blank">deco</a></p>
        </div>
    </div>

    <script>
        async function copyUrl() {
            const input = document.getElementById('mcp-url');
            const successMessage = document.getElementById('success-message');
            
            try {
                await navigator.clipboard.writeText(input.value);
                successMessage.style.display = 'block';
                successMessage.style.animation = 'fadeIn 0.3s ease';
                setTimeout(() => {
                    successMessage.style.display = 'none';
                }, 3000);
            } catch (err) {
                // Fallback for older browsers
                input.select();
                document.execCommand('copy');
                successMessage.style.display = 'block';
                successMessage.style.animation = 'fadeIn 0.3s ease';
                setTimeout(() => {
                    successMessage.style.display = 'none';
                }, 3000);
            }
        }
        

    </script>
</body>
</html>`;
        
        return new Response(htmlResponse, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
          },
        });
      }

      // For stateless transport
      const transport = new HttpServerTransport();
      await mcp.server.connect(transport);
      const handleMessage = State.bind(c.var, async () => {
        return await transport.handleMessage(c.req.raw);
      });

      const response = await handleMessage();
      transport.close(); // Close the transport after handling the message
      return response;
    }
    await next();
  };
}
