/**
 * Ramer–Douglas–Peucker simplification for flat `[x, y, p, ...]` strokes that
 * also preserves pressure changes: a point is kept when either its spatial
 * distance from the chord or its pressure deviation from the linearly
 * interpolated pressure exceeds the respective tolerance.
 *
 * Iterative (explicit stack) so long strokes cannot overflow the call stack.
 */
export function simplifyStroke(
  flat: readonly number[],
  tolerance: number,
  pressureTolerance = 0.06,
): number[] {
  const n = flat.length / 3;
  if (n <= 2 || tolerance <= 0) return flat.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    if (last - first < 2) continue;
    const ax = flat[first * 3]!;
    const ay = flat[first * 3 + 1]!;
    const ap = flat[first * 3 + 2]!;
    const bx = flat[last * 3]!;
    const by = flat[last * 3 + 1]!;
    const bp = flat[last * 3 + 2]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstScore = 1;
    for (let i = first + 1; i < last; i++) {
      const px = flat[i * 3]!;
      const py = flat[i * 3 + 1]!;
      const pp = flat[i * 3 + 2]!;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.min(1, Math.max(0, t));
      const cx = ax + dx * t;
      const cy = ay + dy * t;
      const dist = Math.hypot(px - cx, py - cy);
      const frac = (i - first) / (last - first);
      const pDev = Math.abs(pp - (ap + (bp - ap) * frac));
      const score = Math.max(dist / tolerance, pDev / pressureTolerance);
      if (score > worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!);
  }
  return out;
}
