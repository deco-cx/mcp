# MCP Server

A simple tool that transforms any [Deco](https://deco.cx) site into an MCP
server.

## Installation

```bash
deno add @deco/mcp
```

## Usage

Here's how to set up an MCP server with your Deco site:

```typescript
import { Deco } from "@deco/deco";
import { Hono } from "@hono/hono";
import manifest, { Manifest } from "./manifest.gen.ts";
import { mcpServer } from "@deco/mcp";

const app = new Hono();
const deco = await Deco.init<Manifest>({ manifest });
const envPort = Deno.env.get("PORT");

// Add MCP server middleware
app.use("/*", mcpServer(deco));

// Handle all routes with Deco
app.all("/*", async (c) => c.res = await deco.fetch(c.req.raw));

// Start the server
Deno.serve({
  handler: app.fetch,
  port: envPort ? +envPort : 8000,
});
```

## Configuration

The server will run on port 8000 by default. You can override this by setting
the `PORT` environment variable.

## Requirements

- Deno runtime
- A Deco site with a valid manifest
