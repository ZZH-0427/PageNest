import { describe, expect, it, vi } from "vitest";
import { TaskQueue } from "./task-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("PDF task queue", () => {
  it("runs at most two jobs and starts waiting work only when a slot completes", async () => {
    const queue = new TaskQueue(2);
    const first = deferred<number>();
    const second = deferred<number>();
    const third = vi.fn(async () => 3);
    const signal = new AbortController().signal;
    const results = [queue.run(() => first.promise, signal), queue.run(() => second.promise, signal), queue.run(third, signal)];
    expect(third).not.toHaveBeenCalled();
    first.resolve(1);
    await vi.waitFor(() => expect(third).toHaveBeenCalledOnce());
    second.resolve(2);
    await expect(Promise.all(results)).resolves.toEqual([1, 2, 3]);
  });

  it("removes a cancelled waiting job without starting it or consuming a slot", async () => {
    const queue = new TaskQueue(1);
    const running = deferred<void>();
    const cancelled = new AbortController();
    const shouldNotRun = vi.fn(async () => "cancelled");
    const following = vi.fn(async () => "next");
    const first = queue.run(() => running.promise, new AbortController().signal);
    const skipped = queue.run(shouldNotRun, cancelled.signal).catch((error: Error) => error.name);
    const next = queue.run(following, new AbortController().signal);
    cancelled.abort();
    await expect(skipped).resolves.toBe("AbortError");
    expect(shouldNotRun).not.toHaveBeenCalled();
    expect(following).not.toHaveBeenCalled();
    running.resolve();
    await first;
    await expect(next).resolves.toBe("next");
  });

  it("retains an active slot while cancelled work is finishing its cleanup", async () => {
    const queue = new TaskQueue(1);
    const cleanup = deferred<void>();
    const controller = new AbortController();
    const first = queue.run(async () => {
      await cleanup.promise;
      controller.signal.throwIfAborted();
    }, controller.signal).catch((error: Error) => error.name);
    const nextWork = vi.fn(async () => "released");
    const next = queue.run(nextWork, new AbortController().signal);
    controller.abort();
    await Promise.resolve();
    expect(nextWork).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(first).resolves.toBe("AbortError");
    await expect(next).resolves.toBe("released");
  });

  it("rejects an already cancelled job and recovers after a work failure", async () => {
    const queue = new TaskQueue(1);
    const cancelled = new AbortController();
    cancelled.abort();
    const work = vi.fn(async () => 1);
    await expect(queue.run(work, cancelled.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(work).not.toHaveBeenCalled();
    const failure = deferred<void>();
    const failed = queue.run(() => failure.promise, new AbortController().signal).catch(() => "failed");
    const next = queue.run(work, new AbortController().signal);
    failure.reject(new Error("Synthetic task failure"));
    await expect(failed).resolves.toBe("failed");
    await expect(next).resolves.toBe(1);
  });
});
