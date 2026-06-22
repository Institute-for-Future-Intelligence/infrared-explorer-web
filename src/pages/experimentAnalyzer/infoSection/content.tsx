import { useEffect, useRef, useState } from 'react';
import ContentEditable, { ContentEditableEvent } from 'react-contenteditable';
import useCommonStore from '../../../stores/common';
interface Props {
  description: string;
  ownerId?: string;
}
const Content = ({ description, ownerId }: Props) => {
  const [disabled, setDisabled] = useState(true);

  const contentRef = useRef(description);

  const handleContentChange = (event: ContentEditableEvent) => {
    contentRef.current = event.target.value;
  };

  useEffect(() => {
    const currentUser = useCommonStore.getState().user;
    if (currentUser?.id && currentUser.id === ownerId) {
      setDisabled(false);
    }
  }, [ownerId]);

  const hasContent = contentRef.current.length > 0;

  return (
    <ContentEditable
      html={hasContent ? contentRef.current : 'WRITE HERE'}
      disabled={disabled}
      onChange={handleContentChange}
      style={{
        fontSize: '14px',
        paddingLeft: disabled ? '0px' : '4px',
        color: hasContent ? 'black' : 'gray',
        whiteSpace: 'pre-wrap',
        overflowY: 'auto',
        height: '50%',
        minHeight: '20vh',
        maxHeight: '40vh',
        maxWidth: '300px',
      }}
    />
  );
};

export default Content;
