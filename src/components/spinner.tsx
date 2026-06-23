import { Spin } from 'antd';

/** Centred loading spinner used while a page or the analyzer is fetching. */
const Spinner = ({ tip }: { tip?: string }) => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', minHeight: 200 }}>
    <Spin size="large" tip={tip}>
      {tip ? <div style={{ padding: 24 }} /> : undefined}
    </Spin>
  </div>
);

export default Spinner;
