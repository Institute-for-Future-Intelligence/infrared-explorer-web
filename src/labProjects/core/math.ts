/*
 * The website's stand-in for the app's lib/labProjects/math.ts, behind the
 * same names, so the synced copies beside it (reportExport.ts) compile
 * unchanged. NOT synced by scripts/sync-lab-core.mjs: this file is the
 * website's own.
 *
 * The app draws a formula with MathJax as an SVG of paths (no font to ship,
 * and one picture for the phone and the printed page alike). The website
 * already renders LaTeX with KaTeX (utils/markdown.ts), so a formula here is
 * KaTeX's output. The one caller of this module, reportExport.ts, drops the
 * result into a page of its own that is printed — a page that carries no
 * stylesheet of ours — so the formula is rendered as MathML, which the
 * browser draws without KaTeX's CSS (Chrome 109+, Firefox, Safari). The
 * on-screen renderer (labProjects/MarkdownView.tsx) calls KaTeX itself, with
 * its HTML output and the KaTeX stylesheet main.tsx imports.
 *
 * `svg` therefore holds MathML, not SVG; the ex sizes the app reports are
 * meaningless for it and come back as 0 — nothing on the website reads them.
 */

import katex from 'katex';

export interface MathSvg {
  /** The formula's markup (MathML on the website, an <svg> on the phone). */
  svg: string;
  widthEx: number;
  heightEx: number;
  depthEx: number;
}

/** Kept for the app's callers; an ex is half the font size. */
export const EX_PER_FONT_SIZE = 0.5;

const cache = new Map<string, MathSvg | null>();
const CACHE_MAX = 300;

/**
 * One formula as markup, or null when it does not parse (the caller shows
 * the source). `display` draws it as a line of its own.
 */
export function texToSvg(tex: string, display: boolean): MathSvg | null {
  const source = tex.trim();
  if (!source) {
    return null;
  }
  const key = `${display ? 'D' : 'I'}${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  let out: MathSvg | null = null;
  try {
    const html = katex.renderToString(source, { displayMode: display, throwOnError: true, output: 'mathml' });
    out = html ? { svg: html, widthEx: 0, heightEx: 0, depthEx: 0 } : null;
  } catch {
    out = null;
  }
  if (cache.size >= CACHE_MAX) {
    cache.clear();
  }
  cache.set(key, out);
  return out;
}
