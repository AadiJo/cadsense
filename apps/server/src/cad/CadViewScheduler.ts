import { ThreadId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface CadViewSchedulerShape {
  readonly enqueue: <A, E = never, R = never>(
    threadId: ThreadId,
    operationId: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class CadViewScheduler extends Context.Service<CadViewScheduler, CadViewSchedulerShape>()(
  "cadsense/cad/CadViewScheduler",
) {}

export const makeCadViewScheduler = (onPendingThreadCountChange?: (count: number) => void) =>
  Effect.sync(() => {
    const tails = new Map<string, Promise<void>>();

    const enqueue: CadViewSchedulerShape["enqueue"] = (threadId, operationId, operation) =>
      Effect.contextWith((context) =>
        Effect.promise(() => {
          const previous = tails.get(threadId) ?? Promise.resolve();
          let release!: () => void;
          const current = new Promise<void>((resolve) => {
            release = resolve;
          });
          const tail = previous.then(
            () => current,
            () => current,
          );
          tails.set(threadId, tail);
          onPendingThreadCountChange?.(tails.size);
          return previous.then(async () => {
            try {
              return await Effect.runPromise(operation.pipe(Effect.provideContext(context)));
            } finally {
              release();
              if (tails.get(threadId) === tail) {
                tails.delete(threadId);
                onPendingThreadCountChange?.(tails.size);
              }
              void operationId;
            }
          });
        }),
      );

    return { enqueue } satisfies CadViewSchedulerShape;
  });

export const CadViewSchedulerLive = Layer.effect(CadViewScheduler, makeCadViewScheduler());
