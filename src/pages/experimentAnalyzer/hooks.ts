import { useMemo } from 'react';
import { Segment } from '../../types';

export const useMappingIndex = (segments: Segment[] | undefined, duration: number) => {
  /** map from curr index to recording index */
  const createMapAndArray = (segments: Segment[]) => {
    const currSegments: Segment[] = [];
    const map = new Map<number, number>();

    if (!segments) return { map, currSegments };

    let frames = -1;
    for (const { start, end } of segments) {
      frames += 1;
      const currStart = frames;
      frames += end - start;
      currSegments.push({ start: currStart, end: frames });
      map.set(currStart, start);
      map.set(frames, end);
    }

    return { map, currSegments };
  };

  const getRecordingIndex = (currIdx: number) => {
    if (!mappingData) return currIdx + 1;
    const { map, currSegments } = mappingData;
    for (const { start, end } of currSegments) {
      if (currIdx >= start && currIdx <= end) {
        const original = map.get(start);
        if (original !== undefined) {
          return original + currIdx - start;
        }
      }
    }
    return 0;
  };

  const mappingData = useMemo(() => {
    // No segments (null/undefined) OR an empty array both mean "play the whole recording",
    // not a segmented clip — an empty array is truthy, so guard its length too.
    if (!segments || segments.length === 0) return null;
    return createMapAndArray(segments);
  }, [segments]);

  const lastFrameIndex = mappingData
    ? mappingData.currSegments[mappingData.currSegments.length - 1].end
    : duration * 5 - 1;

  return { lastFrameIndex, getRecordingIndex };
};
