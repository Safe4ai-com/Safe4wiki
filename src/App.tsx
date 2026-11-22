import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './lib/context';
import Home from './pages/Home.jsx';
import WikiPage from './pages/WikiPage.jsx';
import PrintView from './pages/PrintView.jsx';
import { DialogHost } from './components/Dialogs.jsx';

function Toast() {
  const app = useApp();
  return app.toast ? <div className="toast" role="status">{app.toast}</div> : null;
}

function Root() {
  const app = useApp();
  const exp = app.exported;
  return (
    <>
      <Routes>
        <Route path="/" element={exp ? <Navigate to={`/${exp.owner}/${exp.repo}`} replace /> : <Home />} />
        <Route path="/:owner/:repo/print" element={<PrintView />} />
        <Route path="/:owner/:repo/:page?" element={<WikiPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DialogHost />
      <Toast />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Root />
      </AppProvider>
    </BrowserRouter>
  );
}
