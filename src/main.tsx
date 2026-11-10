import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { store } from './state/store';
import { engine } from './audio/engine';

if (import.meta.env.DEV) Object.assign(window, { __pm: store, __engine: engine });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
