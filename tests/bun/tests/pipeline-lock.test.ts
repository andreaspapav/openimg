import { expect, test } from "bun:test";
import { PipelineLock } from "../../../packages/core/src/utils.ts";

function settled(p: Promise<void>) {
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 20)),
  ]);
}

test("PipelineLock: a replaced lock still settles when its owner resolves", async () => {
  const lock = new PipelineLock();
  const tokenA = lock.add("a.webp");
  const waitingOnA = lock.get("a.webp")!;
  const tokenB = lock.add("a.webp"); // replaces A as the current lock
  const waitingOnB = lock.get("a.webp")!;

  lock.resolve("a.webp", tokenA);
  expect(await settled(waitingOnA)).toBe(true);
  // A's owner must not release B's lock
  expect(await settled(waitingOnB)).toBe(false);
  expect(lock.get("a.webp")).toBe(waitingOnB);

  lock.resolve("a.webp", tokenB);
  expect(await settled(waitingOnB)).toBe(true);
  expect(lock.get("a.webp")).toBeNull();
});

test("PipelineLock: resolve without a token releases the current lock (node)", async () => {
  const lock = new PipelineLock();
  lock.add("b.webp");
  const waiting = lock.get("b.webp")!;
  lock.resolve("b.webp");
  expect(await settled(waiting)).toBe(true);
  expect(lock.get("b.webp")).toBeNull();
});

test("PipelineLock: resolving twice is a no-op", async () => {
  const lock = new PipelineLock();
  const token = lock.add("c.webp", { deferTimeout: true });
  lock.startTimeout(token);
  lock.resolve("c.webp", token);
  lock.resolve("c.webp", token);
  const tokenNext = lock.add("c.webp");
  lock.resolve("c.webp", token); // stale token must not release the new lock
  expect(lock.get("c.webp")).not.toBeNull();
  lock.resolve("c.webp", tokenNext);
});
