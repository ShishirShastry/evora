import { useMemo, useState } from 'react';
import {
  getAncestorIds,
  getPageIdOf,
  instanceOf,
  isComponent,
  isInstance,
  listComponents,
  patchNodes,
  swapInstances,
  type FrameNode,
  type LayerNode,
  type NodeId,
} from '../../core';
import { getCommand, insertInstance, type Command } from '../../state/commands';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';
import { Row, Section } from './panelParts';

/** A button that runs one of the application's commands, named and switched off as the command says. */
function CommandButton({ id }: { id: string }) {
  const run = useRunCommand();
  const state = useEditor((s) => s);
  const command = getCommand(id) as Command;
  return (
    <button
      type="button"
      className="od-button !h-[26px] flex-1 !px-2"
      title={command.shortcut ? `${command.label} (${command.shortcut})` : command.label}
      disabled={command.enabled ? !command.enabled(state) : false}
      onClick={() => run(command)}
    >
      {command.label}
    </button>
  );
}

/**
 * What the selected layer is, as far as components go, and what can be done
 * about it: a component (its description, and placing an instance), an
 * instance (which component it shows, another in its place, back to the
 * component, reset, detach), or a layer inside an instance.
 */
export function ComponentSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const only = layers.length === 1 ? layers[0] : undefined;
  const instances = layers.filter((layer): layer is FrameNode => isInstance(layer));

  if (only && isComponent(only)) {
    let count = 0;
    for (const id in doc.nodes) {
      const node = doc.nodes[id];
      if (isInstance(node) && node.componentId === only.id) count++;
    }
    return (
      <Section title="Component">
        <textarea
          aria-label="Component description"
          className="od-field h-14 resize-none py-1"
          placeholder="Description"
          spellCheck={false}
          defaultValue={only.description}
          key={`${only.id}:${only.description}`}
          onBlur={(event) => {
            const description = event.currentTarget.value;
            if (description !== only.description) store.getState().apply('Change component description', (d) => patchNodes(d, { [only.id]: { description } }));
          }}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <Row>
          <span className="min-w-0 flex-1 text-dim" role="status" aria-label="Instances of this component">
            {count === 1 ? '1 instance' : `${count} instances`}
          </span>
          <CommandButton id="object.createInstance" />
        </Row>
      </Section>
    );
  }

  if (instances.length > 0 && instances.length === layers.length) {
    const componentId = instances.every((instance) => instance.componentId === instances[0]?.componentId) ? (instances[0]?.componentId ?? '') : '';
    // A component cannot be shown inside itself, so the ones these instances are in are left out.
    const above = new Set(instances.flatMap((instance) => getAncestorIds(doc, instance.id)));
    const choices = listComponents(doc).filter((component) => !above.has(component.id));
    return (
      <Section title="Instance">
        <Row>
          <span className="w-20 flex-none text-dim">Component</span>
          <select
            aria-label="Component shown"
            className="od-field flex-1"
            value={componentId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              store.getState().apply('Swap instance', (d) =>
                swapInstances(
                  d,
                  instances.map((instance) => instance.id),
                  next,
                ),
              );
            }}
          >
            {componentId === '' && <option value="">Mixed</option>}
            {choices.map((component) => (
              <option key={component.id} value={component.id}>
                {component.name}
              </option>
            ))}
          </select>
        </Row>
        <Row>
          <CommandButton id="object.goToMain" />
          <CommandButton id="object.resetInstance" />
        </Row>
        <Row>
          <CommandButton id="object.detachInstance" />
        </Row>
      </Section>
    );
  }

  const owner = only ? instanceOf(doc, only.id) : null;
  if (only && owner) {
    const component = owner.componentId ? doc.nodes[owner.componentId] : undefined;
    return (
      <Section title="In an instance">
        <p role="note" aria-label="Part of an instance" className="m-0 text-faint">
          This layer belongs to an instance of “{component?.name ?? 'a component'}”. What it shows can be changed here and is kept for this instance; where it is and how big
          are the component’s.
        </p>
      </Section>
    );
  }
  return null;
}

/**
 * The components of the file, to find one and place an instance of it. A
 * name with slashes in it ("Buttons/Primary") is filed under what comes
 * before the last slash.
 */
export function ComponentsPanel() {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const [query, setQuery] = useState('');
  const components = useMemo(() => listComponents(doc), [doc]);
  if (components.length === 0) return null;
  const wanted = query.trim().toLowerCase();
  const found = components.filter((component) => wanted === '' || `${component.name}\n${component.description}`.toLowerCase().includes(wanted));
  const groups = new Map<string, FrameNode[]>();
  for (const component of found) {
    const slash = component.name.lastIndexOf('/');
    const group = slash > 0 ? component.name.slice(0, slash).trim() : '';
    groups.set(group, [...(groups.get(group) ?? []), component]);
  }
  const goTo = (id: NodeId): void => {
    const pageId = getPageIdOf(doc, id);
    if (pageId) store.getState().setPage(pageId);
    store.getState().setSelection([id]);
  };
  return (
    <section aria-label="Components" className="flex max-h-[34%] flex-none flex-col border-b border-line">
      <header className="flex h-9 flex-none items-center justify-between pl-3 pr-1.5">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-dim">Components</h2>
      </header>
      <div className="px-2 pb-1.5">
        <input
          aria-label="Search components"
          className="od-field w-full"
          placeholder="Search"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      <ul aria-label="Components" className="m-0 min-h-0 list-none overflow-y-auto p-0 pb-1.5">
        {found.length === 0 && <li className="px-3 py-1 text-faint">No component matches</li>}
        {[...groups.entries()].map(([group, members]) => (
          <li key={group} className="list-none">
            {group !== '' && <div className="px-3 pt-1 text-[11px] text-dim">{group}</div>}
            <ul aria-label={group === '' ? 'Ungrouped components' : group} className="m-0 list-none p-0">
              {members.map((component) => (
                <li key={component.id} className="flex h-7 items-center gap-1 pl-3 pr-1.5 hover:bg-hover" title={component.description || undefined}>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-default truncate border-0 bg-transparent p-0 text-left text-ink"
                    aria-label={`Go to component ${component.name}`}
                    onClick={() => goTo(component.id)}
                  >
                    {group === '' ? component.name : component.name.slice(component.name.lastIndexOf('/') + 1).trim()}
                  </button>
                  <button
                    type="button"
                    className="od-icon-button !h-6 !w-6"
                    aria-label={`Insert an instance of ${component.name}`}
                    title="Insert an instance in the middle of the view"
                    onClick={() => insertInstance(store, component.id)}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
