import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportHeadings } from './reportHeadings';

describe('normalizeReportHeadings', () => {
  it('leaves a report already in the new shape untouched', () => {
    const report = '# Cooling of a steel mug\n\n## Experimental setup\nText.\n\n## Observations\nMore.';
    assert.equal(normalizeReportHeadings(report), report);
  });

  it('converts the old "Suggested title" shape into a real title plus level-2 sections', () => {
    const old = [
      '### Suggested title',
      'Cooling of boiled water in a steel mug',
      '',
      '### Experimental setup',
      'Two probes.',
      '',
      '### Observations',
      'It cooled.',
    ].join('\n');
    const out = normalizeReportHeadings(old).split('\n');
    assert.equal(out[0], ''); // the label line is gone, not left as text
    assert.equal(out[1], '# Cooling of boiled water in a steel mug');
    assert.ok(out.includes('## Experimental setup'));
    assert.ok(out.includes('## Observations'));
    assert.ok(!normalizeReportHeadings(old).toLowerCase().includes('suggested title'));
  });

  it('strips bold from a promoted title line', () => {
    const out = normalizeReportHeadings('### Title\n**Heat flow along a copper bar**\n\n### Observations\nx');
    assert.ok(out.includes('# Heat flow along a copper bar'));
    assert.ok(!out.includes('**'));
  });

  it('lifts an all-### report with no title label so its sections become level 2', () => {
    const out = normalizeReportHeadings('### Experimental setup\na\n\n### Observations\nb');
    assert.equal(out, '## Experimental setup\na\n\n## Observations\nb');
  });

  it('preserves relative depth: a sub-heading stays one level below its section', () => {
    const out = normalizeReportHeadings('## Observations\na\n\n### Phase one\nb');
    assert.equal(out, '## Observations\na\n\n### Phase one\nb');
    const lifted = normalizeReportHeadings('### Observations\na\n\n#### Phase one\nb');
    assert.equal(lifted, '## Observations\na\n\n### Phase one\nb');
  });

  it('keeps the label line dropped when no title text follows it', () => {
    const out = normalizeReportHeadings('### Suggested title\n\n### Observations\nb');
    assert.ok(!out.toLowerCase().includes('suggested title'));
    assert.ok(out.includes('## Observations'));
  });

  it('never touches non-heading lines (figure markers, tables, prose with #)', () => {
    const report = '# Cooling of a mug\n\n## Observations\n[figure: t = 48 s | peak]\n| a | b |\nsee #1 below';
    assert.equal(normalizeReportHeadings(report), report);
  });

  it('repairs a level-1 heading that is only a placeholder word', () => {
    // "# Title" is the placeholder the prompt forbids; the real title is the line under it.
    const out = normalizeReportHeadings('# Title\nHeat loss through a window\n\n## Observations\nx');
    assert.ok(out.includes('# Heat loss through a window'));
    assert.ok(!/^#\s*Title\s*$/m.test(out));
  });

  it('returns a report with no headings unchanged', () => {
    assert.equal(normalizeReportHeadings('just prose\nand more'), 'just prose\nand more');
  });
});
