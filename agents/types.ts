// deno-lint-ignore-file no-explicit-any
import type { Actor } from "@deco/actors";
import type {
  CoreMessage,
  GenerateTextResult,
  StreamTextResult,
  TextStreamPart,
} from "ai";

export interface Tool {
  name: string;
  description: string;
  inputSchema?: any;
  ouputSchema?: any;
}

export interface AIAgent extends Actor {
  generate(
    payload: string | string[] | CoreMessage[],
  ): Promise<GenerateTextResult<any, any>>;
  stream(
    payload: string | string[] | CoreMessage[],
  ): AsyncIterableIterator<TextStreamPart<any>, StreamTextResult<any, any>>;
  callTool(tool: string, input: any): Promise<any>;
  toolset?():
    | Promise<Record<string, Record<string, Tool>>>
    | Record<string, Record<string, Tool>>;
}
