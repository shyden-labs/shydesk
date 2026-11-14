/**
 * The matched candidates that no other matched candidate holds. `parentOf[i]`
 * is the index of candidate `i`'s nearest candidate ancestor, or -1. On the
 * iPhone a control and the elements inside it are drawn in one place and iOS
 * names them all by the control, so the one named is the outermost
 * (shyden-labs/shydesk#144).
 */
export function outermost(matched: number[], parentOf: number[]): number[] {
  const chosen = new Set(matched);
  return matched.filter((index) => {
    for (let up = parentOf[index] ?? -1; up !== -1; up = parentOf[up] ?? -1) if (chosen.has(up)) return false;
    return true;
  });
}
