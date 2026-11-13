/*
 * The captures waiting beside the message box: added from My Experiments
 * for this project, not yet sent to the AI. They go with the next message
 * (Send with no words sends them alone). A tile opens the experiment in
 * the analyzer, in a new tab; × takes it out of the project (it stays in My
 * Experiments). One still being filed shows as a tile with a spinner until
 * it is in. A filed one carries what it is called: its number (#1, #2, … in
 * the order added) or, where the experiment numbers photos and recordings
 * apart, its name along the bottom (Photo 1, Recording 1) — as in Discuss
 * and the Captures tab. While it waits here the number is not settled: it
 * moves down when a capture waiting before it is taken out. As the app's
 * AttachmentTray.
 */

import { Link } from 'react-router-dom';
import { Spin } from 'antd';
import { Camera, Clock, Play, X } from 'lucide-react';
import styled from 'styled-components';
import type { CaptureName } from '../core/captureNumbers';
import type { Take } from '../core/types';
import type { CloudThumbState } from '../useCloudThumbs';
import { useNewTabLink } from '../../hooks/useNavTrail';

const SIZE = 64;

/** A capture on its way into the tray: the experiment being filed, with what its card showed. */
export interface AddingCapture {
  key: string;
  thumbnailUrl: string | null;
  video: boolean;
  timelapse: boolean;
}

const Row = styled.div`
  display: flex;
  gap: 8px;
  padding: 8px 8px 2px;
  overflow-x: auto;

  .at-cell {
    position: relative;
    flex: none;
    width: ${SIZE}px;
    height: ${SIZE}px;
  }
  .at-thumb {
    display: block;
    width: ${SIZE}px;
    height: ${SIZE}px;
    border-radius: 8px;
    overflow: hidden;
    background: #222;
    color: inherit;
    text-decoration: none;
  }
  a.at-thumb:hover {
    box-shadow: 0 0 0 2px var(--ifi-teal);
  }
  .at-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .at-blank {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: #1a1a1a;
    color: #9a9a9a;
    font-size: 9px;
    text-align: center;
    line-height: 1.2;
  }
  .at-kind {
    position: absolute;
    left: 4px;
    bottom: 4px;
    width: 18px;
    height: 18px;
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  /* out of the way of the name along the bottom (.at-name) */
  .at-kind.up {
    top: 4px;
    bottom: auto;
  }
  /* "Photo 1" / "Recording 1": too long for a corner of a tile this small, so it runs along the bottom */
  .at-name {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 16px;
    padding: 0 3px;
    border-radius: 0 0 8px 8px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .at-number {
    position: absolute;
    right: 4px;
    bottom: 4px;
    min-width: 18px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }
  .at-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 11px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .at-remove:hover {
    background: rgba(0, 0, 0, 0.9);
  }
  .at-veil {
    position: absolute;
    inset: 0;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

const KindBadge = ({ video, timelapse, up }: { video: boolean; timelapse: boolean; up?: boolean }) =>
  video ? (
    <span className={up ? 'at-kind up' : 'at-kind'}>{timelapse ? <Clock size={11} /> : <Play size={11} />}</span>
  ) : null;

const AttachmentTray = ({
  takes,
  adding,
  names,
  cloud,
  onRemove,
}: {
  takes: Take[];
  adding: AddingCapture[];
  /** What every capture in the project is called (captureNames). */
  names: Map<string, CaptureName>;
  /** Each capture's cloud copy (useCloudThumbs). */
  cloud: Map<string, CloudThumbState>;
  onRemove: (t: Take) => void;
}) => {
  const newTabLink = useNewTabLink();
  if (takes.length === 0 && adding.length === 0) {
    return null;
  }
  return (
    <Row aria-label="Captures to send">
      {takes.map((t) => {
        const state = cloud.get(t.takeId);
        const thumb = state?.kind === 'ready' ? state.thumb : null;
        const name = names.get(t.takeId);
        // by kind and number ("Recording 1"), where a bare "#1" would be a photo and a recording both
        const named = name?.kind != null;
        const title = named ? `${name.label} · ${t.name}` : t.name;
        const picture = thumb?.thumbnailUrl ? (
          <img src={thumb.thumbnailUrl} alt="" />
        ) : (
          <div className="at-blank">{state?.kind === 'loading' ? <Spin size="small" /> : <Camera size={16} />}</div>
        );
        return (
          <div key={t.takeId} className="at-cell">
            {thumb ? (
              <Link
                className="at-thumb"
                {...newTabLink(`/experiments/${thumb.expId}`)}
                title={title}
                aria-label={title}
              >
                {picture}
              </Link>
            ) : (
              <div className="at-thumb" title={title}>
                {picture}
              </div>
            )}
            <KindBadge video={t.source === 'recording'} timelapse={!!t.timelapse} up={named} />
            {name && <span className={named ? 'at-name' : 'at-number'}>{name.tag}</span>}
            <button
              type="button"
              className="at-remove"
              onClick={() => onRemove(t)}
              aria-label={`Remove ${t.name}`}
              title="Remove"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      {adding.map((a) => (
        <div key={a.key} className="at-cell" aria-label="Adding">
          <div className="at-thumb">
            {a.thumbnailUrl ? <img src={a.thumbnailUrl} alt="" /> : <div className="at-blank" />}
          </div>
          <KindBadge video={a.video} timelapse={a.timelapse} />
          <div className="at-veil">
            <Spin size="small" />
          </div>
        </div>
      ))}
    </Row>
  );
};

export default AttachmentTray;
