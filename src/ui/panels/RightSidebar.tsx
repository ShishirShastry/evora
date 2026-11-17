import { useCollab, useCollabState } from '../collab/CollabContext';
import { CommentsPanel } from '../collab/CommentsPanel';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { DesignPanel } from './DesignPanel';
import { InspectPanel } from './InspectPanel';
import { PrototypePanel } from './PrototypePanel';

/**
 * The right sidebar: the Design, Prototype and Inspect (Developer Mode) tabs and the panel of the one that is chosen,
 * and the Comments tab, which stands in front of the others while it is open.
 */
export function RightSidebar() {
  const { store } = useEditorContext();
  const session = useCollab();
  const tab = useEditor((s) => s.rightTab);
  const comments = useCollabState((s) => s.commentsTab);
  const openCount = useCollabState((s) => {
    let count = 0;
    for (const id in s.threads) if (!s.threads[id]?.resolved) count += 1;
    return count;
  });
  const tabs = [
    ['design', 'Design'],
    ['prototype', 'Prototype'],
    ['inspect', 'Inspect'],
  ] as const;
  return (
    <>
      <div className="flex-none border-b border-line px-2 py-2">
        <div role="tablist" aria-label="Properties" className="ev-segmented">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={!comments && tab === id}
              className="ev-segment text-[11.5px]"
              onClick={() => {
                session.setCommentsTab(false);
                store.getState().setRightTab(id);
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={comments}
            aria-label="Comments"
            title={openCount > 0 ? `Comments (${openCount} open)` : 'Comments'}
            className="ev-segment relative !flex-none !px-2 text-[11.5px]"
            onClick={() => session.setCommentsTab(!comments)}
          >
            <span className="flex items-center justify-center">
              <Icon name="comment" size={14} />
            </span>
            {openCount > 0 && <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">{comments ? <CommentsPanel /> : tab === 'design' ? <DesignPanel /> : tab === 'prototype' ? <PrototypePanel /> : <InspectPanel />}</div>
    </>
  );
}
