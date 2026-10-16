/*
 * The Captures tab: the recordings and photos filed under the project,
 * newest first, three to a row. A capture with a copy in the cloud is its
 * experiment's thumbnail and opens in the analyzer (/experiments/:expId);
 * one without is on the owner's phone only, and its tile says so. Each tile
 * carries the capture's number (Capture 1, 2, … in the order added) and when
 * it was captured, as the app's do. On the owner's page a tile's menu (its
 * "…", or a right click) offers Remove from Project: the capture stays in
 * My Experiments.
 */

import { Link } from 'react-router-dom';
import { Dropdown, Tag } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import styled from 'styled-components';
import { captureNumbers } from '../core/captureNumbers';
import type { Take } from '../core/types';
import { capturesInOrder } from '../format';
import type { CloudThumbState } from '../useCloudThumbs';

const kindOf = (t: Pick<Take, 'source' | 'timelapse'>): string =>
  t.source === 'photos' ? 'Photo' : t.timelapse ? 'Time-lapse' : 'Recording';

const pad = (v: number) => String(v).padStart(2, '0');

/** When it was captured, short: the time today, the date and time before. */
function capturedWhen(ms: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 14px 18px 28px;

  .ct-cell {
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .ct-thumb {
    position: relative;
    aspect-ratio: 3 / 4;
    border-radius: 8px;
    overflow: hidden;
    background: var(--ifi-fill-1);
  }
  .ct-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  a.ct-cell .ct-thumb {
    cursor: pointer;
  }
  a.ct-cell:hover .ct-thumb {
    box-shadow: 0 0 0 2px var(--ifi-teal);
  }
  .ct-blank {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px;
    text-align: center;
    color: var(--ifi-text-tertiary);
    font-size: 12px;
    line-height: 1.35;
  }
  .ct-blank b {
    font-weight: 600;
    color: var(--ifi-text-secondary);
  }
  .ct-number {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 1px 7px;
    border-radius: 9px;
    background: rgba(11, 16, 38, 0.65);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .ct-tag {
    position: absolute;
    right: 6px;
    bottom: 6px;
    margin: 0;
  }
  .ct-menu {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 13px;
    padding: 0;
    background: rgba(11, 16, 38, 0.65);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .ct-cell:hover .ct-menu,
  .ct-cell:focus-within .ct-menu,
  .ct-menu[aria-expanded='true'] {
    opacity: 1;
  }
  .ct-name {
    margin-top: 5px;
    font-size: 13px;
    color: var(--ifi-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ct-when {
    font-size: 11.5px;
    color: var(--ifi-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
`;

const Empty = styled.div`
  padding: 48px 16px;
  text-align: center;
  color: var(--ifi-text-tertiary);
  font-size: 15px;
`;

const REMOVE_KEY = 'remove';

const CapturesTab = ({
  takes,
  cloud,
  onRemove,
}: {
  takes: Take[];
  cloud: Map<string, CloudThumbState>;
  /** Absent on a viewer's page: nothing to remove. */
  onRemove?: (t: Take) => void;
}) => {
  const list = capturesInOrder(takes);
  const numbers = captureNumbers(takes);
  if (list.length === 0) {
    return (
      <Empty>
        {onRemove
          ? 'No captures in this project. Add one with the “+” beside the message box.'
          : 'No captures in this project.'}
      </Empty>
    );
  }
  const menuOf = (t: Take) => ({
    items: [{ key: REMOVE_KEY, label: 'Remove from Project', danger: true }],
    onClick: ({ key, domEvent }: { key: string; domEvent: { preventDefault(): void; stopPropagation(): void } }) => {
      domEvent.preventDefault();
      domEvent.stopPropagation();
      if (key === REMOVE_KEY) {
        onRemove?.(t);
      }
    },
  });
  return (
    <Grid>
      {list.map((t) => {
        const state = cloud.get(t.takeId) ?? { kind: 'missing' as const };
        const n = numbers.get(t.takeId);
        const inner = (
          <>
            <div className="ct-thumb">
              {state.kind === 'ready' && state.thumb.thumbnailUrl ? (
                <img src={state.thumb.thumbnailUrl} alt={t.name} loading="lazy" />
              ) : state.kind === 'missing' ? (
                <div className="ct-blank">
                  <b>On your phone only</b>
                  <span>Upload it from the app</span>
                </div>
              ) : state.kind === 'unavailable' ? (
                <div className="ct-blank">
                  <span>Not available right now</span>
                </div>
              ) : null}
              {n != null && <span className="ct-number">#{n}</span>}
              {onRemove && (
                <Dropdown trigger={['click']} menu={menuOf(t)}>
                  <button
                    type="button"
                    className="ct-menu"
                    aria-label={`Menu for ${t.name}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                </Dropdown>
              )}
              {t.timelapse && (
                <Tag className="ct-tag" color="purple">
                  Time-lapse
                </Tag>
              )}
            </div>
            <div className="ct-name" title={t.name}>
              {n != null ? `Capture ${n}` : t.name}
            </div>
            <div className="ct-when">
              {kindOf(t)} · {capturedWhen(t.at)}
            </div>
          </>
        );
        const cell =
          state.kind === 'ready' ? (
            <Link className="ct-cell" to={`/experiments/${state.thumb.expId}`} title={t.name}>
              {inner}
            </Link>
          ) : (
            <div className="ct-cell" title={t.name}>
              {inner}
            </div>
          );
        return onRemove ? (
          <Dropdown key={t.takeId} trigger={['contextMenu']} menu={menuOf(t)}>
            {cell}
          </Dropdown>
        ) : (
          <div key={t.takeId} style={{ display: 'contents' }}>
            {cell}
          </div>
        );
      })}
    </Grid>
  );
};

export default CapturesTab;
