import { useEffect, useState } from 'react';
import type { DocumentStorage } from '../persistence/storage';
import { EditorScreen } from './editor/EditorScreen';
import { HomeScreen } from './home/HomeScreen';
import { PrototypeScreen } from './prototype/PrototypeScreen';

type Route = { screen: 'home' } | { screen: 'file'; id: string } | { screen: 'prototype'; id: string; startId?: string };

/**
 * `#/` is the file browser, `#/file/<id>` is the editor for one file, and
 * `#/proto/<id>` or `#/proto/<id>/<frame>` plays that file's prototype,
 * from a frame when one is named.
 */
export function parseRoute(hash: string): Route {
  const match = /^#\/file\/([0-9A-Za-z]+)$/.exec(hash);
  if (match) return { screen: 'file', id: match[1] as string };
  const prototype = /^#\/proto\/([0-9A-Za-z-]+)(?:\/([0-9A-Za-z]+))?$/.exec(hash);
  return prototype ? { screen: 'prototype', id: prototype[1] as string, startId: prototype[2] } : { screen: 'home' };
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

  if (route.screen === 'prototype') {
    return <PrototypeScreen key={`${route.id}/${route.startId ?? ''}`} storage={storage} fileId={route.id} startId={route.startId} onExit={() => go(`#/file/${route.id}`)} />;
  }
  if (route.screen === 'file') {
    return <EditorScreen key={route.id} storage={storage} fileId={route.id} onExit={() => go('#/')} />;
  }
  return <HomeScreen storage={storage} onOpen={(id) => go(`#/file/${id}`)} />;
}
