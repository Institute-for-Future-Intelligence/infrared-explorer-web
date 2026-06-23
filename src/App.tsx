import './App.css';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import ErrorPage from './pages/errorPage';
import Layout from './layouts/layout';
import './services/firebase';
import HomePage from './pages/homePage';
import MyExperimentsList from './pages/myExperimentsList';
import ExperimentAnalyzer from './pages/experimentAnalyzer/experimentAnalyzer';
import Trash from './pages/trash';
import Recent from './pages/recent';
import Raw from './pages/raw';
import Settings from './pages/settings';
import { useAuthInit } from './hooks/useAuthInit';

const App = () => {
  useAuthInit();

  const router = createHashRouter([
    {
      path: '',
      element: <Layout />,
      errorElement: <ErrorPage />,
      children: [
        {
          path: '',
          element: <HomePage />,
        },
        {
          path: 'myExperimentsList',
          element: <MyExperimentsList />,
        },
        {
          path: 'recent',
          element: <Recent />,
        },
        {
          path: 'raw',
          element: <Raw />,
        },
        {
          path: 'settings',
          element: <Settings />,
        },
        {
          path: 'trash',
          element: <Trash />,
        },
        {
          path: 'experiments/:expId',
          element: <ExperimentAnalyzer />,
        },
        {
          path: '*',
          element: <ErrorPage />,
        },
      ],
    },
  ]);

  return <RouterProvider router={router} />;
};

export default App;
