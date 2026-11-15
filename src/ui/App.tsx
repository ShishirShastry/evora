import { useEffect, useState } from 'react';
import type { DocumentStorage } from '../persistence/storage';
import { EditorScreen } from './editor/EditorScreen';
import { HomeScreen } from './home/HomeScreen';

type Route = { screen: 'home' } | { screen: 'file'; id: string };

/** `#/` is the file browser, `#/file/<id>` is the editor for one file. */
export function parseRoute(hash: string): Route {
  const match = /^#\/file\/([0-9A-Za-z]+)$/.exec(hash);
  return match ? { screen: 'file', id: match[1] as string } : { screen: 'home' };
}

export function App({ storage }: { storage: DocumentStorage }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const go = (hash: string): void => {
    if (window.location.hash === hash) setRoute(parseRoute(hash));
    else window.location.hash = hash;
  };

  if (route.screen === 'file') {
    return <EditorScreen key={route.id} storage={storage} fileId={route.id} onExit={() => go('#/')} />;
  }
  return <HomeScreen storage={storage} onOpen={(id) => go(`#/file/${id}`)} />;
}
