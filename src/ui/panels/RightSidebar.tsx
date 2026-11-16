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
      <div role="tablist" aria-label="Properties" className="flex h-9 flex-none items-center gap-1 border-b border-line px-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`h-7 rounded-md border-0 bg-transparent px-2 text-[11px] font-semibold uppercase tracking-wide hover:bg-hover ${tab === id ? 'text-accent' : 'text-dim'}`}
            onClick={() => store.getState().setRightTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{tab === 'design' ? <DesignPanel /> : tab === 'prototype' ? <PrototypePanel /> : <InspectPanel />}</div>
    </>
  );
}
