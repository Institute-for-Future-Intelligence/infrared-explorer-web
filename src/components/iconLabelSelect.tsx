import { Select } from 'antd';
import styled from 'styled-components';

/*
 * A single-mode antd Select whose option labels are icon + text flex rows — the analyzer's Subject
 * and Visibility pickers.
 *
 * antd lays the chosen label out as inline content in a line box (line-height = the selector's
 * inner height) and aligns it on the text BASELINE. An inline-flex label span gets the baseline of
 * its first flex item — and when that item is an anticon (an svg with no text baseline), the
 * browser synthesizes one from the icon's bottom edge, which rides the whole icon+text group ~3px
 * high in the box. A label that starts with a real glyph (the Subject emoji) keeps a true text
 * baseline and sits correctly — so the two selects' text visibly disagreed. Flex-centering the
 * selection item sidesteps baseline math entirely: the label span becomes a flex item centred
 * exactly in the selector, whatever it starts with. (The placeholder is a separate element and
 * keeps antd's own line-box centring.)
 */
// styled() erases Select's generic call signature; cast it back so callers keep <IconLabelSelect<T>> typing.
const IconLabelSelect = styled(Select)`
  .ant-select-selection-item {
    display: flex;
    align-items: center;
  }
` as unknown as typeof Select;

export default IconLabelSelect;
