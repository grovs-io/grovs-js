import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { startGrovs, trigger } from './grovs';

// Configures the SDK when it mounts, the way an app wraps its tree in a provider.
function GrovsProvider({ report, children }) {
  useEffect(() => {
    window.__hostMounts = (window.__hostMounts ?? 0) + 1;
    startGrovs(report);
  }, [report]);
  return children;
}

function Page({ title, children }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <main>
      <h1>{title}</h1>
      <input id="host-field" placeholder="Type here" />
      <button id="host-trigger" type="button" onClick={trigger}>
        Trigger
      </button>
      {children}
    </main>
  );
}

function App() {
  const [key, setKey] = useState(0);
  const [action, setAction] = useState('');
  const [answer, setAnswer] = useState('');
  const [report] = useState(() => ({ action: setAction, answer: setAnswer }));
  return (
    <BrowserRouter>
      <GrovsProvider key={key} report={report}>
        <Routes>
          <Route path="/" element={<Page title="Host home"><Link id="host-second" to="/second">Second</Link></Page>} />
          <Route path="/second" element={<Page title="Second"><Link id="host-home" to="/">Home</Link></Page>} />
        </Routes>
      </GrovsProvider>
      <button id="host-remount" type="button" onClick={() => setKey((k) => k + 1)}>
        Remount provider
      </button>
      <p>
        Last action: <span id="host-last-action">{action}</span>
      </p>
      <p>
        Last answer: <span id="host-last-answer">{answer}</span>
      </p>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
