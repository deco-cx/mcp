// deno-lint-ignore-file no-explicit-any
import type { ActorProxy, ActorState } from "@deco/actors";
import { Actor } from "@deco/actors";
import { WatchTarget } from "@deco/actors/watch";
import type { MastraMemory } from "@mastra/core";
import process from "node:process";
import { DecoAgent } from "./agent.ts";
import { createMemory } from "./memory.ts";
import type {
  Thread,
  ThreadMessage,
  ThreadMessages,
  ThreadQueryOptions,
  ThreadWatchOptions,
} from "./types.ts";

const Keys = {
  PARTICIPANTS: "participants",
};

@Actor()
export class ThreadActor implements Thread {
  private watchers: WatchTarget<ThreadMessage>;
  private participants: ActorProxy<DecoAgent>[] = [];
  private memory: MastraMemory;

  constructor(private readonly state: ActorState, private env: any) {
    this.env = { ...process.env, ...this.env };
    this.watchers = new WatchTarget<ThreadMessage>();
    this.memory = createMemory(this.env);
    this.state.blockConcurrencyWhile(async () => {
      const participants = await this.getParticipants();
      this.participants = participants.map((id) =>
        this.state.stub(DecoAgent).id(id)
      );
    });
  }

  private async getParticipants(): Promise<string[]> {
    return await this.state.storage.get<string[]>(Keys.PARTICIPANTS) ?? [];
  }

  private async addParticipant(agentId: string): Promise<void> {
    const participants = await this.getParticipants();
    if (!participants.includes(agentId)) {
      participants.push(agentId);
      await this.state.storage.put(Keys.PARTICIPANTS, participants);
    }
  }

  async sendMessage(message: ThreadMessage): Promise<void> {
    // Notify all participants
    await Promise.all(this.participants.map(async (agent) => {
      const response = await agent.generate(message);
      this.watchers.notify(response.response.messages);
    }));
  }

  async query(opts?: ThreadQueryOptions): Promise<ThreadMessages> {
    return await this.memory.query({
      threadId: this.state.id,
      ...opts,
    });
  }

  async *watch(
    opts?: ThreadWatchOptions,
  ): AsyncIterableIterator<ThreadMessage> {
    // If since is provided, first yield existing messages since that time
    if (opts?.since) {
      const existingMessages = await this.query();
      yield existingMessages.messages;
    }

    // Then start watching for new messages
    const subscription = this.watchers.subscribe();
    for await (const message of subscription) {
      yield message;
    }
  }
}
