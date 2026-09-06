import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import './index.css';
import App from './App';
import CalendarPage from './pages/CalendarPage';
import ActivityPage from './pages/ActivityPage';

const now = new Date();
const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to={`/calendar/${now.getFullYear()}/${now.getMonth() + 1}`} replace /> },
      { path: 'calendar/:year/:month', element: <CalendarPage /> },
      { path: 'calendar/:year/:month/:day', element: <CalendarPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'activity/:jobId', element: <ActivityPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
