/*
 * Pick experiments to add to a project as captures: the signed-in account's
 * own recordings and photo sets in the cloud (what the app uploaded, or
 * imported), newest first, several at once. The website has no camera: a
 * capture never starts here, it comes from My Experiments. Ones already in
 * the project are left out. The website's version of the app's
 * TakePickerModal (which lists the phone's gallery).
 */

import { useMemo, useState } from 'react';
import { Button, Modal, Spin, Tag } from 'antd';
import { Check } from 'lucide-react';
import styled from 'styled-components';
import { isCaptureSource, useOwnedExperiments, type ExperimentCard } from '../../hooks/useExperimentLists';
import { ExperimentType, type User } from '../../types';
import { thumbnailHttps } from '../experimentThumbs';

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 2px;

  .ep-cell {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ep-thumb {
    position: relative;
    aspect-ratio: 3 / 4;
    border-radius: 8px;
    overflow: hidden;
    background: var(--ifi-fill-1);
    box-shadow: 0 0 0 0 transparent;
    transition: box-shadow 0.1s;
  }
  .ep-cell:hover .ep-thumb {
    box-shadow: 0 0 0 2px var(--ifi-stroke-2, var(--ifi-stroke-1));
  }
  .ep-cell.ep-picked .ep-thumb {
    box-shadow: 0 0 0 3px var(--ifi-teal);
  }
  .ep-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ep-check {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    border-radius: 11px;
    background: var(--ifi-teal);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ep-tag {
    position: absolute;
    left: 6px;
    bottom: 6px;
    margin: 0;
  }
  .ep-name {
    margin-top: 5px;
    font-size: 13px;
    color: var(--ifi-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ep-line {
    font-size: 11.5px;
    color: var(--ifi-text-tertiary);
  }
`;

const Center = styled.div`
  display: flex;
  justify-content: center;
  padding: 40px 0;
  color: var(--ifi-text-tertiary);
  text-align: center;
  font-size: 14px;
`;

/** The line under an experiment's tile (the app's describeItem, for the cloud). */
function describeExperiment(e: ExperimentCard): string {
  if (e.sourceType === ExperimentType.Photos) {
    const n = e.photoCount;
    return typeof n === 'number' && n > 0 ? `${n} ${n === 1 ? 'photo' : 'photos'}` : 'Photos';
  }
  if (e.timelapse && e.timelapse.intervalSec > 0) {
    return 'Time-lapse';
  }
  return typeof e.duration === 'number' && e.duration > 0 ? `Recording · ${Math.round(e.duration)} s` : 'Recording';
}

const ExperimentPickerModal = ({
  user,
  takenExpIds,
  onAdd,
  onClose,
}: {
  user: User;
  /** Experiments already in the project, by id: not offered again. */
  takenExpIds: Set<string>;
  onAdd: (picked: ExperimentCard[]) => void;
  onClose: () => void;
}) => {
  const { items, loading } = useOwnedExperiments(user);
  const usable = useMemo(
    () => items.filter((e) => isCaptureSource(e.sourceType) && !e.trash && !takenExpIds.has(e.id)),
    [items, takenExpIds],
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const add = () => {
    const list = usable.filter((e) => picked.has(e.id));
    if (list.length > 0) {
      onAdd(list);
    }
    onClose();
  };
  return (
    <Modal
      open
      title="Add from My Experiments"
      onCancel={onClose}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" disabled={picked.size === 0} onClick={add}>
            {picked.size > 1 ? `Add ${picked.size}` : 'Add'}
          </Button>
        </>
      }
    >
      {loading ? (
        <Center>
          <Spin />
        </Center>
      ) : usable.length === 0 ? (
        <Center>
          {items.length === 0
            ? 'Nothing in My Experiments yet. Recordings and photos uploaded from the app appear here.'
            : 'Every recording and photo set in My Experiments is already in this project.'}
        </Center>
      ) : (
        <Grid>
          {usable.map((e) => {
            const on = picked.has(e.id);
            const url = thumbnailHttps(e.thumbnailURL);
            const name = e.displayName?.trim() || e.name || 'Untitled';
            return (
              <button
                key={e.id}
                type="button"
                className={on ? 'ep-cell ep-picked' : 'ep-cell'}
                onClick={() => toggle(e.id)}
                aria-pressed={on}
                aria-label={name}
              >
                <div className="ep-thumb">
                  {url && <img src={url} alt="" loading="lazy" />}
                  {e.timelapse && e.timelapse.intervalSec > 0 && (
                    <Tag className="ep-tag" color="purple">
                      Time-lapse
                    </Tag>
                  )}
                  {on && (
                    <span className="ep-check">
                      <Check size={14} />
                    </span>
                  )}
                </div>
                <div className="ep-name" title={name}>
                  {name}
                </div>
                <div className="ep-line">{describeExperiment(e)}</div>
              </button>
            );
          })}
        </Grid>
      )}
    </Modal>
  );
};

export default ExperimentPickerModal;
