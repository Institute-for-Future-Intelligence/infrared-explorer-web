import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_FIGURE_RENDER_MAX, splitReportFigures } from './reportFigures';

describe('splitReportFigures', () => {
  it('splits a report around a well-formed marker', () => {
    const segs = splitReportFigures('### Observations\nThe pot warms.\n[figure: t = 48 s | The peak.]\nThen it cools.');
    assert.equal(segs.length, 3);
    assert.deepEqual(segs[1], { kind: 'figure', tSeconds: 48, caption: 'The peak.' });
    assert.equal(segs[0].kind, 'md');
    assert.match((segs[0] as { text: string }).text, /The pot warms\./);
    assert.match((segs[2] as { text: string }).text, /Then it cools\./);
  });

  it('accepts decimal times, loose spacing, mixed case, and a missing caption', () => {
    const segs = splitReportFigures('[FIGURE:t=9.6s]\n[ Figure : t = 0 s |  scene at the start ]');
    assert.deepEqual(segs, [
      { kind: 'figure', tSeconds: 9.6, caption: '' },
      { kind: 'figure', tSeconds: 0, caption: 'scene at the start' },
    ]);
  });

  it('leaves a marker that is not alone on its line as markdown text', () => {
    const segs = splitReportFigures('See [figure: t = 48 s | peak] here.');
    assert.deepEqual(segs, [{ kind: 'md', text: 'See [figure: t = 48 s | peak] here.' }]);
  });

  it('leaves malformed markers as text', () => {
    for (const bad of ['[figure: t = 48]', '[figure: 48 s]', '[figure: t = -3 s]', '[figure t = 48 s]']) {
      assert.deepEqual(splitReportFigures(bad), [{ kind: 'md', text: bad }], bad);
    }
  });

  it('renders at most REPORT_FIGURE_RENDER_MAX figures and keeps the rest as text', () => {
    const lines = Array.from({ length: REPORT_FIGURE_RENDER_MAX + 2 }, (_, i) => `[figure: t = ${i} s | f${i}]`);
    const segs = splitReportFigures(lines.join('\n'));
    assert.equal(segs.filter((s) => s.kind === 'figure').length, REPORT_FIGURE_RENDER_MAX);
    const tail = segs[segs.length - 1];
    assert.equal(tail.kind, 'md');
    assert.match((tail as { text: string }).text, /f6/);
  });

  it('a report with no markers comes back as one md segment, byte-identical', () => {
    const report = '### Title\nplain text with t = 48 s cited inline.';
    assert.deepEqual(splitReportFigures(report), [{ kind: 'md', text: report }]);
  });

  it('an unclosed marker followed by a whitespace run parses in linear time (no backtracking blowup)', () => {
    const evil = '[figure: t = 48 s |' + ' '.repeat(5000) + 'x';
    const started = Date.now();
    const segs = splitReportFigures(evil);
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
    assert.deepEqual(segs, [{ kind: 'md', text: evil }]);
  });

  it('a marker line with \\r\\n endings still parses (trailing \\r eaten by the tail whitespace)', () => {
    const segs = splitReportFigures('before\r\n[figure: t = 48 s | peak]\r\nafter');
    assert.equal(segs.length, 3);
    assert.deepEqual(segs[1], { kind: 'figure', tSeconds: 48, caption: 'peak' });
  });
});
