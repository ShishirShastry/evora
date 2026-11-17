import { useMemo, useState } from 'react';
import {
  addComponentProp,
  addVariant,
  addVariantProperty,
  bindProp,
  canBind,
  getAncestorIds,
  getChildIds,
  getPageIdOf,
  instanceOf,
  instancePropValue,
  isComponent,
  isInstance,
  isLayer,
  libraryOf,
  listComponents,
  patchNodes,
  propertyOwner,
  propsOf,
  removeComponentProp,
  removeVariantProperty,
  renameComponentProp,
  renameVariantProperty,
  setInstanceProp,
  setInstanceVariant,
  setOf,
  setVariantValue,
  swapInstances,
  variantOptions,
  type ComponentProp,
  type ComponentPropType,
  type Document,
  type FrameNode,
  type LayerNode,
  type NodeId,
} from '../../core';
import { getCommand, insertInstance, type Command } from '../../state/commands';
import type { EditorStore } from '../../state/editorStore';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext, useRunCommand } from '../editor/EditorContext';
import { Row, Section } from './panelParts';
import { Adorned } from './TokenSections';

/** Display only: a short caption over a group of fields. */
const CAPTION = 'text-[11px] font-medium text-dim';
/** Display only: a checkbox with its words beside it, as one target. */
const CHECK_ROW = 'flex min-h-6 cursor-pointer select-none items-center gap-2';
const CHECKBOX = 'h-3.5 w-3.5 flex-none cursor-pointer accent-[var(--ev-accent)]';
/** Display only: a raised key, as wide as its words or wider; keys that do not fit beside each other go onto the next line. */
const KEY = 'ev-button !h-7 flex-auto !px-3';
/** Display only: a line of keys, which wraps rather than squeezing their words. */
const KEYS = 'flex flex-wrap gap-2';

/** Display only: a magnifying glass for the search field. */
function SearchMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A button that runs one of the application's commands, named and switched off as the command says. */
function CommandButton({ id }: { id: string }) {
  const run = useRunCommand();
  const state = useEditor((s) => s);
  const command = getCommand(id) as Command;
  return (
    <button
      type="button"
      className={KEY}
      title={command.shortcut ? `${command.label} (${command.shortcut})` : command.label}
      disabled={command.enabled ? !command.enabled(state) : false}
      onClick={() => run(command)}
    >
      {command.label}
    </button>
  );
}

/** A line of text that changes the document when it is left or Enter is pressed, and not while it is typed. */
function TextCommit({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit: (value: string) => void; placeholder?: string }) {
  return (
    <input
      aria-label={label}
      className="ev-field min-w-0 flex-1 placeholder:text-faint"
      spellCheck={false}
      placeholder={placeholder}
      defaultValue={value}
      // A new value from the document replaces what is shown.
      key={value}
      onBlur={(event) => {
        if (event.currentTarget.value !== value) onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        event.stopPropagation();
      }}
    />
  );
}

const TYPE_NAMES: Record<ComponentPropType, string> = { BOOLEAN: 'Boolean', TEXT: 'Text', INSTANCE_SWAP: 'Instance swap' };

