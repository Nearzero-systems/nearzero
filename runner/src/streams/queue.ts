/**
 * A queue that one side pushes into and the other reads as an async iterable. Used where a
 * callback API (sockets, child processes) has to become a stream.
 */
export class PushQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | null = null;
  #ended = false;
  #error: unknown = null;

  push(item: T): void {
    if (this.#ended) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    if (error !== undefined) this.#error = error;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: undefined as T, done: true });
    }
  }

  get ended(): boolean {
    return this.#ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) {
          if (this.#error !== null) {
            const error = this.#error;
            this.#error = null;
            return Promise.reject(error);
          }
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as T, done: true });
      },
    };
  }
}
