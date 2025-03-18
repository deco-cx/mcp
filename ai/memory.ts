import type { WorkflowRunState } from "@mastra/core";
import type { MessageType, StorageThreadType } from "@mastra/core/memory";
import {
  type EvalRow,
  MastraStorage,
  type StorageColumn,
  type StorageGetMessagesArg,
  TABLE_MESSAGES,
  type TABLE_NAMES,
  TABLE_THREADS,
} from "@mastra/core/storage";
import type * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FSConfig {
  basePath: string;
  fs: typeof fs;
  enableThreadCache?: boolean;
  initialization?: Promise<void> | null;
}

interface ThreadIndex {
  resourceId: string;
  threadId: string;
  path: string;
}

export class FSStore extends MastraStorage {
  private basePath: string;
  private fs: typeof fs;
  private threadIndex: Map<string, ThreadIndex>;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private threadCache: Map<string, StorageThreadType> = new Map();
  private enableThreadCache: boolean = false;

  constructor(config: FSConfig) {
    super({ name: "FileSystem" });
    this.basePath = config.basePath;
    this.fs = config.fs;
    this.threadIndex = new Map();
    this.enableThreadCache = config.enableThreadCache ?? false;
    this.initPromise = config.initialization ?? this.initialize();
  }

  public initialize(): Promise<void> {
    if (this.isInitialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    const promise = (async () =>
      await Promise.all([
        // Base directories for threads and resources
        this.ensureDir(path.join(this.basePath, "threads")),
        this.ensureDir(path.join(this.basePath, "indexes", "resources")),
        this.ensureDir(path.join(this.basePath, "messages")),
        // Workflow related directories
        this.ensureDir(path.join(this.basePath, "workflows")),
        // Evaluation related directories
        this.ensureDir(path.join(this.basePath, "evals")),
        // Trace related directories
        this.ensureDir(path.join(this.basePath, "traces")),
      ]).then(() => { }))();
    this.isInitialized = true;
    return promise;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    const stat = await this.fs.stat(dirPath).catch(() => null);
    if (stat?.isDirectory()) return;
    await this.fs.mkdir(dirPath, { recursive: true });
  }

  private getThreadMetaPath(threadId: string): string {
    return path.join(this.basePath, "threads", threadId, "meta.json");
  }

  private getThreadMessagesPath(threadId: string): string {
    return path.join(this.basePath, "threads", threadId, "messages");
  }

  private getMessagePath(threadId: string, messageId: string): string {
    return path.join(this.getThreadMessagesPath(threadId), `${messageId}.json`);
  }

  private getResourceIndexPath(resourceId: string): string {
    return path.join(this.basePath, "indexes", "resources", resourceId);
  }

  private getResourceThreadPath(resourceId: string, threadId: string): string {
    return path.join(this.getResourceIndexPath(resourceId), `${threadId}.json`);
  }

  private getWorkflowPath(workflowName: string, runId: string): string {
    return path.join(this.basePath, "workflows", workflowName, `${runId}.json`);
  }

  private getEvalPath(agentName: string): string {
    return path.join(this.basePath, "evals", agentName);
  }

  private getTracePath(): string {
    return path.join(this.basePath, "traces");
  }

  override async createTable({ }: {
    tableName: TABLE_NAMES;
    schema: Record<string, StorageColumn>;
  }): Promise<void> {
    await this.initialize();
  }

  async clearTable({ tableName }: { tableName: TABLE_NAMES }): Promise<void> {
    if (tableName === TABLE_THREADS) {
      // Clear threads and indexes
      await Promise.all([
        this.fs.rm(path.join(this.basePath, "threads")),
        this.fs.rm(path.join(this.basePath, "indexes")),
      ]);

      await Promise.all([
        this.ensureDir(path.join(this.basePath, "threads")),
        this.ensureDir(path.join(this.basePath, "indexes", "resources")),
      ]);

      // Recreate directories
      this.threadIndex.clear();
    }
  }

  async saveThread(
    { thread }: { thread: StorageThreadType },
  ): Promise<StorageThreadType> {
    // Clear cache entry when saving
    this.threadCache.delete(thread.id);

    // Create thread directory
    const threadDir = path.join(this.basePath, "threads", thread.id);

    // Create resource index
    const resourcePath = this.getResourceIndexPath(thread.resourceId);

    await Promise.all([
      this.ensureDir(path.join(threadDir, "messages")),
      this.ensureDir(resourcePath),
    ]);

    // Save thread metadata
    const metaPath = this.getThreadMetaPath(thread.id);

    // Create thread reference in resource index
    const resourceThreadPath = this.getResourceThreadPath(
      thread.resourceId,
      thread.id,
    );

    await Promise.all([
      this.fs.writeFile(metaPath, JSON.stringify(thread, null, 2)),
      this.fs.writeFile(
        resourceThreadPath,
        JSON.stringify({ threadId: thread.id }),
      ),
    ]);

    // Update thread index
    this.threadIndex.set(thread.id, {
      resourceId: thread.resourceId,
      threadId: thread.id,
      path: metaPath,
    });

    return thread;
  }

  async getThreadById(
    { threadId }: { threadId: string },
  ): Promise<StorageThreadType | null> {
    // Check cache first if enabled
    if (this.enableThreadCache) {
      const cached = this.threadCache.get(threadId);
      if (cached) {
        return cached;
      }
    }

    try {
      const metaPath = this.getThreadMetaPath(threadId);
      const data = await this.fs.readFile(metaPath, "utf-8");
      const thread = JSON.parse(data) as StorageThreadType;

      const processedThread = {
        ...thread,
        createdAt: new Date(thread.createdAt),
        updatedAt: new Date(thread.updatedAt),
        metadata: typeof thread.metadata === "string"
          ? JSON.parse(thread.metadata)
          : thread.metadata,
      };

      // Cache the thread if caching is enabled
      if (this.enableThreadCache) {
        this.threadCache.set(threadId, processedThread);
      }

      return processedThread;
    } catch {
      return null;
    }
  }

  async getThreadsByResourceId(
    { resourceId }: { resourceId: string },
  ): Promise<StorageThreadType[]> {
    try {
      const resourcePath = this.getResourceIndexPath(resourceId);
      const files = await this.fs.readdir(resourcePath);

      const threadIds = files
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.replace(".json", ""));

      const threads = await Promise.all(
        threadIds.map((threadId) => this.getThreadById({ threadId })),
      );

      return threads.filter((thread): thread is StorageThreadType =>
        thread !== null
      );
    } catch {
      return [];
    }
  }

