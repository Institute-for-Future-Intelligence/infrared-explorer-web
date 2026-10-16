/*
 * Draws the Markdown the AI writes in a project (the plan, the report, its
 * replies) from the structures core/markdown.ts reads — the same reader the
 * app uses, so a text looks the same in both places. Pictures written as
 * ![caption](image:ID) resolve through `images` and open the viewer on a
 * click; a plain https picture shows as it is. Mathematics renders with
 * KaTeX (its stylesheet is imported in main.tsx). Links open in a new tab.
 */

import { useMemo } from 'react';
import katex from 'katex';
import styled from 'styled-components';
import { parseMarkdown, type MdBlock, type MdSpan } from './core/markdown';
import type { ProjectImage } from './core/types';

/** One formula as KaTeX HTML; a formula that does not parse renders as KaTeX's own red source. */
function renderTex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    return '';
  }
}

const Md = styled.div<{ $compact?: boolean }>`
  color: var(--ifi-ink);
  font-size: ${(p) => (p.$compact ? 14 : 15)}px;
  line-height: 1.55;
  word-break: break-word;
  min-width: 0;

  h1,
  h2,
  h3 {
    color: var(--ifi-ink);
    font-weight: 700;
    line-height: 1.3;
  }
  h1 {
    font-size: ${(p) => (p.$compact ? 18 : 22)}px;
    margin: 14px 0 8px;
  }
  h2 {
    font-size: ${(p) => (p.$compact ? 16 : 18)}px;
    margin: 12px 0 6px;
  }
  h3 {
    font-size: ${(p) => (p.$compact ? 15 : 16)}px;
    font-weight: 600;
    margin: 10px 0 4px;
  }
  > :first-child {
    margin-top: 0;
  }
  > :last-child {
    margin-bottom: 0;
  }
  p {
    margin: 0 0 8px;
  }
  strong {
    font-weight: 700;
  }
  em {
    font-style: italic;
  }
  code {
    font-family: var(--ifi-font-mono);
    font-size: 0.92em;
    background: var(--ifi-fill-1);
    border-radius: 4px;
    padding: 0 4px;
  }
  a {
    color: var(--ifi-teal-dark);
    text-decoration: underline;
  }
  .md-list {
    margin: 0 0 8px;
  }
  .md-item {
    display: flex;
    gap: 6px;
    margin-bottom: 3px;
  }
  .md-marker {
    flex: none;
    min-width: 18px;
    text-align: right;
    color: var(--ifi-text-secondary);
  }
  .md-item > span:last-child {
    flex: 1;
    min-width: 0;
  }
  .md-table {
    overflow-x: auto;
    margin: 0 0 10px;
  }
  table {
    border-collapse: collapse;
    min-width: 100%;
  }
  th,
  td {
    border: 1px solid var(--ifi-stroke-2);
    padding: 5px 9px;
    text-align: left;
    vertical-align: top;
    font-size: 0.95em;
  }
  th {
    background: var(--ifi-fill-1);
    font-weight: 600;
  }
  pre {
    font-family: var(--ifi-font-mono);
    font-size: 13px;
    line-height: 1.45;
    background: var(--ifi-fill-1);
    border-radius: 6px;
    padding: 10px;
    margin: 0 0 8px;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  blockquote {
    margin: 0 0 8px;
    padding-left: 10px;
    border-left: 3px solid var(--ifi-stroke-2);
    color: var(--ifi-text-secondary);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--ifi-stroke-1);
    margin: 12px 0;
  }
  figure {
    margin: 8px 0;
    background: var(--ifi-fill-1);
    border-radius: 8px;
    overflow: hidden;
  }
  figure.md-clickable {
    cursor: zoom-in;
  }
  figure img {
    display: block;
    width: 100%;
    max-height: 420px;
    object-fit: contain;
    background: var(--ifi-fill-1);
  }
  figcaption {
    color: var(--ifi-text-tertiary);
    font-size: 12px;
    padding: 6px 10px;
  }
  .md-missing {
    color: var(--ifi-text-tertiary);
    font-size: 12px;
    margin: 6px 0;
  }
  .md-math-block {
    margin: 6px 0 10px;
    overflow-x: auto;
    text-align: center;
  }
  .katex-display {
    margin: 0;
  }
`;

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.k) {
          case 'b':
            return <strong key={i}>{s.s}</strong>;
          case 'i':
            return <em key={i}>{s.s}</em>;
          case 'bi':
            return (
              <strong key={i}>
                <em>{s.s}</em>
              </strong>
            );
          case 'code':
            return <code key={i}>{s.s}</code>;
          case 'link':
            return (
              <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
                {s.s}
              </a>
            );
          case 'math':
            return <span key={i} className="md-math" dangerouslySetInnerHTML={{ __html: renderTex(s.s, false) }} />;
          default:
            return <span key={i}>{s.s}</span>;
        }
      })}
    </>
  );
}

function ImageBlock({
  block,
  images,
  onOpenImage,
}: {
  block: Extract<MdBlock, { kind: 'image' }>;
  images: ProjectImage[];
  onOpenImage?: (img: ProjectImage) => void;
}) {
  const img = block.imageId ? images.find((i) => i.id === block.imageId) : undefined;
  const url = img?.url ?? block.url;
  const caption = block.caption || img?.caption || '';
  if (!url) {
    return <p className="md-missing">[picture not available: {caption}]</p>;
  }
  const clickable = !!img && !!onOpenImage;
  return (
    <figure
      className={clickable ? 'md-clickable' : undefined}
      onClick={clickable ? () => onOpenImage(img) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenImage(img);
              }
            }
          : undefined
      }
    >
      <img src={url} alt={caption || 'Picture'} loading="lazy" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

const MarkdownView = ({
  markdown,
  images = [],
  onOpenImage,
  compact = false,
  className,
}: {
  markdown: string;
  images?: ProjectImage[];
  onOpenImage?: (img: ProjectImage) => void;
  /** Smaller type, for chat replies. */
  compact?: boolean;
  className?: string;
}) => {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <Md $compact={compact} className={className}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const Tag = b.level <= 1 ? 'h1' : b.level === 2 ? 'h2' : 'h3';
            return (
              <Tag key={i}>
                <Spans spans={b.spans} />
              </Tag>
            );
          }
          case 'para':
            return (
              <p key={i}>
                <Spans spans={b.spans} />
              </p>
            );
          case 'list':
            return (
              <div key={i} className="md-list">
                {b.items.map((it, k) => (
                  <div key={k} className="md-item" style={{ paddingLeft: it.depth * 18 }}>
                    <span className="md-marker">{it.marker}</span>
                    <span>
                      <Spans spans={it.spans} />
                    </span>
                  </div>
                ))}
              </div>
            );
          case 'table':
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((c, k) => (
                        <th key={k}>
                          <Spans spans={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, k) => (
                      <tr key={k}>
                        {b.header.map((_h, j) => (
                          <td key={j}>
                            <Spans spans={r[j] ?? []} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'image':
            return <ImageBlock key={i} block={b} images={images} onOpenImage={onOpenImage} />;
          case 'code':
            return <pre key={i}>{b.text}</pre>;
          case 'math':
            return (
              <div key={i} className="md-math-block" dangerouslySetInnerHTML={{ __html: renderTex(b.tex, true) }} />
            );
          case 'quote':
            return (
              <blockquote key={i}>
                <Spans spans={b.spans} />
              </blockquote>
            );
          case 'rule':
            return <hr key={i} />;
          default:
            return null;
        }
      })}
    </Md>
  );
};

export default MarkdownView;
