import { useEffect, useState, type RefObject } from 'react';

/** An element's size, kept current as it resizes, so a drawing can be made at its real pixels. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    setSize({ width: box.width, height: box.height });
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize((current) => (current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
