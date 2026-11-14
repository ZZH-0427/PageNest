import { abortError } from "./types";

interface Job {
  signal: AbortSignal;
  start: () => Promise<void>;
  cancel: () => void;
}

/** A cancelled queued job never starts; active slots remain occupied until cleanup finishes. */
export class TaskQueue {
  private active = 0;
  private pending: Job[] = [];

  constructor(private readonly limit: number) {}

  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        signal,
        cancel: () => {
          this.pending = this.pending.filter((item) => item !== job);
          signal.removeEventListener("abort", job.cancel);
          reject(abortError());
        },
        start: async () => {
          signal.removeEventListener("abort", job.cancel);
          try {
            signal.throwIfAborted();
            resolve(await work());
          } catch (error) {
            reject(error);
          }
        },
      };
      this.pending.push(job);
      signal.addEventListener("abort", job.cancel, { once: true });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.pending.length) {
      const job = this.pending.shift()!;
      if (job.signal.aborted) {
        job.cancel();
        continue;
      }
      this.active++;
      void job.start().finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