/** The properties defined on a component or a component set: each can be renamed or removed, and new ones added. */
function PropertiesEditor({ store, owner }: { store: EditorStore; owner: FrameNode }) {
  const apply = (label: string, change: (doc: Document) => Document): void => store.getState().apply(label, change);
  return (
    <div role="group" aria-label="Component properties" className="flex flex-col gap-2 pt-1">
      <span className={CAPTION}>Properties</span>
      {owner.componentProps.length === 0 && <p className="m-0 text-[11px] text-faint">No properties</p>}
      {owner.componentProps.map((prop) => (
        <Row key={prop.id}>
          <TextCommit label={`Name of property ${prop.name}`} value={prop.name} onCommit={(name) => apply('Rename property', (doc) => renameComponentProp(doc, owner.id, prop.id, name))} />
          <span className="w-20 flex-none truncate text-[11px] text-dim">{TYPE_NAMES[prop.type]}</span>
          <button
            type="button"
            className="ev-icon-button !h-6 !w-6"
            aria-label={`Remove property ${prop.name}`}
            title="Remove"
            onClick={() => apply('Remove property', (doc) => removeComponentProp(doc, owner.id, prop.id))}
          >
            <Icon name="minus" size={13} />
          </button>
        </Row>
      ))}
      <div className="flex flex-wrap gap-1.5">
        {(['BOOLEAN', 'TEXT', 'INSTANCE_SWAP'] as const).map((type) => (
          <button
            key={type}
            type="button"
            className="ev-button !h-7 flex-auto !px-2 !text-[11px]"
            aria-label={`Add ${TYPE_NAMES[type].toLowerCase()} property`}
            onClick={() => apply('Add property', (doc) => addComponentProp(doc, owner.id, type)?.doc ?? doc)}
          >
            + {TYPE_NAMES[type]}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What an instance can set of its component: which variant it shows, when
 * its component is one of a set, and a control for each of the component's
 * properties.
 */
function InstanceControls({ store, doc, instance, heading }: { store: EditorStore; doc: Document; instance: FrameNode; heading?: string }) {
  const componentId = instance.componentId;
  if (componentId === null) return null;
  const component = doc.nodes[componentId];
  const set = setOf(doc, componentId);
  const properties = propsOf(doc, componentId);
  const options = set ? variantOptions(doc, set.id) : [];
  if (options.length === 0 && properties.length === 0) return null;
  const apply = (label: string, change: (d: Document) => Document): void => store.getState().apply(label, change);
  const named = (name: string): string => (heading ? `${heading}: ${name}` : name);
  return (
    <div role="group" aria-label={heading ? `Properties of ${heading}` : 'Instance properties'} className={`flex flex-col gap-2 ${heading ? 'pt-1' : ''}`}>
      {heading && <span className={`${CAPTION} truncate`}>{heading}</span>}
      {isComponent(component) &&
        options.map((option) => (
          <Row key={option.name}>
            <span className="w-20 flex-none truncate text-dim" title={option.name}>
              {option.name}
            </span>
            <select
              aria-label={named(`Variant ${option.name}`)}
              className="ev-field min-w-0 flex-1"
              value={component.variantProps[option.name] ?? ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                apply('Change variant', (d) => setInstanceVariant(d, [instance.id], option.name, value));
              }}
            >
              {option.values.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Row>
        ))}
      {properties.map((prop: ComponentProp) => {
        const value = instancePropValue(doc, instance.id, prop.id);
        const set = (next: boolean | string): void => apply('Change property', (d) => setInstanceProp(d, [instance.id], prop.id, next));
        if (prop.type === 'BOOLEAN') {
          return (
            <label key={prop.id} className={CHECK_ROW}>
              <input
                type="checkbox"
                className={CHECKBOX}
                aria-label={named(`Property ${prop.name}`)}
                checked={value === true}
                onChange={(event) => set(event.currentTarget.checked)}
              />
              {prop.name}
            </label>
          );
        }
        return (
          <Row key={prop.id}>
            <span className="w-20 flex-none truncate text-dim" title={prop.name}>
              {prop.name}
            </span>
            {prop.type === 'TEXT' ? (
              <TextCommit label={named(`Property ${prop.name}`)} value={typeof value === 'string' ? value : ''} onCommit={set} />
            ) : (
              // An instance swap, Figma's way: the component's mark inside the left end of the field.
              <Adorned mark={<span className="flex text-accent"><Icon name="instance" size={11} /></span>}>
              <select aria-label={named(`Property ${prop.name}`)} className="ev-field min-w-0 flex-1 !pl-7" value={typeof value === 'string' ? value : ''} onChange={(event) => set(event.currentTarget.value)}>
                {typeof value !== 'string' && <option value="">None</option>}
                {listComponents(doc)
                  .filter((entry) => !getAncestorIds(doc, instance.id).includes(entry.id))
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {setOf(doc, entry.id) ? `${setOf(doc, entry.id)?.name} / ${entry.name}` : entry.name}
                    </option>
                  ))}
              </select>
              </Adorned>
            )}
          </Row>
        );
      })}
    </div>
  );
}

/** The instances directly inside an instance: their properties are offered on the outer one. */
function innerInstances(doc: Document, instanceId: NodeId): FrameNode[] {
  const out: FrameNode[] = [];
  const walk = (parentId: NodeId): void => {
    for (const id of getChildIds(doc, parentId)) {
      const node = doc.nodes[id];
      if (!isLayer(node)) continue;
      if (isInstance(node)) out.push(node);
      else walk(id);
    }
  };
  walk(instanceId);
  return out;
}

const BINDINGS: readonly (readonly [ComponentPropType, 'visible' | 'characters' | 'componentId', string])[] = [
  ['BOOLEAN', 'visible', 'Visibility property'],
  ['TEXT', 'characters', 'Text property'],
  ['INSTANCE_SWAP', 'componentId', 'Instance swap property'],
];

/**
 * What the selected layer is, as far as components go, and what can be done
 * about it: a component set (its variant properties and variants), a
 * component (its description, its properties, which variant it is), an
 * instance (which component and variant it shows, its properties, reset,
 * detach), a layer of a component (the properties it is bound to), or a
 * layer inside an instance.
 */
export function ComponentSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const only = layers.length === 1 ? layers[0] : undefined;
  const instances = layers.filter((layer): layer is FrameNode => isInstance(layer));
  const apply = (label: string, change: (d: Document) => Document): void => store.getState().apply(label, change);

  if (only && only.type === 'FRAME' && only.kind === 'COMPONENT_SET') {
    const options = variantOptions(doc, only.id);
    return (
      <Section title="Component set">
        <span className={CAPTION}>Variant properties</span>
        {options.map((option) => (
          <Row key={option.name}>
            <TextCommit label={`Name of variant property ${option.name}`} value={option.name} onCommit={(name) => apply('Rename variant property', (d) => renameVariantProperty(d, only.id, option.name, name))} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={option.values.join(', ')}>
              {option.values.join(', ')}
            </span>
            <button
              type="button"
              className="ev-icon-button !h-6 !w-6"
              aria-label={`Remove variant property ${option.name}`}
              title="Remove"
              disabled={options.length <= 1}
              onClick={() => apply('Remove variant property', (d) => removeVariantProperty(d, only.id, option.name))}
            >
              <Icon name="minus" size={13} />
            </button>
          </Row>
        ))}
        <div className={KEYS}>
          <button type="button" className={KEY} onClick={() => apply('Add variant property', (d) => addVariantProperty(d, only.id))}>
            Add variant property
          </button>
          <button
            type="button"
            className={KEY}
            onClick={() => {
              let made: NodeId | null = null;
              apply('Add variant', (d) => {
                const out = addVariant(d, only.id);
                made = out?.id ?? null;
                return out?.doc ?? d;
              });
              if (made) store.getState().setSelection([made]);
            }}
          >
            Add variant
          </button>
        </div>
        <PropertiesEditor store={store} owner={only as FrameNode} />
      </Section>
    );
  }

  if (only && isComponent(only)) {
    let count = 0;
    for (const id in doc.nodes) {
      const node = doc.nodes[id];
      if (isInstance(node) && node.componentId === only.id) count++;
    }
    const set = setOf(doc, only.id);
    return (
      <Section title="Component">
        <textarea
          aria-label="Component description"
          // The field's own height and padding are those of a one-line field, so a box of text sets its own over them.
          className="ev-field !h-16 resize-none !py-1.5 placeholder:text-faint"
          placeholder="Description"
          spellCheck={false}
          defaultValue={only.description}
          key={`${only.id}:${only.description}`}
          onBlur={(event) => {
            const description = event.currentTarget.value;
            if (description !== only.description) apply('Change component description', (d) => patchNodes(d, { [only.id]: { description } }));
          }}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <Row>
          <span aria-hidden="true" className="flex flex-none text-accent">
            <Icon name="instance" size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-dim" role="status" aria-label="Instances of this component">
            {count === 1 ? '1 instance' : `${count} instances`}
          </span>
          <CommandButton id="object.createInstance" />
        </Row>
        {set ? (
          // A variant: its value for each of the set's properties. The properties themselves are the set's.
          variantOptions(doc, set.id).map((option) => (
            <Row key={option.name}>
              <span className="w-20 flex-none truncate text-dim" title={option.name}>
                {option.name}
              </span>
              <TextCommit label={`Value of ${option.name}`} value={only.variantProps[option.name] ?? ''} onCommit={(value) => apply('Change variant', (d) => setVariantValue(d, only.id, option.name, value))} />
            </Row>
          ))
        ) : (
          <>
            <div className={KEYS}>
              <CommandButton id="object.createComponentSet" />
            </div>
            <PropertiesEditor store={store} owner={only} />
          </>
        )}
      </Section>
    );
  }

  if (instances.length > 0 && instances.length === layers.length) {
    const componentId = instances.every((instance) => instance.componentId === instances[0]?.componentId) ? (instances[0]?.componentId ?? '') : '';
    // A component cannot be shown inside itself, so the ones these instances are in are left out.
    const above = new Set(instances.flatMap((instance) => getAncestorIds(doc, instance.id)));
    const choices = listComponents(doc).filter((component) => !above.has(component.id));
    const single = instances.length === 1 ? (instances[0] as FrameNode) : null;
    return (
      <Section title="Instance">
        <Row>
          <span className="w-20 flex-none text-dim">Component</span>
          {/* Figma's instance swap: the component's mark inside the left end of the field. */}
          <Adorned mark={<span className="flex text-accent"><Icon name="component" size={12} /></span>}>
          <select
            aria-label="Component shown"
            className="ev-field min-w-0 flex-1 !pl-7"
            value={componentId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              apply('Swap instance', (d) =>
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
                {setOf(doc, component.id) ? `${setOf(doc, component.id)?.name} / ${component.name}` : component.name}
              </option>
            ))}
          </select>
          </Adorned>
        </Row>
        {single && <InstanceControls store={store} doc={doc} instance={single} />}
        {single &&
          // What the instances inside this one can set is offered here too, under their names.
          innerInstances(doc, single.id).map((inner) => <InstanceControls key={inner.id} store={store} doc={doc} instance={inner} heading={inner.name} />)}
        <div className={KEYS}>
          <CommandButton id="object.goToMain" />
          <CommandButton id="object.resetInstance" />
        </div>
        <div className={KEYS}>
          <CommandButton id="object.detachInstance" />
        </div>
      </Section>
    );
  }

  const owner = only ? instanceOf(doc, only.id) : null;
  if (only && owner) {
    const component = owner.componentId ? doc.nodes[owner.componentId] : undefined;
    return (
      <Section title="In an instance">
        <p role="note" aria-label="Part of an instance" className="m-0 rounded-[var(--ev-radius)] bg-field px-2.5 py-2 text-[11px] leading-[1.45] text-dim shadow-[var(--ev-sunk)]">
          This layer belongs to an instance of “{component?.name ?? 'a component'}”. What it shows can be changed here and is kept for this instance; where it is and how big
          are the component’s.
        </p>
      </Section>
    );
  }

  // A layer of a component: the component's properties that it can be bound to.
  const definedOn = only ? propertyOwner(doc, only.id) : null;
  const inside = only ? [only.id, ...getAncestorIds(doc, only.id)].map((id) => doc.nodes[id]).find((node) => isComponent(node)) : undefined;
  if (only && definedOn && inside && only.id !== definedOn.id && only.id !== inside.id) {
    const properties = propsOf(doc, inside.id);
    const offered = BINDINGS.filter(([type]) => canBind(only, type) && properties.some((prop) => prop.type === type));
    if (offered.length === 0) return null;
    return (
      <Section title="Component properties">
        {offered.map(([type, key, label]) => (
          <Row key={type}>
            <span className="w-20 flex-none text-dim">{TYPE_NAMES[type]}</span>
            <select
              aria-label={label}
              className="ev-field min-w-0 flex-1"
              value={only.propRefs[key] ?? ''}
              onChange={(event) => {
                const next = event.currentTarget.value;
                apply('Bind property', (d) => bindProp(d, only.id, type, next === '' ? null : next));
              }}
            >
              <option value="">None</option>
              {properties
                .filter((prop) => prop.type === type)
                .map((prop) => (
                  <option key={prop.id} value={prop.id}>
                    {prop.name}
                  </option>
                ))}
            </select>
          </Row>
        ))}
      </Section>
    );
  }
  return null;
}

/**
 * The components of the file, to find one and place an instance of it. A
 * name with slashes in it ("Buttons/Primary") is filed under what comes
 * before the last slash; a variant is filed under its set.
 */
export function ComponentsPanel() {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const [query, setQuery] = useState('');
  const components = useMemo(() => listComponents(doc), [doc]);
  if (components.length === 0) return null;
  const wanted = query.trim().toLowerCase();
  const found = components.filter((component) => {
    const set = setOf(doc, component.id);
    return wanted === '' || `${libraryOf(doc, component.id)?.name ?? ''}\n${set?.name ?? ''}\n${component.name}\n${component.description}`.toLowerCase().includes(wanted);
  });
  const groups = new Map<string, FrameNode[]>();
  /** The name a component is listed and searched by: a variant's is its set's name and its own. */
  const full = (component: FrameNode): string => {
    const set = setOf(doc, component.id);
    const name = set ? `${set.name}/${component.name}` : component.name;
    // A component from a library is listed under the library's name.
    const library = libraryOf(doc, component.id);
    return library ? `${library.name}/${name}` : name;
  };
  for (const component of found) {
    const name = full(component);
    const slash = name.lastIndexOf('/');
    const group = slash > 0 ? name.slice(0, slash).trim() : '';
    groups.set(group, [...(groups.get(group) ?? []), component]);
  }
  const goTo = (id: NodeId): void => {
    // A component from a library is in the library's file.
    if (libraryOf(doc, id)) return;
    const pageId = getPageIdOf(doc, id);
    if (pageId) store.getState().setPage(pageId);
    store.getState().setSelection([id]);
  };
  return (
    <section aria-label="Components" className="flex max-h-[34%] flex-none flex-col border-b border-line">
      {/* Figma's section head: a quiet sentence-case title. */}
      <header className="flex h-9 flex-none items-center justify-between pl-3 pr-1.5">
        <h2 className="ev-section-title">Components</h2>
      </header>
      <div className="px-2 pb-2">
        <Adorned
          mark={
            <span className="flex text-faint">
              <SearchMark />
            </span>
          }
        >
          <input
            aria-label="Search components"
            className="ev-field w-full !pl-7 placeholder:text-faint"
            placeholder="Search"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </Adorned>
      </div>
      {/* Rows like Figma's assets: inset from the panel's edge, rounded, each with the component's mark. */}
      <ul aria-label="Components" className="m-0 min-h-0 list-none overflow-y-auto p-0 pb-2">
        {found.length === 0 && <li className="mx-1.5 px-2 py-1.5 text-[11px] text-faint">No component matches</li>}
        {[...groups.entries()].map(([group, members]) => (
          <li key={group} className="list-none">
            {group !== '' && <div className="truncate px-3.5 pb-1 pt-2 text-[11px] font-medium text-dim">{group}</div>}
            <ul aria-label={group === '' ? 'Ungrouped components' : group} className="m-0 list-none p-0">
              {members.map((component) => (
                <li
                  key={component.id}
                  className="ev-row mx-1.5 flex h-7 items-center gap-1 rounded-md pl-2 pr-0.5 hover:bg-hover"
                  title={[component.description, libraryOf(doc, component.id) ? `From the library “${libraryOf(doc, component.id)?.name}”. It is edited in that file.` : ''].filter(Boolean).join('\n') || undefined}
                >
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-[4px] border-0 bg-transparent p-0 text-left"
                    aria-label={`Go to component ${full(component)}`}
                    onClick={() => goTo(component.id)}
                  >
                    <span aria-hidden="true" className="flex flex-none text-accent">
                      <Icon name="component" size={12} />
                    </span>
                    <span className="min-w-0 truncate">{group === '' ? component.name : full(component).slice(full(component).lastIndexOf('/') + 1).trim()}</span>
                  </button>
                  <button
                    type="button"
                    className="ev-icon-button !h-6 !w-6"
                    aria-label={`Insert an instance of ${full(component)}`}
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
