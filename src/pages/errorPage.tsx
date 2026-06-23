import { Link, useRouteError } from 'react-router-dom';
import { Result, Button } from 'antd';

const ErrorPage = () => {
  const error = useRouteError() as { statusText?: string; message?: string } | undefined;

  return (
    <Result
      status="404"
      title="Page not found"
      subTitle={error?.statusText || error?.message || 'The page you are looking for does not exist.'}
      extra={
        <Link to="/">
          <Button type="primary">Back to home</Button>
        </Link>
      }
    />
  );
};

export default ErrorPage;
