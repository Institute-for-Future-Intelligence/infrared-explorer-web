import { css } from 'styled-components';

/**
 * For a title row holding a RenamePencil (components/titleRename): keep the pencil hidden until the
 * owner hovers the row, then fade it in. Opacity (not display) reserves its space, so the title
 * doesn't shift sideways when the pencil appears. (A file of its own: a component file exports
 * components only, for fast refresh.)
 */
export const revealRenamePencil = css`
  .title-edit {
    opacity: 0;
    transition: opacity 0.2s;
  }
  &:hover .title-edit,
  &:focus-within .title-edit {
    opacity: 1;
  }
  /* Touch devices have no hover, so a hover-only pencil is invisible to the owner there — keep it
     shown so the title still reads as editable. */
  @media (hover: none) {
    .title-edit {
      opacity: 1;
    }
  }
`;
