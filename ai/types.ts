// deno-lint-ignore-file no-explicit-any
import type { Actor } from "@deco/actors";
import type {
  CoreMessage,
  GenerateTextResult,
  Message as AIMessage,
  StreamTextResult,
  TextStreamPart,
} from "ai";
import type { StorageGetMessagesArg } from "@mastra/core";

/**
 * Represents a collection of messages in both raw and UI-formatted forms
 */
export interface ThreadMessages {
  /** Raw messages in CoreMessage format */
  messages: CoreMessage[];
  /** Messages formatted for UI display */
  uiMessages: AIMessage[];
}

/**
 * Options for watching thread messages
 */
export interface ThreadWatchOptions {
  /** Optional timestamp to get messages since a specific date */
  since?: Date;
}

/**
 * Options for querying thread messages
 */
export interface ThreadQueryOptions {
  /** Optional selection criteria for retrieving messages */
  selectBy?: StorageGetMessagesArg["selectBy"];
}

/**
 * Interface for managing a message thread
 * Note: Any sender of a message is automatically added as a thread participant
 */
export interface Thread extends Actor {
  /**
   * Sends a message to the thread
   * @param message - The message content to send
   * @returns Promise that resolves when the message is sent
   */
  sendMessage(message: ThreadMessage): Promise<void>;

  /**
   * Queries messages in the thread
   * @param opts - Optional query parameters
   * @returns Promise containing messages and their UI-formatted versions
   */
  query(opts?: ThreadQueryOptions): Promise<ThreadMessages>;

  /**
   * Watches for new messages in the thread
   * @param opts - Optional watch parameters
   * @returns AsyncIterator that yields new messages as they arrive
   */
  watch(opts?: ThreadWatchOptions): AsyncIterableIterator<ThreadMessage>;

  /**
   * Invites an agent to the thread
   * @param agentId - The ID of the agent to invite
   * @returns Promise that resolves when the agent is invited
   */
  invite(agentId: string): Promise<void>;
}

/**
 * Represents a paginated list of items
 */
export interface Pagination<T> {
  items: T[];
  nextCursor: string;
}

/**
 * Represents a thread
 */
export interface ThreadContent {
  id: string;
}

/**
 * Options for listing threads
 */
export interface ThreadListOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Represents a list of threads
 */
export interface Threads {
  list(opts?: ThreadListOptions): Promise<Pagination<ThreadContent>>;
}

/**
 * Represents a tool that can be used by an AI agent
 */
export interface Tool {
  /** Name of the tool */
  name: string;
  /** Description of what the tool does */
  description: string;
  /** Optional JSON schema defining the expected input format */
  inputSchema?: any;
  /** Optional JSON schema defining the expected output format */
  ouputSchema?: any;
}

/**
 * Represents possible message formats that can be sent in a thread
 * Can be a single string, array of strings, or array of CoreMessages
 */
export type ThreadMessage = string | string[] | CoreMessage[];

/**
 * Interface for an AI agent that can generate responses and use tools
 * Extends the base Actor interface
 */
export interface AIAgent extends Actor {
  /**
   * Generates a response based on the provided input
   * @param payload - Input content as string, string array, or CoreMessage array
   * @returns Promise containing the generated text result
   */
  generate(
    payload: ThreadMessage,
  ): Promise<GenerateTextResult<any, any>>;

  /**
   * Streams a response based on the provided input
   * @param payload - Input content as string, string array, or CoreMessage array
   * @returns AsyncIterator that yields text stream parts and final result
   */
  stream(
    payload: ThreadMessage,
  ): AsyncIterableIterator<TextStreamPart<any>, StreamTextResult<any, any>>;

  /**
   * Calls a specific tool with the given input
   * @param tool - Name of the tool to call
   * @param input - Input data for the tool
   * @returns Promise containing the tool's execution result
   */
  callTool(tool: string, input: any): Promise<any>;

  /**
   * Optional method to retrieve the set of available tools
   * @returns Promise or direct object containing categorized tool definitions
   */
  toolset?():
    | Promise<Record<string, Record<string, Tool>>>
    | Record<string, Record<string, Tool>>;
}
