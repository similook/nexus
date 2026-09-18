import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  // StrictMode stays ON deliberately.
  //
  // It double-mounts effects in development, which is precisely the condition that exposes
  // the async-listener leak useNexusCore guards against (addListener is a promise; the second
  // mount's cleanup can run before the first mount's handle resolves). If a subscription is
  // ever added without that guard, StrictMode is what makes it fail loudly in dev instead of
  // quietly on a device.
  <StrictMode>
    <App />
  </StrictMode>,
);