  async saveMessages(
    { messages }: { messages: MessageType[] },
  ): Promise<MessageType[]> {
    await Promise.all(
      messages.map(async (message) => {
        const messagePath = this.getMessagePath(message.threadId, message.id);
        await this.ensureDir(path.dirname(messagePath));
        await this.fs.writeFile(messagePath, JSON.stringify(message, null, 2));
      }),
    );
    return messages;
  }

  async getMessages<T = unknown>(
    { threadId, selectBy }: StorageGetMessagesArg,
  ): Promise<T[]> {
    try {
      const messagesDir = this.getThreadMessagesPath(threadId);
      const files = await this.fs.readdir(messagesDir);

      const messages = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const content = await this.fs.readFile(
              path.join(messagesDir, file),
              "utf-8",
            );
            return JSON.parse(content) as MessageType;
          }),
      );

      messages.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

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
    } catch {
      return [];
    }
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    const thread = await this.getThreadById({ threadId });
    if (!thread) return;

    // Delete thread directory and all its contents
    await this.fs.rm(path.join(this.basePath, "threads", threadId), {
      recursive: true,
      force: true,
    });

    // Delete resource index entry
    try {
      await this.fs.rm(this.getResourceThreadPath(thread.resourceId, threadId));
    } catch {
      // Ignore if file doesn't exist
    }

    this.threadIndex.delete(threadId);
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

  async insert({ tableName, record }: {
    tableName: TABLE_NAMES;
    record: Record<string, unknown>;
  }): Promise<void> {
    if (tableName === TABLE_THREADS) {
      await this.saveThread({ thread: record as StorageThreadType });
    } else if (tableName === TABLE_MESSAGES) {
      await this.saveMessages({ messages: [record as MessageType] });
    } else {
      throw new Error(`Unsupported table: ${tableName}`);
    }
  }

  async batchInsert({ tableName, records }: {
    tableName: TABLE_NAMES;
    records: Record<string, unknown>[];
  }): Promise<void> {
    if (tableName === TABLE_THREADS) {
      await Promise.all(
        records.map((record) =>
          this.saveThread({ thread: record as StorageThreadType })
        ),
      );
    } else if (tableName === TABLE_MESSAGES) {
      await this.saveMessages({ messages: records as MessageType[] });
    } else {
      throw new Error(`Unsupported table: ${tableName}`);
    }
  }

  load<R>({ tableName, keys }: {
    tableName: TABLE_NAMES;
    keys: Record<string, string>;
  }): Promise<R | null> {
    if (tableName === TABLE_THREADS) {
      return this.getThreadById({ threadId: keys.id }) as Promise<R | null>;
    }
    throw new Error(`Unsupported table: ${tableName}`);
  }

  override async persistWorkflowSnapshot({ workflowName, runId, snapshot }: {
    workflowName: string;
    runId: string;
    snapshot: WorkflowRunState;
  }): Promise<void> {
    const filePath = this.getWorkflowPath(workflowName, runId);
    await this.ensureDir(path.dirname(filePath));
    await this.fs.writeFile(filePath, JSON.stringify(snapshot, null, 2));
  }

  override async loadWorkflowSnapshot({ workflowName, runId }: {
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null> {
    try {
      const filePath = this.getWorkflowPath(workflowName, runId);
      const data = await this.fs.readFile(filePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  override async getEvalsByAgentName(
    agentName: string,
    type: "test" | "live" = "live",
  ): Promise<EvalRow[]> {
    try {
      const evalDir = this.getEvalPath(agentName);
      const files = await this.fs.readdir(evalDir);

      const evals = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const content = await this.fs.readFile(
              path.join(evalDir, file),
              "utf-8",
            );
            const evalData = JSON.parse(content);
            // Simple type check - if it's a test eval and we want live evals (or vice versa), skip it
            if (type === "test" && !evalData.testInfo) return null;
            if (type === "live" && evalData.testInfo) return null;
            return evalData;
          }),
      );

      return evals.filter((eval_): eval_ is EvalRow => eval_ !== null);
    } catch {
      return [];
    }
  }

  override async getTraces({ name, scope, page, perPage, attributes }: {
    name?: string;
    scope?: string;
    page: number;
    perPage: number;
    attributes?: Record<string, string>;
  }): Promise<unknown[]> {
    try {
      const traceDir = this.getTracePath();
      const files = await this.fs.readdir(traceDir);

      const traces = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map(async (file) => {
            const content = await this.fs.readFile(
              path.join(traceDir, file),
              "utf-8",
            );
            return JSON.parse(content) as unknown;
          }),
      );

      // Filter by name and scope if provided
      let filtered = traces;
      if (name) {
        filtered = filtered.filter((trace) =>
          typeof trace === "object" && trace !== null && "name" in trace &&
          trace.name === name
        );
      }
      if (scope) {
        filtered = filtered.filter((trace) =>
          typeof trace === "object" && trace !== null && "scope" in trace &&
          trace.scope === scope
        );
      }
      if (attributes) {
        filtered = filtered.filter((trace) => {
          if (typeof trace !== "object" || trace === null) return false;
          return Object.entries(attributes).every(([key, value]) =>
            key in trace && trace[key as keyof typeof trace] === value
          );
        });
      }

      // Apply pagination
      const start = (page - 1) * perPage;
      const end = start + perPage;
      return filtered.slice(start, end);
    } catch {
      return [];
    }
  }

  close(): Promise<void> {
    // No cleanup needed for filesystem
    return Promise.resolve();
  }

  public fork(): FSStore {
    // Create a new instance with the same configuration
    const forkedStore = new FSStore({
      basePath: this.basePath,
      fs: this.fs,
      enableThreadCache: this.enableThreadCache,
      initialization: this.initPromise,
    });

    // Copy over the initialization state and thread index
    forkedStore.isInitialized = this.isInitialized;
    forkedStore.initPromise = this.initPromise;
    forkedStore.threadIndex = new Map(this.threadIndex);

    // The threadCache remains empty in the forked instance
    // as that's the main purpose of forking

    return forkedStore;
  }
}
