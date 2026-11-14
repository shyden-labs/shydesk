import { describe, it, expect } from 'vitest';
import { outermost } from '../e2e/harness/outermost.ts';

// On the iPhone a control and the elements inside it are drawn in one place, and iOS names them all by the
// control: the one named is the outermost (shyden-labs/shydesk#144).
describe('outermost', () => {
  it('keeps a button and drops the picture inside it', () => {
    // 0: the button, 1: its picture.
    expect(outermost([0, 1], [-1, 0])).toEqual([0]);
  });

  it('drops an element inside a matched one at any depth', () => {
    // 0 holds 1, which holds 2.
    expect(outermost([0, 2], [-1, 0, 1])).toEqual([0]);
  });

  it('keeps an element whose candidate ancestor was not matched', () => {
    expect(outermost([1], [-1, 0])).toEqual([1]);
  });

  it('keeps two matched elements that do not hold each other', () => {
    expect(outermost([1, 2], [-1, 0, 0])).toEqual([1, 2]);
  });

  it('keeps nothing when nothing matched', () => {
    expect(outermost([], [-1])).toEqual([]);
  });
});
