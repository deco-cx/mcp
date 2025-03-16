import type { MessageType, StorageThreadType } from "@mastra/core/memory";
import {
  type EvalRow,
  MastraStorage,
  type StorageColumn,
  type StorageGetMessagesArg,
  type TABLE_NAMES,
} from "@mastra/core/storage";
import * as path from "node:path";

export interface FSConfig {
  basePath: string;
  fs: typeof import("fs/promises");
}

export class FSStore extends MastraStorage {
  private basePath: string;
  private fs: typeof import("fs/promises");
  constructor(config: FSConfig) {
    super({ name: "FileSystem" });
    this.basePath = config.basePath;
    this.fs = config.fs;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await this.fs.mkdir(dirPath, { recursive: true });
  }

  private getTablePath(tableName: TABLE_NAMES): string {
    return path.join(this.basePath, tableName);
  }

  private getFilePath(
    tableName: TABLE_NAMES,
    keys: Record<string, unknown>,
  ): string {
    const fileName = Object.entries(keys)
      .map(([key, value]) => `${key}-${value}`)
      .join("_");
    return path.join(this.getTablePath(tableName), `${fileName}.json`);
  }

  async createTable(
    { tableName, schema }: {
      tableName: TABLE_NAMES;
      schema: Record<string, StorageColumn>;
    },
  ): Promise<void> {
    const tablePath = this.getTablePath(tableName);
    await this.ensureDir(tablePath);
    // Store schema for reference
    await this.fs.writeFile(
      path.join(tablePath, "_schema.json"),
      JSON.stringify(schema, null, 2),
    );
  }

  async clearTable({ tableName }: { tableName: TABLE_NAMES }): Promise<void> {
    const tablePath = this.getTablePath(tableName);
    try {
      await this.fs.rm(tablePath, { recursive: true, force: true });
      await this.ensureDir(tablePath);
    } catch {
      // Ignore if directory doesn't exist
    }
  }

  async insert(
    { tableName, record }: {
      tableName: TABLE_NAMES;
      record: Record<string, unknown>;
    },
  ): Promise<void> {
    const tablePath = this.getTablePath(tableName);
    await this.ensureDir(tablePath);

    let filePath: string;
    if (tableName === MastraStorage.TABLE_MESSAGES) {
      filePath = this.getFilePath(tableName, {
        threadId: record.threadId,
        id: record.id,
      });
    } else {
      filePath = this.getFilePath(tableName, { id: record.id });
    }

    await this.fs.writeFile(filePath, JSON.stringify(record, null, 2));
  }

  async load<R>(
    { tableName, keys }: {
      tableName: TABLE_NAMES;
      keys: Record<string, string>;
    },
  ): Promise<R | null> {
    const filePath = this.getFilePath(tableName, keys);
    try {
      const data = await this.fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as R;
    } catch {
      return null;
    }
  }

  async getThreadById(
    { threadId }: { threadId: string },
  ): Promise<StorageThreadType | null> {
    const thread = await this.load<StorageThreadType>({
      tableName: MastraStorage.TABLE_THREADS,
      keys: { id: threadId },
    });

    if (!thread) return null;

    return {
      ...thread,
      createdAt: new Date(thread.createdAt),
      updatedAt: new Date(thread.updatedAt),
      metadata: typeof thread.metadata === "string"
        ? JSON.parse(thread.metadata)
        : thread.metadata,
    };
  }

  async saveThread(
    { thread }: { thread: StorageThreadType },
  ): Promise<StorageThreadType> {
    await this.insert({
      tableName: MastraStorage.TABLE_THREADS,
      record: thread,
    });
    return thread;
  }

