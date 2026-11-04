// A note's colour: a CSS hex string stored on the annotation (`color`), absent/null for the default.
// White is the default so every note made before colours existed keeps its look.
export const DEFAULT_ANNOTATION_COLOR = '#ffffff';

// The quick palette: colours that stay legible on the thermal palettes (iron, rainbow, grey). The
// selection accent (#ffc53d amber) is deliberately not among them — a selected note is marked by an
// amber ring and halo, which would vanish on a note of that very colour.
export const ANNOTATION_COLORS: readonly { value: string; name: string }[] = [
  { value: DEFAULT_ANNOTATION_COLOR, name: 'White' },
  { value: '#111111', name: 'Black' },
  { value: '#ffe600', name: 'Yellow' },
  { value: '#ff8a00', name: 'Orange' },
  { value: '#ff4d6d', name: 'Red' },
  { value: '#39ff6a', name: 'Green' },
  { value: '#2bd4ff', name: 'Cyan' },
  { value: '#c77dff', name: 'Violet' },
];

/** The colour a note is drawn in: its own, or the default. */
export const annotationColorOf = (color: string | null | undefined) => color || DEFAULT_ANNOTATION_COLOR;

/** The value to store for a picked colour: the default is stored as "no colour" (null), never as white. */
export const storedAnnotationColor = (color: string): string | null =>
  color.toLowerCase() === DEFAULT_ANNOTATION_COLOR ? null : color;
