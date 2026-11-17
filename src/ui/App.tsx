import { useEffect, useState } from 'react';
import type { DocumentStorage } from '../persistence/storage';
import { GoogleReturnScreen, InviteScreen } from './collab/Screens';
import type { HomeView } from './collab/HomeCollab';
import { CommunityScreen } from './community/CommunityScreen';
import { EditorScreen } from './editor/EditorScreen';
import { HomeScreen } from './home/HomeScreen';
import { PrototypeScreen } from './prototype/PrototypeScreen';

type Route =
  | { screen: 'home'; view: HomeView }
  | { screen: 'file'; id: string }
  | { screen: 'doc'; id: string; threadId?: string }
  | { screen: 'invite'; token: string }
  | { screen: 'google'; query: string }
  | { screen: 'community'; id: string | null }
  | { screen: 'prototype'; id: string; startId?: string };

/**
 * `#/` is the file browser, `#/file/<id>` is the editor for one file, and
 * `#/proto/<id>` or `#/proto/<id>/<frame>` plays that file's prototype,
 * from a frame when one is named.
 *
 * Collaboration (Phase 8): `#/doc/<id>` opens a shared document from the
 * collaboration server, `#/doc/<id>/comment/<thread>` opens it at a
 * comment, `#/invite/<token>` is an invitation to a workspace, and
 * `#/workspace/<id>` and `#/shared` are the file browser showing a
 * workspace's files or the files shared with you. `#/auth/google?ticket=…`
 * (or `?error=…`) is where signing in with Google comes back to.
 *
 * Phase 9: `#/community` is the Community and `#/community/<id>` one of its
 * resources; `#/recents` and `#/favorites` are the file browser showing
 * those; `#/workspace/<id>/project/<project>` one project's files, and
 * `#/workspace/<id>/trash` a workspace's trash.
 */
export function parseRoute(hash: string): Route {
  const match = /^#\/file\/([0-9A-Za-z]+)$/.exec(hash);
  if (match) return { screen: 'file', id: match[1] as string };
  const prototype = /^#\/proto\/([0-9A-Za-z-]+)(?:\/([0-9A-Za-z]+))?$/.exec(hash);
  if (prototype) return { screen: 'prototype', id: prototype[1] as string, startId: prototype[2] };
  const doc = /^#\/doc\/([0-9A-Za-z_-]+)(?:\/comment\/([0-9A-Za-z_-]+))?$/.exec(hash);
  if (doc) return { screen: 'doc', id: doc[1] as string, threadId: doc[2] };
  const invite = /^#\/invite\/([0-9A-Za-z_-]+)$/.exec(hash);
  if (invite) return { screen: 'invite', token: invite[1] as string };
  const google = /^#\/auth\/google(?:\?(.*))?$/.exec(hash);
  if (google) return { screen: 'google', query: google[1] ?? '' };
  const workspace = /^#\/workspace\/([0-9A-Za-z_-]+)$/.exec(hash);
  if (workspace) return { screen: 'home', view: { kind: 'workspace', id: workspace[1] as string } };
  const project = /^#\/workspace\/([0-9A-Za-z_-]+)\/project\/([0-9A-Za-z_-]+)$/.exec(hash);
  if (project) return { screen: 'home', view: { kind: 'workspace', id: project[1] as string, projectId: project[2] as string } };
  const trash = /^#\/workspace\/([0-9A-Za-z_-]+)\/trash$/.exec(hash);
  if (trash) return { screen: 'home', view: { kind: 'trash', id: trash[1] as string } };
  const community = /^#\/community(?:\/([0-9A-Za-z_-]+))?$/.exec(hash);
  if (community) return { screen: 'community', id: community[1] ?? null };
  if (hash === '#/shared') return { screen: 'home', view: { kind: 'shared' } };
  if (hash === '#/recents') return { screen: 'home', view: { kind: 'recents' } };
  if (hash === '#/favorites') return { screen: 'home', view: { kind: 'favorites' } };
  return { screen: 'home', view: { kind: 'local' } };
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
  if (route.screen === 'doc') {
    // The thread is opened once; changing to another thread of the same document does not reload it.
    return <EditorScreen key={`doc:${route.id}`} storage={storage} fileId={route.id} source="shared" threadId={route.threadId} onExit={() => go('#/')} />;
  }
  if (route.screen === 'google') {
    // The return from Google is replaced in the history, so its ticket is not kept there.
    const replace = (hash: string): void => {
      window.history.replaceState(null, '', hash);
      setRoute(parseRoute(hash));
    };
    return <GoogleReturnScreen key={route.query} query={route.query} onDone={replace} />;
  }
  if (route.screen === 'community') {
    return <CommunityScreen storage={storage} resourceId={route.id} onNavigate={go} />;
  }
  if (route.screen === 'invite') {
    return <InviteScreen key={route.token} token={route.token} onAccepted={(workspace) => go(`#/workspace/${workspace.id}`)} onHome={() => go('#/')} />;
  }
  return <HomeScreen storage={storage} onOpen={(id) => go(`#/file/${id}`)} view={route.view} onNavigate={go} />;
}