  async getMessages<T = unknown>(
    { threadId, selectBy }: StorageGetMessagesArg,
  ): Promise<T[]> {
    const messagesDir = path.join(
      this.getTablePath(MastraStorage.TABLE_MESSAGES),
    );
    const files = await this.fs.readdir(messagesDir);

    // Filter messages for this thread
    const threadMessages = files
      .filter((file) => file.startsWith(`threadId-${threadId}`))
      .map(async (file) => {
        const content = await this.fs.readFile(
          path.join(messagesDir, file),
          "utf-8",
        );
        return JSON.parse(content) as MessageType;
      });

    const messages = await Promise.all(threadMessages);

    // Sort by createdAt
    messages.sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    // Handle selection criteria
    if (selectBy?.include?.length) {
      const included = new Set<string>();
      for (const item of selectBy.include) {
        const index = messages.findIndex((m) => m.id === item.id);
        if (index === -1) continue;

        included.add(item.id);

        if (item.withPreviousMessages) {
          const start = Math.max(0, index - item.withPreviousMessages);
          for (let i = start; i < index; i++) {
            included.add(messages[i].id);
          }
        }

        if (item.withNextMessages) {
          const end = Math.min(
            messages.length,
            index + item.withNextMessages + 1,
          );
          for (let i = index + 1; i < end; i++) {
            included.add(messages[i].id);
          }
        }
      }
      return messages.filter((m) => included.has(m.id)) as unknown as T[];
    }

    const limit = typeof selectBy?.last === "number" ? selectBy.last : 40;
    return messages.slice(-limit) as unknown as T[];
  }

  async saveMessages(
    { messages }: { messages: MessageType[] },
  ): Promise<MessageType[]> {
    await Promise.all(
      messages.map((message) =>
        this.insert({
          tableName: MastraStorage.TABLE_MESSAGES,
          record: message,
        })
      ),
    );
    return messages;
  }

  async batchInsert(
    { tableName, records }: {
      tableName: TABLE_NAMES;
      records: Record<string, unknown>[];
    },
  ): Promise<void> {
    await Promise.all(
      records.map((record) =>
        this.insert({
          tableName,
          record,
        })
      ),
    );
  }

  async getThreadsByResourceId(
    { resourceId }: { resourceId: string },
  ): Promise<StorageThreadType[]> {
    const threadsDir = this.getTablePath(MastraStorage.TABLE_THREADS);
    const files = await this.fs.readdir(threadsDir);

    const threads = await Promise.all(
      files
        .filter((file) => file.endsWith(".json") && file !== "_schema.json")
        .map(async (file) => {
          const content = await this.fs.readFile(
            path.join(threadsDir, file),
            "utf-8",
          );
          return JSON.parse(content) as StorageThreadType;
        }),
    );

    return threads
      .filter((thread) => thread.resourceId === resourceId)
      .map((thread) => ({
        ...thread,
        createdAt: new Date(thread.createdAt),
        updatedAt: new Date(thread.updatedAt),
        metadata: typeof thread.metadata === "string"
          ? JSON.parse(thread.metadata)
          : thread.metadata,
      }));
  }

  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const thread = await this.getThreadById({ threadId: id });
    if (!thread) {
      throw new Error(`Thread ${id} not found`);
    }

    const updatedThread = {
      ...thread,
      title,
      metadata: {
        ...thread.metadata,
        ...metadata,
      },
      updatedAt: new Date(),
    };

    await this.saveThread({ thread: updatedThread });
    return updatedThread;
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    // Delete the thread file
    const threadPath = this.getFilePath(MastraStorage.TABLE_THREADS, {
      id: threadId,
    });
    await this.fs.rm(threadPath, { force: true });

    // Delete all associated messages
    const messagesDir = this.getTablePath(MastraStorage.TABLE_MESSAGES);
    const files = await this.fs.readdir(messagesDir);

    await Promise.all(
      files
        .filter((file) => file.startsWith(`threadId-${threadId}`))
        .map((file) =>
          this.fs.rm(path.join(messagesDir, file), { force: true })
        ),
    );
  }

  // Implement other required methods...
  getEvalsByAgentName(
    _agentName: string,
    _type?: "test" | "live",
  ): Promise<EvalRow[]> {
    throw new Error("Method not implemented.");
  }

  getTraces(_params: unknown): Promise<unknown[]> {
    throw new Error("Method not implemented.");
  }

  async close(): Promise<void> {
    // No cleanup needed for filesystem
  }
}
