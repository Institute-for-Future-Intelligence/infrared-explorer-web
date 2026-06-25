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
import About from './pages/about';
import Contact from './pages/contact';
import AllUsers from './pages/admin/allUsers';
import AllExperiments from './pages/admin/allExperiments';
import { useAuthInit } from './hooks/useAuthInit';

const App = () => {
  useAuthInit();

  const router = createHashRouter(
    [
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
            path: 'about',
            element: <About />,
          },
          {
            path: 'contact',
            element: <Contact />,
          },
          {
            path: 'trash',
            element: <Trash />,
          },
          {
            path: 'admin/users',
            element: <AllUsers />,
          },
          {
            path: 'admin/experiments',
            element: <AllExperiments />,
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
    ],
    {
      // Opt in early to React Router v7 behavior; also silences the v6 future-flag warnings.
      future: { v7_relativeSplatPath: true },
    },
  );

  return <RouterProvider router={router} future={{ v7_startTransition: true }} />;
};

export default App;
