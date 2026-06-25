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

  // Inverse of getRecordingIndex: map a recording-frame number (e.g. the stored thumbnail
  // `currentFrameNumber`, which lives in recording-frame space) back to a player index. A segmented
  // clip's recording frame only has a player index if it falls inside a kept segment — if it doesn't
  // (e.g. a thumbnail frame outside the trimmed range), there is no valid player position, so open at
  // the clip start (0) rather than letting getRecordingIndex hit its `return 0` fallback and fetch a
  // non-existent data_0.png. Raw clips are 1-indexed in recording space, so index = frame - 1.
  const getPlayerIndex = (recordingFrame: number) => {
    if (!mappingData) return Math.max(0, recordingFrame - 1);
    const { map, currSegments } = mappingData;
    for (const { start, end } of currSegments) {
      const recStart = map.get(start);
      const recEnd = map.get(end);
      if (recStart !== undefined && recEnd !== undefined && recordingFrame >= recStart && recordingFrame <= recEnd) {
        return start + (recordingFrame - recStart);
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

  return { lastFrameIndex, getRecordingIndex, getPlayerIndex };
};
