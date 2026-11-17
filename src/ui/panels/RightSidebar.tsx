import { useEditor, useEditorContext } from '../editor/EditorContext';
import { DesignPanel } from './DesignPanel';
import { InspectPanel } from './InspectPanel';
import { PrototypePanel } from './PrototypePanel';

/** The right sidebar: the Design, Prototype and Inspect (Developer Mode) tabs and the panel of the one that is chosen. */
export function RightSidebar() {
  const { store } = useEditorContext();
  const tab = useEditor((s) => s.rightTab);
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
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="ev-segment text-[11.5px]" onClick={() => store.getState().setRightTab(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">{tab === 'design' ? <DesignPanel /> : tab === 'prototype' ? <PrototypePanel /> : <InspectPanel />}</div>
    </>
  );
}
