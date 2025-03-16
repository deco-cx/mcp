# Deco.AI: Enterprise AI Agent Platform

A sophisticated Multi-AI Agent platform leveraging Cloudflare's infrastructure
with support for multiple AI providers including Anthropic, OpenAI, Google,
Mistral, Deepseek, Perplexity, and XAI.

## Features

- 🤖 **Multiple AI Model Support**: Integration with leading AI providers
  - Anthropic (Claude 3.5/3.7 Sonnet, Claude 3.5 Haiku)
  - OpenAI (GPT-4 Turbo, GPT-4, O1 series)
  - Google (Gemini 2.0/1.5 series)
  - Mistral (Pixtral and Mistral variants)
  - Others (Deepseek, Perplexity Sonar, XAI Grok-2)

- 🧠 **Advanced Memory System**
  - LibSQL Vector storage for embeddings
  - File System-based persistent storage
  - Structured memory management via `@mastra/memory`

- 🔧 **Powerful Tool System**
  - Dynamic tool registration
  - Schema-validated inputs/outputs
  - Native and MCP-provided tools

- 🔐 **Enterprise-Grade Security**
  - Request-level authentication
  - User email tracking
  - Thread ID management
  - API key management

- 📡 **Multi-Channel Integration**
  - Email Systems
  - Messaging Platforms (WhatsApp, Slack, Discord)
  - Enterprise Systems (Microsoft Teams)
  - Automated Tasks (CRON)

## Technical Requirements

- Cloudflare Workers environment
- LibSQL database for vector storage
- File system access for persistent storage
- API keys for various AI providers
- Network access for MCP server connections

## Development Features

- Full TypeScript implementation with type safety
- Zod-based schema validation
- Comprehensive error management
- Promise-based operations
- AsyncIterator implementation for streaming
- Plugin-based extensible tool system

## Architecture

### Agent Implementation

The platform is built on the `AIAgent` interface which extends the `Actor` base
class, providing:

- Persistent state handling through `ActorState`
- Comprehensive memory management
- Both synchronous and streaming operations
- Configurable agent identity and instruction sets

### Communication

Agents support multiple communication modes:

- Synchronous operations via direct `generate()` calls
- Asynchronous streaming for real-time interactions
- Tool-based interactions through an extensible system
- Multi-channel integration capabilities

## Security & Configuration

### Authentication

- User email tracking
- Thread ID management
- API key management
- Environment-based configuration

### Environment Setup

- Cloudflare integration
- Account-level settings
- Gateway management

## Getting Started

1. Install the package:

```bash
npm install @deco/agents
```

2. Configure your environment variables:

```env
CLOUDFLARE_ACCOUNT_ID=your_account_id
LIBSQL_URL=your_libsql_url
AI_PROVIDER_API_KEYS=your_api_keys
```

3. Initialize an agent:

```typescript
import { AIAgent } from "@deco/agents";

const agent = new AIAgent({
  name: "MyAgent",
  model: "claude-3-sonnet",
  instructions: "Your agent instructions here",
});
```

For more detailed documentation and examples, please refer to our
[documentation](https://deco.cx/docs/agents).
