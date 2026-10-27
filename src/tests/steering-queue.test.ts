import { expect, it } from "vitest";
import { SteeringQueue } from "../steering-queue.js";
import type { MuseInputPart } from "../prompt-content.js";

const input = (text: string): MuseInputPart[] => [{ type: "text", text }];
const captured = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

it("dispatches concurrent corrections in FIFO order to the captured target and snapshots content", async () => {
  const target = { id: "turn-1" };
  const first = Promise.withResolvers<string>();
  const calls: unknown[] = [];
  const queue = new SteeringQueue({
    isCurrent: (value, id) => value === target && id === target.id,
    dispatch: async (value, id, parts) => {
      calls.push({ value, id, parts });
      return calls.length === 1 ? first.promise : "accepted-second";
    },
  });
  const a = queue.enqueue(target, target.id, input("first"));
  const secondInput = input("second");
  const b = queue.enqueue(target, target.id, secondInput);
  if (secondInput[0]!.type === "text") secondInput[0]!.text = "mutated";
  expect(calls).toHaveLength(1);
  first.resolve("accepted-first");
  expect(await Promise.all([a, b])).toEqual(["accepted-first", "accepted-second"]);
  expect(calls).toEqual([
    { value: target, id: "turn-1", parts: input("first") },
    { value: target, id: "turn-1", parts: input("second") },
  ]);
});

it.each(["replacement", "cancel"])(
  "rejects queued old-turn requests after %s without retargeting",
  async (reason) => {
    const target = { id: "turn-1" };
    let current = target;
    let cancelled = false;
    const gate = Promise.withResolvers<void>();
    const dispatched: string[] = [];
    const queue = new SteeringQueue({
      isCurrent: (value, id) => value === current && id === current.id && !cancelled,
      dispatch: async (_, id) => {
        dispatched.push(id);
        await gate.promise;
      },
    });
    const first = queue.enqueue(target, target.id, input("a"));
    const second = captured(queue.enqueue(target, target.id, input("b")));
    if (reason === "replacement") current = { id: "turn-2" };
    else cancelled = true;
    gate.resolve();
    await first;
    expect(await second).toMatchObject({ ok: false, error: { code: -32600 } });
    expect(dispatched).toEqual(["turn-1"]);
  },
);

it("a host rejection is returned exactly and does not poison later work or trigger a replay", async () => {
  const failure = new Error("ambiguous transport failure");
  const calls: string[] = [];
  const queue = new SteeringQueue<object, string>({
    isCurrent: () => true,
    dispatch: async (_, id) => {
      calls.push(id);
      if (calls.length === 1) throw failure;
      return "accepted";
    },
  });
  const target = {};
  const first = captured(queue.enqueue(target, "turn-1", input("a")));
  const second = queue.enqueue(target, "turn-1", input("b"));
  expect(await first).toEqual({ ok: false, error: failure });
  expect(await second).toBe("accepted");
  expect(calls).toEqual(["turn-1", "turn-1"]);
});

it("close immediately settles queued/new work without waiting for or replaying the active host request", async () => {
  const gate = Promise.withResolvers<void>();
  let dispatched = 0;
  const queue = new SteeringQueue({
    isCurrent: () => true,
    dispatch: async () => {
      dispatched++;
      await gate.promise;
    },
  });
  const first = queue.enqueue({}, "turn-1", input("a"));
  const second = captured(queue.enqueue({}, "turn-1", input("b")));
  queue.close();
  queue.close();
  expect(await second).toMatchObject({ ok: false, error: { code: -32600 } });
  expect(await captured(queue.enqueue({}, "turn-1", input("c")))).toMatchObject({
    ok: false,
    error: { code: -32600 },
  });
  expect(dispatched).toBe(1);
  gate.resolve();
  await first;
});

it("independent sessions dispatch concurrently", async () => {
  const gate = Promise.withResolvers<void>();
  let dispatched = 0;
  const make = () =>
    new SteeringQueue({
      isCurrent: () => true,
      dispatch: async () => {
        dispatched++;
        await gate.promise;
      },
    });
  const first = make().enqueue({}, "a", input("a"));
  const second = make().enqueue({}, "b", input("b"));
  expect(dispatched).toBe(2);
  gate.resolve();
  await Promise.all([first, second]);
});

it("bounds queued corrections while one acknowledgement is pending", async () => {
  const gate = Promise.withResolvers<string>();
  const queue = new SteeringQueue<string, string>({
    isCurrent: () => true,
    dispatch: () => gate.promise,
  });
  const waiting = Array.from({ length: 17 }, () =>
    queue.enqueue("turn", "id", [{ type: "text", text: "correction" }]).catch(() => "closed"),
  );
  await expect(
    queue.enqueue("turn", "id", [{ type: "text", text: "overflow" }]),
  ).rejects.toMatchObject({ code: -32600 });
  queue.close();
  gate.resolve("accepted");
  await Promise.all(waiting);
});
