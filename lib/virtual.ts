// Windowing math for the virtualized list and board columns.

/** Prefix offsets: offsets[i] is the top of item i; the last entry is the total height. */
export function prefixOffsets(count: number, heightOf: (index: number) => number): number[] {
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let index = 0; index < count; index += 1) {
    offsets[index + 1] = offsets[index]! + heightOf(index);
  }
  return offsets;
}

/** The first item whose bottom is below `y`. */
export function indexAt(offsets: readonly number[], y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1]! <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The [start, end) range of items to render for a viewport. */
export function windowRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): [number, number] {
  const count = offsets.length - 1;
  if (count <= 0) return [0, 0];
  const first = indexAt(offsets, Math.max(0, scrollTop));
  const last = indexAt(offsets, scrollTop + viewport);
  return [Math.max(0, first - overscan), Math.min(count, last + 1 + overscan)];
}

/** The scrollTop that brings item `index` fully into view, or null if it already is. */
export function scrollToReveal(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewport: number,
  stickyTop = 0,
): number | null {
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (top === undefined || bottom === undefined) return null;
  if (top - stickyTop < scrollTop) return Math.max(0, top - stickyTop);
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return null;
}
