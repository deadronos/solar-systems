interface Entry<T> {
  jd: number;
  seq: number;
  item: T;
}

/** Binary min-heap ordered by (jd, insertion order). Deterministic for equal times. */
export class Scheduler<T> {
  #heap: Entry<T>[] = [];
  #seq = 0;

  get size(): number {
    return this.#heap.length;
  }

  schedule(jd: number, item: T): void {
    this.#heap.push({ jd, seq: this.#seq++, item });
    this.#up(this.#heap.length - 1);
  }

  peekJd(): number | undefined {
    return this.#heap[0]?.jd;
  }

  /** Remove and return the earliest item due at or before `jd`. */
  popDue(jd: number): T | undefined {
    const top = this.#heap[0];
    if (!top || top.jd > jd) return undefined;
    const last = this.#heap.pop()!;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#down(0);
    }
    return top.item;
  }

  #less(a: Entry<T>, b: Entry<T>): boolean {
    return a.jd < b.jd || (a.jd === b.jd && a.seq < b.seq);
  }

  #up(i: number): void {
    const h = this.#heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  #down(i: number): void {
    const h = this.#heap;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && this.#less(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.#less(h[r]!, h[m]!)) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
}
