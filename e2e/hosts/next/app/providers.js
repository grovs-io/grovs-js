'use client';

import { useEffect, useState } from 'react';
import { startGrovs } from './grovs';

// Configures the SDK when it mounts, the way an app wraps its tree in a provider.
function GrovsProvider({ report, children }) {
  useEffect(() => {
    window.__hostMounts = (window.__hostMounts ?? 0) + 1;
    startGrovs(report);
  }, [report]);
  return children;
}

export function Providers({ children }) {
  const [key, setKey] = useState(0);
  const [action, setAction] = useState('');
  const [answer, setAnswer] = useState('');
  const [report] = useState(() => ({ action: setAction, answer: setAnswer }));
  return (
    <>
      <GrovsProvider key={key} report={report}>
        {children}
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
    </>
  );
}
