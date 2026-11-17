import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts';
import './index.css';
import { IndexedDbStorage } from './persistence/indexedDbStorage';
import { loadPreferences } from './persistence/prefs';
import { App } from './ui/App';
import { DesktopMount } from './ui/desktop/DesktopMount';
import { applyTheme } from './ui/theme';

// The theme is a preference of this device: it is in place before anything is drawn.
applyTheme(loadPreferences().theme);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

const storage = new IndexedDbStorage();

createRoot(root).render(
  <StrictMode>
    <App storage={storage} />
    {/* The desktop app's files, menus and settings (Phase 10); nothing in a browser. */}
    <DesktopMount storage={storage} />
  </StrictMode>,
);
