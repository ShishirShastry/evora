/**
 * What the editor does with widgets, with the widget's plugin running in its
 * sandbox: placing one, and running a click on one. Each is one change to
 * the document, through the editor store, so it is one undo step and is
 * synchronised on a shared file (everyone sees the same state).
 */
import type { JsonValue, NodeId, Point } from '../core';
import type { EditorStore } from '../state/editorStore';
import type { PluginManifest } from './manifest';
import { drawWidget, insertWidget, type WidgetClick } from './widgets';

/** The part of a running plugin that widgets need: asking its sandbox. */
export interface WidgetRunner {
  request(method: string, args: unknown[]): Promise<unknown>;
}

export class WidgetActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WidgetActionError';
  }
}

function refuseViewOnly(store: EditorStore): void {
  if (store.getState().readOnly) throw new WidgetActionError('This file can only be viewed here, so its widgets cannot be changed.');
}

/** Places a new widget of a plugin on the page shown (or in a frame), drawn from its first state. Returns its frame's ID. */
export async function placeWidget(store: EditorStore, runner: WidgetRunner, manifest: Pick<PluginManifest, 'id' | 'name' | 'widgets'>, widgetId: string, at: Point, parentId?: NodeId): Promise<NodeId> {
  refuseViewOnly(store);
  const declared = manifest.widgets.find((widget) => widget.id === widgetId);
  if (!declared) throw new WidgetActionError(`${manifest.name} has no widget "${widgetId}".`);
  const state = (await runner.request('widget.initial', [widgetId])) as JsonValue;
  const tree = await runner.request('widget.render', [widgetId, state]);
  refuseViewOnly(store);
  let id: NodeId | null = null;
  store.getState().apply(
    `${manifest.name}: ${declared.name}`,
    (doc) => {
      const placed = insertWidget(doc, parentId ?? store.getState().pageId, at, { pluginId: manifest.id, widgetId, name: declared.name }, state, tree);
      id = placed.id;
      return placed.doc;
    },
  );
  if (id === null) throw new WidgetActionError('The widget could not be placed.');
  store.getState().setSelection([id]);
  return id;
}

/**
 * Runs a click on a widget: its handler gives the next state, its render
 * what to draw from it, and both are written as one change. A click on a
 * widget that changed while the plugin worked (someone else clicked it on a
 * shared file) is not lost: the handler ran on the state it was clicked in,
 * and the result is written over whatever is there now, as with any change.
 */
export async function runWidgetClick(store: EditorStore, runner: WidgetRunner, label: string, click: WidgetClick): Promise<JsonValue> {
  refuseViewOnly(store);
  const { widget, frameId } = click;
  const state = (await runner.request('widget.click', [widget.widgetId, click.handler, widget.state, { path: click.path }])) as JsonValue;
  const tree = await runner.request('widget.render', [widget.widgetId, state]);
  refuseViewOnly(store);
  store.getState().apply(label, (doc) => (doc.nodes[frameId] ? drawWidget(doc, frameId, tree, state, widget) : doc));
  return state;
}
