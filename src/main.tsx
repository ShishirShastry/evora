import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { IndexedDbStorage } from './persistence/indexedDbStorage';
import { loadPreferences } from './persistence/prefs';
import { App } from './ui/App';
import { applyTheme } from './ui/theme';

// The theme is a preference of this device: it is in place before anything is drawn.
applyTheme(loadPreferences().theme);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App storage={new IndexedDbStorage()} />
  </StrictMode>,
);
