import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme/tokens.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
