- Da pra usar threads como database

```typescript
import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";

// Initialize memory
const memory = new Memory({
  storage: new PostgresStore({
    host: "localhost",
    port: 5432,
    user: "postgres",
    database: "postgres",
    password: "postgres",
  }),
});

// Create a new thread
const thread = await memory.createThread({
  resourceId: "user_123",
  title: "Project Discussion",
  metadata: {
    project: "mastra",
    topic: "architecture",
  },
});

// Manually save messages to a thread
await memory.saveMessages({
  messages: [
    {
      id: "msg_1",
      threadId: thread.id,
      role: "user",
      content: "What's the project status?",
      createdAt: new Date(),
      type: "text",
    },
  ],
});

// Get messages from a thread with various filters
const messages = await memory.query({
  threadId: thread.id,
  selectBy: {
    last: 10, // Get last 10 messages
    vectorSearchString: "performance", // Find messages about performance
  },
});

// Get thread by ID
const existingThread = await memory.getThreadById({
  threadId: "thread_123",
});

// Get all threads for a resource
const threads = await memory.getThreadsByResourceId({
  resourceId: "user_123",
});

// Update thread metadata
await memory.updateThread({
  id: thread.id,
  title: "Updated Project Discussion",
  metadata: {
    status: "completed",
  },
});

// Delete a thread and all its messages
await memory.deleteThread(thread.id);
```

- as tool invocations recebem a thread e o resource como paramaetro:

```typescript
import { Memory } from "@mastra/memory";
const memory = new Memory();

const myTool = createTool({
  id: "Thread Info Tool",
  inputSchema: z.object({
    fetchMessages: z.boolean().optional(),
  }),
  description: "A tool that demonstrates accessing thread and resource IDs",
  execute: async ({ threadId, resourceId, context }) => {
    // threadId and resourceId are directly available in the execute parameters
    console.log(`Executing in thread ${threadId}`);

    if (!context.fetchMessages) {
      return { threadId, resourceId };
    }

    const recentMessages = await memory.query({
      threadId,
      selectBy: { last: 5 },
    });

    return {
      threadId,
      resourceId,
      messageCount: recentMessages.length,
    };
  },
});
```
