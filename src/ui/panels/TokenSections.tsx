import { useState } from 'react';
import {
  addMode,
  applyStyle,
  bindableKeys,
  bindVariable,
  createCollection,
  createStyle,
  createVariable,
  deleteCollection,
  deleteStyle,
  deleteVariable,
  listCollections,
  listLibraries,
  listStyles,
  listVariables,
  modeFor,
  redefineStyle,
  removeMode,
  renameCollection,
  renameMode,
  setVariableMode,
  setVariableValue,
  solidPaint,
  STYLE_TARGETS,
  styleFits,
  updateStyle,
  updateVariable,
  VARIABLE_SCOPES,
  variablesFor,
  type Document,
  type LayerNode,
  type NodeId,
  type RGB,
  type Style,
  type StyleRefs,
  type Variable,
  type VariableCollection,
  type VariableType,
  type VariableValue,
} from '../../core';
import { ColorField } from '../components/ColorField';
import { Dialog } from '../components/Dialog';
import { NumberField } from '../components/Fields';
import { Icon } from '../components/Icon';
import { useEditor, useEditorContext } from '../editor/EditorContext';
import { applyLive, Row, Section } from './panelParts';

/**
 * Styles and variables in the properties panel: which style a layer uses and
 * which variables its properties are bound to, the mode chosen on a frame or
 * a page, and the file's own styles and variables with their values. All of
 * it reads the document and changes it through the operations in
 * `core/ops/tokens`; a change to a style or a variable reaches the layers
 * that use it in the same undo step.
 */

const REF_LABELS: Record<keyof StyleRefs, string> = { fills: 'Fill', strokes: 'Stroke', text: 'Text', effects: 'Effect', grids: 'Grid' };
const TYPE_LABELS: Record<VariableType, string> = { COLOR: 'Colour', FLOAT: 'Number', STRING: 'String', BOOLEAN: 'Boolean' };
const SCOPE_LABELS: Record<string, string> = {
  FILL: 'Fills',
  STROKE: 'Strokes',
  SIZE: 'Width and height',
  GAP: 'Spacing and padding',
  RADIUS: 'Corner radius',
  OPACITY: 'Opacity',
  TEXT: 'Text',
  VISIBILITY: 'Visibility',
};

