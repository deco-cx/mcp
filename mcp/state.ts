import type { AppManifest, DecoMiddlewareContext } from "@deco/deco";
import { AsyncLocalStorage } from "node:async_hooks";

// deno-lint-ignore no-explicit-any
type DecoRuntimeState = DecoMiddlewareContext<any>["var"];

const asyncLocalStorage = new AsyncLocalStorage<DecoRuntimeState>();

export const State = {
  // Function to retrieve the active context
  active: <T extends AppManifest = AppManifest>():
    | DecoMiddlewareContext<
      T
    >["var"]
    | undefined => {
    // Retrieve the context associated with the async ID
    return asyncLocalStorage.getStore() as
      | DecoMiddlewareContext<T>["var"]
      | undefined;
  },
  bind: <R, TArgs extends unknown[], T extends AppManifest = AppManifest>(
    ctx: DecoMiddlewareContext<
      T
    >["var"],
    f: (...args: TArgs) => R,
  ): (...args: TArgs) => R => {
    return (...args: TArgs): R => {
      return asyncLocalStorage.run(ctx, f, ...args);
    };
  },
};
