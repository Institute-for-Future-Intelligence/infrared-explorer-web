import { Spin } from 'antd';

/** Centred loading spinner used while a page or the analyzer is fetching. */
const Spinner = ({ tip }: { tip?: string }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
      height: '100%',
      minHeight: 200,
    }}
    className="app-spinner"
  >
    <Spin size="large" />
    {tip ? <div style={{ color: 'var(--ant-color-primary, #1677ff)' }}>{tip}</div> : null}
  </div>
);

export default Spinner;