/** A text input that changes the document when its value is committed (Enter or leaving it), so an edit is one undo step. */
function CommitInput({ label, value, onCommit, className, placeholder }: { label: string; value: string; onCommit: (value: string) => void; className?: string; placeholder?: string }) {
  return (
    <input
      key={value}
      aria-label={label}
      className={`od-field ${className ?? 'min-w-0 flex-1'}`}
      defaultValue={value}
      placeholder={placeholder}
      spellCheck={false}
      onBlur={(event) => {
        if (event.currentTarget.value !== value) onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        else if (event.key === 'Escape') {
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
        event.stopPropagation();
      }}
    />
  );
}

/** A name for something that may have come from a library: with the library's name after it. */
function sourced(doc: Document, name: string, remote: string | null): string {
  if (!remote) return name;
  const library = listLibraries(doc).find((entry) => entry.id === remote);
  return `${name} (${library?.name ?? 'library'})`;
}

/** The styles the selected layers use, one row for each kind of style that fits them all. */
export function StylesSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const ids = layers.map((layer) => layer.id);
  const first = layers[0] as LayerNode;
  const refs = (Object.keys(STYLE_TARGETS) as (keyof StyleRefs)[]).filter((ref) => layers.every((layer) => styleFits(layer, ref)));
  if (refs.length === 0) return null;
  return (
    <Section title="Styles">
      {refs.map((ref) => {
        const styles = listStyles(doc, STYLE_TARGETS[ref].type);
        const used = first.styleRefs[ref];
        const value = layers.every((layer) => layer.styleRefs[ref] === used) ? (used ?? '') : 'mixed';
        const label = `${REF_LABELS[ref]} style`;
        return (
          <Row key={ref}>
            <span className="w-14 flex-none text-dim">{REF_LABELS[ref]}</span>
            <select
              aria-label={label}
              className="od-field min-w-0 flex-1"
              value={value}
              onChange={(event) => {
                const chosen = event.currentTarget.value;
                if (chosen === 'new') {
                  store.getState().apply(`Create ${REF_LABELS[ref].toLowerCase()} style`, (d) => {
                    const made = createStyle(d, first.id, ref);
                    return made ? applyStyle(made.doc, ids, ref, made.id) : d;
                  });
                } else if (chosen.startsWith('set:')) {
                  const styleId = chosen.slice(4);
                  store.getState().apply('Update style from layer', (d) => applyStyle(redefineStyle(d, styleId, first.id, ref), ids, ref, styleId));
                } else if (chosen !== 'mixed') {
                  store.getState().apply(chosen ? `Apply ${REF_LABELS[ref].toLowerCase()} style` : 'Detach style', (d) => applyStyle(d, ids, ref, chosen || null));
                }
              }}
            >
              {value === 'mixed' && <option value="mixed">Mixed</option>}
              <option value="">None</option>
              {styles.map((style) => (
                <option key={style.id} value={style.id}>
                  {sourced(doc, style.name, style.remote)}
                </option>
              ))}
              <option value="new">New style from this layer</option>
              {styles.some((style) => !style.remote) && (
                <optgroup label="Update a style to match this layer">
                  {styles.filter((style) => !style.remote).map((style) => (
                    <option key={style.id} value={`set:${style.id}`}>
                      Update “{style.name}”
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Row>
        );
      })}
    </Section>
  );
}

function variableLabel(doc: Document, variable: Variable): string {
  const collection = doc.variableCollections[variable.collectionId];
  return sourced(doc, listCollections(doc).length > 1 && collection ? `${collection.name} / ${variable.name}` : variable.name, variable.remote);
}

/** The mode of each collection chosen on a page or a frame. Collections with one mode have nothing to choose. */
function ModeRows({ nodeId }: { nodeId: NodeId }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const node = doc.nodes[nodeId];
  const collections = listCollections(doc).filter((collection) => collection.modes.length > 1);
  if (!node || collections.length === 0) return null;
  return (
    <>
      {collections.map((collection) => {
        const inherited = modeFor(doc, node.parentId ?? nodeId, collection.id);
        const fallback = node.parentId === null ? (collection.modes[0] as { id: string }).id : inherited;
        const name = collection.modes.find((mode) => mode.id === fallback)?.name ?? '';
        return (
          <Row key={collection.id}>
            <span className="w-20 flex-none truncate text-dim" title={`${collection.name} mode`}>
              {collection.name}
            </span>
            <select
              aria-label={`${collection.name} mode`}
              className="od-field min-w-0 flex-1"
              value={node.variableModes[collection.id] ?? ''}
              onChange={(event) => {
                const chosen = event.currentTarget.value;
                store.getState().apply('Change mode', (d) => setVariableMode(d, nodeId, collection.id, chosen || null));
              }}
            >
              <option value="">Auto ({name})</option>
              {collection.modes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.name}
                </option>
              ))}
            </select>
          </Row>
        );
      })}
    </>
  );
}

/** The variables the selected layers' properties are bound to, with a way to bind another, and the modes of a frame. */
export function VariablesSection({ layers }: { layers: LayerNode[] }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const [adding, setAdding] = useState('');
  const ids = layers.map((layer) => layer.id);
  const first = layers[0] as LayerNode;
  const hasVariables = Object.keys(doc.variables).length > 0;
  if (!hasVariables && Object.keys(first.boundVariables).length === 0) return null;
  // What can be bound on every selected layer.
  const keys = bindableKeys(first).filter((entry) => layers.every((layer) => bindableKeys(layer).some((other) => other.key === entry.key)));
  const bound = keys.filter((entry) => layers.some((layer) => layer.boundVariables[entry.key]));
  const free = keys.filter((entry) => !bound.includes(entry) && variablesFor(doc, first, entry.key).length > 0);
  const shown = [...bound, ...free.filter((entry) => entry.key === adding)];
  const frame = layers.length === 1 && first.type === 'FRAME';
  return (
    <Section title="Variables">
      {shown.map((entry) => {
        const used = first.boundVariables[entry.key];
        const value = layers.every((layer) => layer.boundVariables[entry.key] === used) ? (used ?? '') : 'mixed';
        return (
          <Row key={entry.key}>
            <span className="w-20 flex-none truncate text-dim" title={entry.label}>
              {entry.label}
            </span>
            <select
              aria-label={`${entry.label} variable`}
              className="od-field min-w-0 flex-1"
              value={value}
              onChange={(event) => {
                const chosen = event.currentTarget.value;
                if (chosen === 'mixed') return;
                store.getState().apply(chosen ? 'Bind variable' : 'Unbind variable', (d) => bindVariable(d, ids, entry.key, chosen || null));
                setAdding('');
              }}
            >
              {value === 'mixed' && <option value="mixed">Mixed</option>}
              <option value="">None</option>
              {variablesFor(doc, first, entry.key).map((variable) => (
                <option key={variable.id} value={variable.id}>
                  {variableLabel(doc, variable)}
                </option>
              ))}
            </select>
          </Row>
        );
      })}
      {free.length > 0 && (
        <select aria-label="Bind a property to a variable" className="od-field" value="" onChange={(event) => setAdding(event.currentTarget.value)}>
          <option value="">Bind a property…</option>
          {free.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
      )}
      {shown.length === 0 && free.length === 0 && <p className="m-0 text-faint">No variable fits a property of this layer.</p>}
      {frame && <ModeRows nodeId={first.id} />}
    </Section>
  );
}

function StyleRow({ style }: { style: Style }) {
  const { store } = useEditorContext();
  const paint = style.paints[0];
  const apply = (label: string, change: Partial<Omit<Style, 'id' | 'type'>>): void => store.getState().apply(label, (d) => updateStyle(d, style.id, change));
  return (
    <li className="flex flex-col gap-1 rounded border border-line p-1.5" aria-label={`Style ${style.name}`}>
      <Row>
        <CommitInput label={`Name of style ${style.name}`} value={style.name} onCommit={(name) => apply('Rename style', { name })} />
        <button type="button" className="od-icon-button flex-none" aria-label={`Delete style ${style.name}`} title="Delete style" onClick={() => store.getState().apply('Delete style', (d) => deleteStyle(d, style.id))}>
          <Icon name="close" />
        </button>
      </Row>
      {style.type === 'PAINT' && paint?.type === 'SOLID' && style.paints.length === 1 && (
        <Row>
          <ColorField
            label={`Colour of style ${style.name}`}
            value={paint.color}
            onChange={(color, phase) => applyLive(store, 'Change style colour', phase, (d) => updateStyle(d, style.id, { paints: [{ ...paint, color }] }))}
          />
        </Row>
      )}
      {style.type === 'PAINT' && !(paint?.type === 'SOLID' && style.paints.length === 1) && (
        <p className="m-0 text-faint">{style.paints.length} paints. To change them, edit a layer and choose “Update” in its style menu.</p>
      )}
      {style.type === 'TEXT' && (
        <Row>
          <CommitInput label={`Font of style ${style.name}`} value={style.text.fontFamily} onCommit={(fontFamily) => fontFamily.trim() && apply('Change text style', { text: { ...style.text, fontFamily: fontFamily.trim() } })} />
          <div className="w-16 flex-none">
            <NumberField label={`Size of style ${style.name}`} value={style.text.fontSize} min={1} max={2000} onCommit={(fontSize) => apply('Change text style', { text: { ...style.text, fontSize } })} />
          </div>
          <div className="w-16 flex-none">
            <NumberField
              label={`Weight of style ${style.name}`}
              value={style.text.fontWeight}
              min={100}
              max={900}
              onCommit={(weight) => apply('Change text style', { text: { ...style.text, fontWeight: Math.round(weight / 100) * 100 } })}
            />
          </div>
        </Row>
      )}
      {(style.type === 'EFFECT' || style.type === 'GRID') && (
        <p className="m-0 text-faint">
          {style.type === 'EFFECT' ? `${style.effects.length} effects` : `${style.grids.length} grids`}. To change them, edit a layer and choose “Update” in its style menu.
        </p>
      )}
      <CommitInput label={`Description of style ${style.name}`} value={style.description} placeholder="Description" onCommit={(description) => apply('Describe style', { description })} />
    </li>
  );
}

/** The file's styles and variables, shown with the page's properties when nothing is selected. */
export function LocalTokens() {
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const [open, setOpen] = useState(false);
  // What came from a library is edited in the library's file; here it is only counted.
  const styles = listStyles(doc).filter((style) => !style.remote);
  const remoteStyles = listStyles(doc).length - styles.length;
  const count = Object.values(doc.variables).filter((variable) => !variable.remote).length;
  const remoteVariables = Object.keys(doc.variables).length - count;
  const localCollections = listCollections(doc).filter((collection) => !collection.remote).length;
  return (
    <>
      <Section title="Local styles">
        {styles.length === 0 && <p className="m-0 text-faint">No styles yet. Select a layer and choose “New style from this layer” under Styles.</p>}
        {remoteStyles > 0 && <p className="m-0 text-dim">{remoteStyles} more from libraries, which are edited in the library’s file.</p>}
        {(['PAINT', 'TEXT', 'EFFECT', 'GRID'] as const).map((type) => {
          const group = styles.filter((style) => style.type === type);
          if (group.length === 0) return null;
          return (
            <div key={type} className="flex flex-col gap-1">
              <span className="text-dim">{{ PAINT: 'Colour', TEXT: 'Text', EFFECT: 'Effect', GRID: 'Grid' }[type]} styles</span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {group.map((style) => (
                  <StyleRow key={style.id} style={style} />
                ))}
              </ul>
            </div>
          );
        })}
      </Section>
      <Section title="Local variables">
        <Row>
          <span className="flex-1 text-dim">{count === 0 ? 'No variables yet.' : `${count} ${count === 1 ? 'variable' : 'variables'} in ${localCollections} ${localCollections === 1 ? 'collection' : 'collections'}`}
            {remoteVariables > 0 ? ` ${remoteVariables} more from libraries.` : ''}</span>
          <button type="button" className="od-button !h-[26px] flex-none !px-2" onClick={() => setOpen(true)}>
            Edit variables
          </button>
        </Row>
        <ModeRows nodeId={pageId} />
      </Section>
      {open && <VariablesDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** One value of a variable in one mode: its own editor by type, or another variable it stands for. */
function ValueCell({ variable, modeId, modeName }: { variable: Variable; modeId: string; modeName: string }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const value = variable.valuesByMode[modeId];
  const alias = typeof value === 'object' && value !== null && 'alias' in value ? value.alias : '';
  const set = (next: VariableValue, phase: 'live' | 'commit' = 'commit'): void => applyLive(store, 'Change variable', phase, (d) => setVariableValue(d, variable.id, modeId, next));
  const name = `${variable.name} in ${modeName}`;
  // The variables it could stand for: of its type, and not ones that already stand for it.
  const others = listVariables(doc).filter((other) => other.id !== variable.id && other.type === variable.type && setVariableValue(doc, variable.id, modeId, { alias: other.id }) !== doc);
  const blank: VariableValue = variable.type === 'COLOR' ? { r: 0, g: 0, b: 0 } : variable.type === 'FLOAT' ? 0 : variable.type === 'STRING' ? '' : false;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {alias === '' && variable.type === 'COLOR' && <ColorField label={name} value={value as RGB} onChange={(color, phase) => set(color, phase)} />}
      {alias === '' && variable.type === 'FLOAT' && (
        <div className="w-20 flex-none">
          <NumberField label={name} value={value as number} onCommit={(number) => set(number)} />
        </div>
      )}
      {alias === '' && variable.type === 'STRING' && <CommitInput label={name} value={value as string} onCommit={(text) => set(text)} />}
      {alias === '' && variable.type === 'BOOLEAN' && (
        <label className="flex items-center gap-1">
          <input type="checkbox" aria-label={name} checked={value === true} onChange={(event) => set(event.currentTarget.checked)} />
          {value === true ? 'True' : 'False'}
        </label>
      )}
      {(others.length > 0 || alias !== '') && (
        <select
          aria-label={`${name} stands for`}
          className={`od-field ${alias === '' ? 'w-9 flex-none' : 'min-w-0 flex-1'}`}
          title="Stand for another variable"
          value={alias}
          onChange={(event) => {
            const chosen = event.currentTarget.value;
            // Back to a value of its own: what it stood for, as it is here.
            set(chosen ? { alias: chosen } : blank);
          }}
        >
          <option value="">{alias === '' ? '=' : 'Own value'}</option>
          {alias !== '' && !others.some((other) => other.id === alias) && <option value={alias}>{doc.variables[alias] ? variableLabel(doc, doc.variables[alias] as Variable) : 'Missing variable'}</option>}
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              {alias === other.id ? `= ${variableLabel(doc, other)}` : variableLabel(doc, other)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function VariableRow({ variable, collection }: { variable: Variable; collection: VariableCollection }) {
  const { store } = useEditorContext();
  const [details, setDetails] = useState(false);
  return (
    <>
      <tr>
        <td className="py-1 pr-2 align-middle">
          <CommitInput label={`Name of variable ${variable.name}`} value={variable.name} className="w-full" onCommit={(name) => store.getState().apply('Rename variable', (d) => updateVariable(d, variable.id, { name }))} />
        </td>
        <td className="py-1 pr-2 align-middle text-dim">{TYPE_LABELS[variable.type]}</td>
        {collection.modes.map((mode) => (
          <td key={mode.id} className="py-1 pr-2 align-middle">
            <ValueCell variable={variable} modeId={mode.id} modeName={mode.name} />
          </td>
        ))}
        <td className="whitespace-nowrap py-1 align-middle">
          <button type="button" className="od-button !h-[24px] !px-1.5" aria-expanded={details} aria-label={`Details of variable ${variable.name}`} onClick={() => setDetails(!details)}>
            Details
          </button>
          <button type="button" className="od-icon-button" aria-label={`Delete variable ${variable.name}`} title="Delete variable" onClick={() => store.getState().apply('Delete variable', (d) => deleteVariable(d, variable.id))}>
            <Icon name="close" />
          </button>
        </td>
      </tr>
      {details && (
        <tr>
          <td colSpan={collection.modes.length + 3} className="pb-2">
            <div className="flex flex-col gap-1.5 rounded border border-line p-2">
              <CommitInput
                label={`Description of variable ${variable.name}`}
                value={variable.description}
                placeholder="Description"
                className="w-full"
                onCommit={(description) => store.getState().apply('Describe variable', (d) => updateVariable(d, variable.id, { description }))}
              />
              <fieldset className="m-0 flex flex-wrap gap-x-3 gap-y-1 border-0 p-0">
                <legend className="mb-1 p-0 text-dim">Offered for (nothing ticked: everything it fits)</legend>
                {VARIABLE_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      aria-label={`Offer ${variable.name} for ${SCOPE_LABELS[scope]}`}
                      checked={variable.scopes.includes(scope)}
                      onChange={(event) => {
                        const scopes = event.currentTarget.checked ? [...variable.scopes, scope] : variable.scopes.filter((entry) => entry !== scope);
                        store.getState().apply('Change variable scope', (d) => updateVariable(d, variable.id, { scopes }));
                      }}
                    />
                    {SCOPE_LABELS[scope]}
                  </label>
                ))}
              </fieldset>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The file's variables: collections, their modes, and each variable's value in each mode. */
export function VariablesDialog({ onClose }: { onClose: () => void }) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  // Collections that came from a library are edited in the library's file.
  const collections = listCollections(doc).filter((entry) => !entry.remote);
  const [chosen, setChosen] = useState('');
  const collection = collections.find((entry) => entry.id === chosen) ?? collections[0];
  const create = (): void => {
    let id = '';
    store.getState().apply('Create variable collection', (d) => {
      const made = createCollection(d);
      id = made.id;
      return made.doc;
    });
    setChosen(id);
  };
  return (
    <Dialog title="Variables" onClose={onClose} width={860}>
      <div className="flex flex-col gap-3" data-text-tools>
        <Row>
          {collections.length > 0 && (
            <select aria-label="Collection" className="od-field w-48 flex-none" value={collection?.id ?? ''} onChange={(event) => setChosen(event.currentTarget.value)}>
              {collections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="od-button !h-[26px] flex-none !px-2" data-autofocus onClick={create}>
            New collection
          </button>
          {collection && (
            <>
              <CommitInput label="Collection name" value={collection.name} className="w-40 flex-none" onCommit={(name) => store.getState().apply('Rename collection', (d) => renameCollection(d, collection.id, name))} />
              <button type="button" className="od-button !h-[26px] flex-none !px-2" onClick={() => store.getState().apply('Delete collection', (d) => deleteCollection(d, collection.id))}>
                Delete collection
              </button>
            </>
          )}
        </Row>
        {!collection && <p className="m-0 text-dim">Variables are kept in collections. A collection can have several modes, such as Light and Dark, and each variable has a value in every mode.</p>}
        {collection && (
          <>
            <table className="w-full border-collapse text-left" aria-label={`Variables of ${collection.name}`}>
              <thead>
                <tr>
                  <th className="w-44 pb-1 pr-2 font-normal text-dim">Name</th>
                  <th className="w-16 pb-1 pr-2 font-normal text-dim">Type</th>
                  {collection.modes.map((mode) => (
                    <th key={mode.id} className="pb-1 pr-2 font-normal">
                      <div className="flex items-center gap-1">
                        <CommitInput label={`Name of mode ${mode.name}`} value={mode.name} className="min-w-0 flex-1" onCommit={(name) => store.getState().apply('Rename mode', (d) => renameMode(d, collection.id, mode.id, name))} />
                        {collection.modes.length > 1 && (
                          <button type="button" className="od-icon-button flex-none" aria-label={`Remove mode ${mode.name}`} title="Remove mode" onClick={() => store.getState().apply('Remove mode', (d) => removeMode(d, collection.id, mode.id))}>
                            <Icon name="close" />
                          </button>
                        )}
                      </div>
                    </th>
                  ))}
                  <th className="w-24 pb-1 font-normal">
                    <button type="button" className="od-button !h-[24px] !px-1.5" onClick={() => store.getState().apply('Add mode', (d) => addMode(d, collection.id)?.doc ?? d)}>
                      Add mode
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listVariables(doc, collection.id).map((variable) => (
                  <VariableRow key={variable.id} variable={variable} collection={collection} />
                ))}
              </tbody>
            </table>
            {listVariables(doc, collection.id).length === 0 && <p className="m-0 text-faint">No variables in this collection yet.</p>}
            <Row>
              <span className="flex-none text-dim">Add a variable:</span>
              {(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  className="od-button !h-[26px] flex-none !px-2"
                  onClick={() => store.getState().apply('Create variable', (d) => createVariable(d, collection.id, type, undefined, type === 'COLOR' ? solidPaint({ r: 0.5, g: 0.5, b: 0.5 }).color : undefined)?.doc ?? d)}
                >
                  {TYPE_LABELS[type]}
                </button>
              ))}
            </Row>
          </>
        )}
      </div>
    </Dialog>
  );
}
