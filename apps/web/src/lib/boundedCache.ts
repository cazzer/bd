// A small least-recently-used map: reading or writing a key makes it the
// newest, and writing past `capacity` evicts the oldest. SearchView keeps
// its last few answers here so back/forward to a results address renders
// at once; nothing about it is search-specific.

export class BoundedCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }
}
