import { describe, it, expect } from 'vitest';
import { colourOf, contrastRatio, gradientColours } from '../e2e/harness/contrast.ts';

// The e2e suite measures how readable typed text is from the browser's computed colours (shyden-labs/shydesk#282).
describe('colourOf', () => {
  it('reads an rgb() colour', () => {
    expect(colourOf('rgb(27, 27, 31)')).toEqual([27, 27, 31]);
  });

  it('reads an rgba() colour that is fully opaque', () => {
    expect(colourOf('rgba(255, 255, 255, 1)')).toEqual([255, 255, 255]);
  });

  it('reads the space-separated form some browsers give', () => {
    expect(colourOf('rgb(0 128 255)')).toEqual([0, 128, 255]);
  });

  it('refuses a colour that is not fully opaque, naming it, since its contrast depends on what lies under it', () => {
    expect(() => colourOf('rgba(0, 0, 0, 0)')).toThrow('"rgba(0, 0, 0, 0)" is not a fully opaque colour');
  });

  it('refuses what is not a colour, naming it', () => {
    expect(() => colourOf('none')).toThrow('"none" is not a fully opaque colour');
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeCloseTo(21, 5);
  });

  it('is 1 for a colour on itself', () => {
    expect(contrastRatio('rgb(120, 40, 200)', 'rgb(120, 40, 200)')).toBe(1);
  });

  it('is the same whichever colour comes first', () => {
    expect(contrastRatio('rgb(255, 255, 255)', 'rgb(27, 27, 31)')).toBe(contrastRatio('rgb(27, 27, 31)', 'rgb(255, 255, 255)'));
  });

  it("matches WCAG's figure for mid grey on white", () => {
    // Grey 119, 119, 119 on white is 4.48:1 in WCAG 2's relative-luminance formula.
    expect(contrastRatio('rgb(119, 119, 119)', 'rgb(255, 255, 255)')).toBeCloseTo(4.48, 2);
  });

  it('uses the linear part of the curve for very dark channels', () => {
    // Grey 5, 5, 5 sits under the 0.03928 knee: luminance 5/255/12.92, so 1.05 / (0.05 + 0.0015176) = 20.38.
    expect(contrastRatio('rgb(5, 5, 5)', 'rgb(255, 255, 255)')).toBeCloseTo(20.38, 2);
  });
});

describe('gradientColours', () => {
  it("lists every colour in a computed background-image, such as the select's drawn arrow", () => {
    const image =
      'linear-gradient(45deg, rgba(0, 0, 0, 0) 50%, rgb(27, 27, 31) 50%), linear-gradient(135deg, rgb(27, 27, 31) 50%, rgba(0, 0, 0, 0) 50%)';
    expect(gradientColours(image)).toEqual(['rgba(0, 0, 0, 0)', 'rgb(27, 27, 31)', 'rgb(27, 27, 31)', 'rgba(0, 0, 0, 0)']);
  });

  it('lists nothing for no image', () => {
    expect(gradientColours('none')).toEqual([]);
  });
});
