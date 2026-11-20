import { describe, it, expect } from 'vitest';
import { labelledFirst } from '../e2e/harness/labelled-first.ts';

// On the iPhone a control and the elements around or inside it can be drawn in one place: the one named is the one
// the page labels with that name itself (shyden-labs/shydesk#144).
describe('labelledFirst', () => {
  it('keeps the button labelled with the name, not the picture inside it', () => {
    expect(labelledFirst('Open photo 3', [0, 1], [['Open photo 3'], ['Attachment preview 3', 'Attachment preview 3']])).toEqual([0]);
  });

  it('keeps the picture labelled with the name, not the stage around it', () => {
    expect(labelledFirst('Photo 3 full size', [0, 1], [['Viewer stage'], ['Photo 3 full size']])).toEqual([1]);
  });

  it('matches a label by its text with the spaces around it trimmed', () => {
    expect(labelledFirst('Send', [0, 1], [['  Send '], ['Form']])).toEqual([0]);
  });

  it('keeps every match when the page labels none of them with the name, such as a field named by its label', () => {
    expect(labelledFirst('Email', [2, 3], [[], [], ['Your email'], []])).toEqual([2, 3]);
  });

  it('keeps every match the page labels with the name, so two still fail as two', () => {
    expect(labelledFirst('Send', [0, 1], [['Send'], ['Send']])).toEqual([0, 1]);
  });

  it('keeps nothing when nothing matched', () => {
    expect(labelledFirst('Send', [], [['Send']])).toEqual([]);
  });
});
