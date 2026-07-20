import Pako from 'pako';
import { Dimension } from '../types';
import { INTSIZE, IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import { readArrayBufferSegment } from './temperatureReader';

let warnedNonStandardDim = false;

// Some cameras may have a different resolution than 120x160.
// So we read the dimension info from the header of the VIR file.
const getDimension = (arrBuf: ArrayBufferLike): Dimension => {
  const d = readArrayBufferSegment(arrBuf, 0, 2);
  return { width: d[0], height: d[1], size: d[0] * d[1] };
};

export const parseRawThermalData = (arrBuf: ArrayBuffer) => {
  const dimension = getDimension(arrBuf);
  // The client's grid views (isotherms, 3D surface, thumbnails) and probe reads all assume the fixed
  // 120x160 sensor grid; a clip captured at another resolution would decode into a mis-shaped grid.
  // Every known .vir is 120x160 (the capture app is hard-locked to it and never emits .vir), so this is
  // a defensive tripwire rather than a supported path — surface it once instead of failing silently.
  if (!warnedNonStandardDim && (dimension.width !== IR_ARRAY_WIDTH || dimension.height !== IR_ARRAY_HEIGHT)) {
    warnedNonStandardDim = true;
    console.warn(
      `[vir] non-120x160 clip (${dimension.width}x${dimension.height}); grid views/thumbnails/3D use 120x160 and may be misaligned`,
    );
  }
  const sizeInByte = arrBuf.byteLength;
  const totalPixelCount = (sizeInByte - 8) / INTSIZE;
  const totalFrameCount = totalPixelCount / dimension.size;

  const res: ArrayBuffer[] = [];
  for (let i = 0; i < totalFrameCount; i++) {
    // Byte offset of frame i: 8-byte header + i full frames. dimension.size is a PIXEL count and each
    // pixel is INTSIZE bytes, so the per-frame stride must include *INTSIZE — without it frames start
    // a quarter-frame apart and overlap, so playback scrolls the image vertically (height/4 rows each
    // step) and only ever reads the first ~1/4 of the clip.
    const start = i * dimension.size * INTSIZE + 8;
    const end = start + dimension.size * INTSIZE;
    res.push(Pako.deflate(arrBuf.slice(start, end)));
  }

  return res;
};
