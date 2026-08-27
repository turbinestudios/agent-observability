import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyStoredThemeEarly } from './theme/useTheme';
import './theme/tokens.css';

// Before React mounts, so a light-theme user never sees a dark frame first.
applyStoredThemeEarly();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
