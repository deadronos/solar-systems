import { useEffect, useRef, useState } from 'react';

/**
 * Re-read a derived value at a fixed cadence; re-renders only when `key(value)` changes.
 * The simulation advances every frame; the React tree doesn't need to.
 */
export function usePolledKeyed<T>(read: () => T, key: (v: T) => string, hz = 2): T {
  const [value, setValue] = useState(read);
  const last = useRef(key(value));
  const readRef = useRef(read);
  const keyRef = useRef(key);
  useEffect(() => {
    readRef.current = read;
    keyRef.current = key;
  });
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = readRef.current();
      const k = keyRef.current(v);
      if (k !== last.current) {
        last.current = k;
        setValue(v);
      }
    }, 1000 / hz);
    return () => window.clearInterval(id);
  }, [hz]);
  return value;
}
