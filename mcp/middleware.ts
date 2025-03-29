// deno-lint-ignore-file no-explicit-any

export interface RequestMiddlewareContext<T = any> {
  next?(): Promise<T>;
}
export type RequestMiddleware<
  TRequest = any,
  TResponse = any,
> = (request: TRequest, next?: () => Promise<TResponse>) => Promise<TResponse>;

export const compose = <
  TRequest,
  TResponse,
>(
  ...middlewares: RequestMiddleware<TRequest, TResponse>[]
): RequestMiddleware<TRequest, TResponse> => {
  const last = middlewares[middlewares.length - 1];
  return function composedResolver(request: TRequest) {
    const dispatch = (
      i: number,
    ): Promise<TResponse> => {
      const middleware = middlewares[i];
      if (!middleware) {
        return last(request);
      }
      const next = () => dispatch(i + 1);
      return middleware(request, next);
    };

    return dispatch(0);
  };
};
