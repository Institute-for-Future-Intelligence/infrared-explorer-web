/**
 * Tests for the Q&A moment capture validator.
 *
 * This is the only image a client can push into a prompt, so the properties worth pinning are the
 * refusals: a document type dressed as an image (SVG), a label that doesn't match the encoding, padding
 * or whitespace smuggled into the payload, and anything over the size ceiling. A capture that survives is
 * handed to a model provider verbatim, so "parses" has to mean "is exactly a base64 PNG/JPEG data URL".
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_MAX_CHARS, parseCaptureImage, parseCaptureView } from './clientCapture';

const dataUrl = (type: string, data = 'AAAA') => `data:${type};base64,${data}`;

describe('parseCaptureImage', () => {
  it('accepts a PNG data URL and strips the header', () => {
    assert.deepEqual(parseCaptureImage(dataUrl('image/png', 'iVBORw0KGgo=')), {
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
    });
  });

  it('accepts a JPEG data URL', () => {
    assert.deepEqual(parseCaptureImage(dataUrl('image/jpeg', '/9j/4AAQ')), {
      data: '/9j/4AAQ',
      mediaType: 'image/jpeg',
    });
  });

  it('refuses image types the browser canvas never produces', () => {
    for (const type of ['image/gif', 'image/webp', 'image/svg+xml', 'image/png;charset=utf-8', 'text/html']) {
      assert.equal(parseCaptureImage(dataUrl(type)), null, type);
    }
  });

  it('refuses a payload that is not plain base64', () => {
    // Whitespace / newlines (a multiline data URL), URL-safe base64, padding in the middle, and an empty
    // payload: each would reach the provider as a body that does not decode to the labelled image.
    for (const data of ['AA AA', 'AA\nAA', 'AA-_', 'AA=AA', 'AAAA===', '']) {
      assert.equal(parseCaptureImage(dataUrl('image/png', data)), null, JSON.stringify(data));
    }
  });

  it('refuses anything that is not a data URL at all', () => {
    for (const value of ['https://example.com/frame.png', 'iVBORw0KGgo=', '', 'data:image/png,AAAA']) {
      assert.equal(parseCaptureImage(value), null, value);
    }
  });

  it('refuses non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['data:image/png;base64,AAAA']]) {
      assert.equal(parseCaptureImage(value), null, String(value));
    }
  });

  it('refuses a capture over the size ceiling, and accepts one at it', () => {
    const header = 'data:image/png;base64,';
    const atCap = header + 'A'.repeat(CAPTURE_MAX_CHARS - header.length);
    assert.equal(atCap.length, CAPTURE_MAX_CHARS);
    assert.equal(parseCaptureImage(atCap)?.mediaType, 'image/png');
    assert.equal(parseCaptureImage(atCap + 'A'), null);
  });
});

describe('parseCaptureView', () => {
  it('passes through the two non-default views', () => {
    assert.equal(parseCaptureView('visible'), 'visible');
    assert.equal(parseCaptureView('blended'), 'blended');
  });

  it('falls back to the thermal view for anything else', () => {
    for (const value of ['ir', 'thermal', '', undefined, null, 7, {}]) {
      assert.equal(parseCaptureView(value), 'ir', String(value));
    }
  });
});
