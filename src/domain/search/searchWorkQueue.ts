/** A pending item has a monotone lower bound on its total operation cost. */
export interface SearchWork {
  lowerBound: number
  settle(): void | Promise<void>
}

/**
 * Min-heap of actual pending work, not a loop over configured empty layers.
 * A popped item is removed before it settles; newly discovered work is queued
 * explicitly and can never precede the current lower bound.
 */
export class SearchWorkQueue {
  private readonly heap: Array<SearchWork & { sequence: number }> = []
  private sequence = 0
  private currentBound = 0

  get pendingCount(): number { return this.heap.length }
  get nextLowerBound(): number | null { return this.heap[0]?.lowerBound ?? null }

  private before(a: SearchWork & { sequence: number }, b: SearchWork & { sequence: number }): boolean {
    return a.lowerBound < b.lowerBound || (a.lowerBound === b.lowerBound && a.sequence < b.sequence)
  }

  enqueue(work: SearchWork): void {
    if (!Number.isFinite(work.lowerBound) || work.lowerBound < this.currentBound) {
      throw new Error('Search work must preserve the monotone operation lower bound.')
    }
    const entry = { ...work, sequence: this.sequence++ }
    this.heap.push(entry)
    let index = this.heap.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!this.before(entry, this.heap[parent])) break
      this.heap[index] = this.heap[parent]
      index = parent
    }
    this.heap[index] = entry
  }

  async settleNext(): Promise<void> {
    const first = this.heap[0]
    if (!first) return
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      let index = 0
      while (2 * index + 1 < this.heap.length) {
        let child = 2 * index + 1
        if (child + 1 < this.heap.length && this.before(this.heap[child + 1], this.heap[child])) child += 1
        if (!this.before(this.heap[child], last)) break
        this.heap[index] = this.heap[child]
        index = child
      }
      this.heap[index] = last
    }
    this.currentBound = first.lowerBound
    await first.settle()
  }
}
