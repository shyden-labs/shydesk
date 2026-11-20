/**
 * Of the `matched` candidates drawn where iOS shows a control named `label`,
 * the ones the page itself labels with that name (`labels[i]`: candidate
 * `i`'s `aria-label`, `alt` and text). A control and the elements around or
 * inside it can be drawn in one place, such as a button and its picture or a
 * picture and the stage holding it (shyden-labs/shydesk#144). When the page
 * labels none of them with the name (a field named by its `<label>`), every
 * match is kept, so more than one still fails as more than one.
 */
export function labelledFirst(label: string, matched: number[], labels: string[][]): number[] {
  const labelled = matched.filter((index) => (labels[index] ?? []).some((own) => own.trim() === label));
  return labelled.length > 0 ? labelled : matched;
}
