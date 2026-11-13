/** Sorted keys for deterministic iteration. */
export const sortedIds = <T>(map: ReadonlyMap<string, T>): string[] => [...map.keys()].toSorted();
