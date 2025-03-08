# MCP Server

A simple tool that transforms any [Deco](https://deco.cx) site into an MCP
server.

## Installation

```bash
deno add @deco/mcp
```

## Usage

Here's how to set up an MCP server with your Deco site:

1. If you're using `https://github.com/deco-sites/mcp` as template

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
// optionally you can select tools
// app.use("/*", mcpServer<Manifest>(deco, { include: ["site/loaders/helloWorld.ts"] })); // only hello world will be available

// Handle all routes with Deco
app.all("/*", async (c) => c.res = await deco.fetch(c.req.raw));

// Start the server
Deno.serve({
  handler: app.fetch,
  port: envPort ? +envPort : 8000,
});
```

2. If you're a fresh-based site // in your fresh.config.ts

```typescript
import { defineConfig } from "$fresh/server.ts";
import { plugins } from "deco/plugins/deco.ts";
import manifest from "./manifest.gen.ts";

export default defineConfig({
  plugins: plugins({
    manifest,
    htmx: true,
    useServer: (deco, hono) => {
      hono.use("/*", mcpServer(deco as any)); // some type errors may occur
    },
  }),
});
```

## Configuration

The server will run on port 8000 by default. You can override this by setting
the `PORT` environment variable.

## Requirements

- Deno runtime
- A Deco site with a valid manifest
