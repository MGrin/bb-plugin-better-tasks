// A fixed-height-per-item virtual list: only the rows in (and just around)
// the viewport exist in the DOM, positioned with transforms.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { prefixOffsets, scrollToReveal, windowRange } from "@/lib/virtual";
import { cn } from "@/lib/utils";

export interface VirtualListProps<T> {
  items: readonly T[];
  heightOf: (item: T) => number;
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  /** Scroll this index into view whenever it changes. */
  revealIndex?: number | null;
  overscan?: number;
  className?: string;
  /** Padding inside the scroller, below the last item. */
  endPadding?: number;
  label?: string;
}

export function VirtualList<T>({
  items,
  heightOf,
  keyOf,
  render,
  revealIndex = null,
  overscan = 10,
  className,
  endPadding = 0,
  label,
}: VirtualListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);
  const frame = useRef<number | null>(null);

  const offsets = useMemo(
    () => prefixOffsets(items.length, (index) => heightOf(items[index]!)),
    [items, heightOf],
  );
  const total = offsets[offsets.length - 1] ?? 0;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    setViewport(element.clientHeight);
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const element = scroller.current;
      if (element !== null) setScrollTop(element.scrollTop);
    });
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || revealIndex === null || revealIndex < 0) return;
    const next = scrollToReveal(offsets, revealIndex, element.scrollTop, element.clientHeight);
    if (next !== null) {
      element.scrollTop = next;
      setScrollTop(next);
    }
    // Reveal follows the index, not every change in item heights.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealIndex]);

  const [start, end] = windowRange(offsets, scrollTop, viewport, overscan);
  const children: ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    const item = items[index]!;
    children.push(
      <div
        key={keyOf(item)}
        className="absolute inset-x-0 top-0"
        style={{ height: offsets[index + 1]! - offsets[index]!, transform: `translateY(${offsets[index]}px)` }}
      >
        {render(item, index)}
      </div>,
    );
  }

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      aria-label={label}
      className={cn("min-h-0 overflow-y-auto overscroll-contain [contain:strict]", className)}
    >
      <div className="relative w-full" style={{ height: total + endPadding }}>
        {children}
      </div>
    </div>
  );
}
