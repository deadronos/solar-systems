const cache = new WeakMap<ReadonlyMap<string, unknown>, readonly string[]>();

/**
 * Sorted keys for deterministic iteration. Phases call this for the same maps every tick, so
 * the last result is reused while the key set is unchanged: equal size plus every cached key
 * still present proves that. A changed set gets a fresh array, so a caller iterating the old
 * one while deleting entries is unaffected. Don't mutate the result.
 */
export function sortedIds<T>(map: ReadonlyMap<string, T>): readonly string[] {
  const cached = cache.get(map);
  if (cached && cached.length === map.size && cached.every((id) => map.has(id))) return cached;
  const ids = Object.freeze([...map.keys()].toSorted());
  cache.set(map, ids);
  return ids;
}
