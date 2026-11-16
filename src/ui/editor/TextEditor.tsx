import { useLayoutEffect, useRef } from 'react';
import {
  approximateMeasurer,
  baseCharacterStyle,
  deleteNodes,
  fontString,
  getWorldMatrix,
  isText,
  layoutText,
  paintColor,
  patchNode,
  rangeCharacterStyle,
  replaceText,
  resolveLineHeight,
  setTextCharacters,
  stylesBetween,
  textLayerName,
  type CharacterStyle,
  type NodeId,
  type RangeStylePatch,
  type TextNode,
  type TextStyleRange,
} from '../../core';
import { rgbToCss } from '../../engine/render/paint';
import { getBrowserMeasurer } from '../../engine/text/measure';
import { styleText } from '../../state/commands';
import { useEditor, useEditorContext } from './EditorContext';

interface TextEditorProps {
  id: NodeId;
  /** Called when editing ends, so the canvas can take the keyboard focus back. */
  onDone: () => void;
}

const TEXT_TRANSFORM = { ORIGINAL: 'none', UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' } as const;
/** The name of the highlight that shows the selected text while the keyboard focus is in the properties panel. */
const HIGHLIGHT = 'od-text-selection';
/** Typing within this long of the last keystroke is undone together with it. */
const TYPING_PAUSE_MS = 1000;

interface Snapshot {
  characters: string;
  styleRanges: TextStyleRange[];
  anchor: number;
  focus: number;
}

/** How many characters come before a point of the DOM inside the editor, or null for a point outside it. */
function offsetOf(root: HTMLElement, container: Node, offset: number): number | null {
  if (container !== root && !root.contains(container)) return null;
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

/** The point of the DOM that many characters into the editor. */
function pointAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Text | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (remaining <= text.data.length) return { node: text, offset: remaining };
    remaining -= text.data.length;
    last = text;
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 };
}

/** The colour a text layer's glyphs are shown in while typing: its first visible fill. A gradient shows as its first colour. */
function inkOf(node: TextNode): string {
  const fill = node.fills.find((paint) => paint.visible);
  return fill ? rgbToCss(paintColor(fill), fill.opacity) : 'transparent';
}

/** Writes the layer's text into the editor as one span for each stretch in one style. */
function renderRuns(root: HTMLElement, node: TextNode): void {
  const base = baseCharacterStyle(node);
  const ink = inkOf(node);
  const fragment = document.createDocumentFragment();
  const add = (text: string, style: CharacterStyle): void => {
    if (text === '') return;
    const span = document.createElement('span');
    span.textContent = text;
    // The font shorthand resets the line height, so the line height is set after it.
    span.style.font = fontString(style);
    span.style.lineHeight = `${node.lineHeight ?? Math.round(style.fontSize * 1.2)}px`;
    span.style.letterSpacing = `${style.letterSpacing}px`;
    span.style.textDecoration = style.textDecoration === 'UNDERLINE' ? 'underline' : style.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'none';
    span.style.color = style.color ? rgbToCss(style.color) : ink;
    fragment.appendChild(span);
  };
  let cursor = 0;
  for (const range of node.styleRanges) {
    add(node.characters.slice(cursor, range.start), base);
    add(node.characters.slice(range.start, range.end), rangeCharacterStyle(node, range));
    cursor = range.end;
  }
  add(node.characters.slice(cursor), base);
  // A line break at the very end shows as an empty last line only when something follows it.
  if (node.characters.endsWith('\n')) fragment.appendChild(document.createElement('br'));
  root.replaceChildren(fragment);
}

/**
 * Edits a text layer in place. An editable element is laid exactly over the
 * layer (same fonts, sizes, spacing, rotation and zoom) while the canvas
 * hides the layer's own rendering, so the browser provides the caret, the
 * selection and input methods. The browser never changes the text itself:
 * every insertion and deletion it is about to make is made in the document
 * instead, and the element is redrawn from the document, one span for each
 * stretch in one style. That keeps styled parts on their characters and lets
 * the properties panel restyle the selected part while it has the keyboard
 * focus. All of it happens inside one gesture; finishing commits it as one
 * undo step.
 */
export function TextEditor({ id, onDone }: TextEditorProps) {
  const { store } = useEditorContext();
  const doc = useEditor((s) => s.doc);
  const viewport = useEditor((s) => s.viewport);
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  /** Redraws the editor from the document; set by the effect that owns the editing session. */
  const redraw = useRef<() => void>(() => undefined);
  const node = doc.nodes[id];

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const el: HTMLDivElement = element;

    const first = store.getState();
    // The text tool leaves its gesture open: the layer then exists now but not in the gesture's snapshot.
    const created = first.gesture !== null && !first.gesture.doc.nodes[id];
    first.beginGesture();
    const original = store.getState().doc.nodes[id];
    const session = { created, finished: false, original: isText(original) ? original : null };

    /** The selection inside the text, in characters; `anchor` is the end it was started from. */
    const selection = { anchor: 0, focus: 0 };
    let composing = false;
    /** The layer object the editor's content was last drawn from, and the one this editor's own last edit made. */
    let rendered: TextNode | null = null;
    let own: TextNode | null = null;
    const history: { past: Snapshot[]; future: Snapshot[]; typedAt: number } = { past: [], future: [], typedAt: -Infinity };
    /** When and where the pointer last went down: in the properties panel, focus leaving the text does not end the edit. */
    const lastPress = { time: -Infinity, inTools: false };

    const current = (): TextNode | null => {
      const found = store.getState().doc.nodes[id];
      return isText(found) ? found : null;
    };
    const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

    /** Shows the selection: as the browser's own while the editor has the focus, as a highlight while the panel has it. */
    const showSelection = (): void => {
      const start = Math.min(selection.anchor, selection.focus);
      const end = Math.max(selection.anchor, selection.focus);
      if (document.activeElement === el) {
        registry?.delete(HIGHLIGHT);
        const live = window.getSelection();
        if (!live) return;
        const a = pointAt(el, selection.anchor);
        const b = pointAt(el, selection.focus);
        if (live.anchorNode !== a.node || live.anchorOffset !== a.offset || live.focusNode !== b.node || live.focusOffset !== b.offset) {
          live.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
        }
      } else if (registry && HighlightClass && end > start) {
        const range = document.createRange();
        const a = pointAt(el, start);
        const b = pointAt(el, end);
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        registry.set(HIGHLIGHT, new HighlightClass(range));
      } else registry?.delete(HIGHLIGHT);
    };

    const setSelection = (anchor: number, focus: number): void => {
      selection.anchor = anchor;
      selection.focus = focus;
      store.getState().setTextSelection({ start: Math.min(anchor, focus), end: Math.max(anchor, focus) });
    };

    /** Draws the document's text into the editor if it has changed, and puts the selection back. */
    const sync = (): void => {
      const text = current();
      if (!text || composing) return;
      if (rendered !== text) {
        // A change that did not come from typing here (the properties panel, say) starts the typing history afresh.
        if (rendered !== null && text !== own) {
          history.past = [];
          history.future = [];
        }
        renderRuns(el, text);
        rendered = text;
        const length = text.characters.length;
        if (selection.anchor > length || selection.focus > length) setSelection(Math.min(selection.anchor, length), Math.min(selection.focus, length));
      }
      showSelection();
    };
    redraw.current = sync;

    /** The selection as the browser has it right now. */
    const liveSelection = (): [number, number] => {
      const live = window.getSelection();
      const length = current()?.characters.length ?? 0;
      const a = live?.anchorNode ? offsetOf(el, live.anchorNode, live.anchorOffset) : null;
      const b = live?.focusNode ? offsetOf(el, live.focusNode, live.focusOffset) : null;
      if (a === null || b === null) return [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)];
      return [Math.min(a, b, length), Math.min(Math.max(a, b), length)];
    };

    const ensureGesture = (): void => {
      // Another change (a font chosen in the panel, say) closes the gesture: typing opens the next one.
      if (!store.getState().gesture) store.getState().beginGesture();
    };

    const remember = (text: TextNode, typing: boolean): void => {
      const now = performance.now();
      const joins = typing && history.past.length > 0 && now - history.typedAt < TYPING_PAUSE_MS;
      history.typedAt = typing ? now : -Infinity;
      history.future = [];
      if (!joins) history.past.push({ characters: text.characters, styleRanges: text.styleRanges, anchor: selection.anchor, focus: selection.focus });
    };

    /** Replaces the characters between two positions, in the document, and puts the caret after what was put in. */
    const edit = (from: number, to: number, inserted: string, typing = false): void => {
      const text = current();
      if (!text || session.finished || (from === to && inserted === '')) return;
      remember(text, typing);
      ensureGesture();
      const now = store.getState().doc;
      store.getState().updateGesture(() => replaceText(now, id, from, to, inserted));
      own = current();
      const caret = Math.min(from, to) + inserted.length;
      setSelection(caret, caret);
      sync();
    };

    const restore = (snapshot: Snapshot): void => {
      ensureGesture();
      const now = store.getState().doc;
      store.getState().updateGesture(() => patchNode(now, id, { characters: snapshot.characters, styleRanges: snapshot.styleRanges }));
      own = current();
      setSelection(snapshot.anchor, snapshot.focus);
      sync();
    };
    const step = (from: Snapshot[], to: Snapshot[]): void => {
      const text = current();
      const snapshot = from.pop();
      if (!text || !snapshot) return;
      to.push({ characters: text.characters, styleRanges: text.styleRanges, anchor: selection.anchor, focus: selection.focus });
      history.typedAt = -Infinity;
      restore(snapshot);
    };

    /** Ends the edit in the document: an empty text is not kept, a changed one is named after its content. */
    const complete = (): void => {
      if (session.finished) return;
      session.finished = true;
      registry?.delete(HIGHLIGHT);
      const state = store.getState();
      const edited = state.doc.nodes[id];
      if (!isText(edited)) {
        state.cancelGesture();
        return;
      }
      // The layer is new if the gesture that is still open began before it existed.
      const isNew = state.gesture !== null && !state.gesture.doc.nodes[id];
      if (edited.characters.trim() === '') {
        // Empty text is not kept: a new layer vanishes without a trace, an existing one is deleted.
        if (isNew) state.cancelGesture();
        else {
          ensureGesture();
          const now = store.getState().doc;
          store.getState().updateGesture(() => deleteNodes(now, [id]), []);
          store.getState().commitGesture('Delete text');
        }
        return;
      }
      // The layer is named after its text until the user gives it a name of their own.
      const before = session.original;
      const namedByContent = session.created || !before || before.name === textLayerName(before.characters) || /^Text \d+$/.test(before.name);
      const name = textLayerName(edited.characters);
      if (namedByContent && name !== edited.name) {
        ensureGesture();
        const now = store.getState().doc;
        store.getState().updateGesture(() => patchNode(now, id, { name }));
      }
      store.getState().commitGesture(isNew ? 'Create text' : 'Edit text');
    };

    const finish = (): void => {
      if (session.finished) return;
      complete();
      store.getState().setEditingText(null);
      done.current();
    };

    /** Bold, italic or underline for the selected part, or for all of the text when nothing is selected: on, unless all of it has it already. */
    const toggle = (kind: 'bold' | 'italic' | 'underline'): void => {
      const text = current();
      if (!text) return;
      const start = Math.min(selection.anchor, selection.focus);
      const end = Math.max(selection.anchor, selection.focus);
      const styles = end > start ? stylesBetween(text, start, end) : stylesBetween(text, 0, text.characters.length);
      let patch: RangeStylePatch;
      if (kind === 'bold') patch = { fontWeight: styles.every((style) => style.fontWeight >= 600) ? 400 : 700 };
      else if (kind === 'italic') patch = { italic: !styles.every((style) => style.italic) };
      else patch = { textDecoration: styles.every((style) => style.textDecoration === 'UNDERLINE') ? 'NONE' : 'UNDERLINE' };
      styleText(store, kind === 'bold' ? 'Change font weight' : kind === 'italic' ? 'Change italic' : 'Change text decoration', [id], patch);
      sync();
    };

    const onBeforeInput = (event: InputEvent): void => {
      // While an input method is composing, the browser shows the composition in place; the document catches up when it ends.
      if (event.isComposing || event.inputType === 'insertCompositionText' || event.inputType === 'deleteCompositionText') return;
      event.preventDefault();
      const type = event.inputType;
      if (type === 'historyUndo') return step(history.past, history.future);
      if (type === 'historyRedo') return step(history.future, history.past);
      const length = current()?.characters.length ?? 0;
      let [from, to] = liveSelection();
      const target = event.getTargetRanges?.()[0];
      if (target) {
        const a = offsetOf(el, target.startContainer, target.startOffset);
        const b = offsetOf(el, target.endContainer, target.endOffset);
        if (a !== null && b !== null) [from, to] = [Math.min(a, b, length), Math.min(Math.max(a, b), length)];
      }
      if (type.startsWith('delete')) {
        if (from === to) {
          // The browser did not say what it would delete: one character before the caret, or after it.
          const characters = current()?.characters ?? '';
          if (type.includes('Backward') && from > 0) from -= [...characters.slice(0, from)].pop()?.length ?? 1;
          else if (type.includes('Forward') && to < length) to += String.fromCodePoint(characters.codePointAt(to) as number).length;
        }
        edit(from, to, '');
      } else if (type === 'insertParagraph' || type === 'insertLineBreak') edit(from, to, '\n');
      else if (type.startsWith('insert')) {
        const data = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
        edit(from, to, data.replace(/\r\n?/g, '\n'), type === 'insertText');
      }
      // Formatting commands of the browser (bold and so on) are not used: the shortcuts are handled below.
    };

    const onCompositionStart = (): void => {
      composing = true;
    };
    const onCompositionEnd = (): void => {
      composing = false;
      const text = current();
      if (!text || session.finished) return;
      // What the input method wrote into the element is now taken into the document.
      const typed = (el.textContent ?? '').replace(/\r\n?/g, '\n');
      const live = window.getSelection();
      const at = Math.min(live?.focusNode ? (offsetOf(el, live.focusNode, live.focusOffset) ?? typed.length) : typed.length, typed.length);
      if (typed !== text.characters) {
        remember(text, false);
        ensureGesture();
        const now = store.getState().doc;
        store.getState().updateGesture(() => setTextCharacters(now, id, typed));
        own = current();
      }
      setSelection(at, at);
      rendered = null;
      sync();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape' || (event.key === 'Enter' && mod)) {
        event.preventDefault();
        finish();
      } else if (mod && !event.altKey && event.code === 'KeyZ') {
        event.preventDefault();
        if (event.shiftKey) step(history.future, history.past);
        else step(history.past, history.future);
      } else if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyY') {
        event.preventDefault();
        step(history.future, history.past);
      } else if (mod && !event.altKey && !event.shiftKey && (event.code === 'KeyB' || event.code === 'KeyI' || event.code === 'KeyU')) {
        event.preventDefault();
        toggle(event.code === 'KeyB' ? 'bold' : event.code === 'KeyI' ? 'italic' : 'underline');
      } else if (event.key === 'Tab') event.preventDefault();
      // Keep editor shortcuts from firing while typing.
      event.stopPropagation();
    };

    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const pasted = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
      if (pasted === '') return;
      const [from, to] = liveSelection();
      edit(from, to, pasted);
    };
    const onCut = (event: ClipboardEvent): void => {
      const [from, to] = liveSelection();
      const text = current();
      if (!text || from === to) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', text.characters.slice(from, to));
      edit(from, to, '');
    };
    const refuse = (event: Event): void => event.preventDefault();

    const onSelectionChange = (): void => {
      if (composing || session.finished || document.activeElement !== el) return;
      const live = window.getSelection();
      if (!live || !live.anchorNode || !live.focusNode) return;
      const anchor = offsetOf(el, live.anchorNode, live.anchorOffset);
      const focus = offsetOf(el, live.focusNode, live.focusOffset);
      if (anchor === null || focus === null) return;
      const length = current()?.characters.length ?? 0;
      setSelection(Math.min(anchor, length), Math.min(focus, length));
    };

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      const inEditor = target !== null && el.contains(target);
      lastPress.inTools = target !== null && target.closest('[data-text-tools]') !== null;
      lastPress.time = performance.now();
      // A press anywhere but in the text or in the properties panel ends the edit, wherever the keyboard focus was.
      if (!inEditor && !lastPress.inTools) finish();
    };
    const onBlur = (event: FocusEvent): void => {
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      const pressedInTools = lastPress.inTools && performance.now() - lastPress.time < 500;
      if (next?.closest('[data-text-tools]') || pressedInTools) {
        // The properties panel has the keyboard now; the text stays open and its selection stays marked.
        showSelection();
        return;
      }
      finish();
    };
    const onFocus = (): void => showSelection();

    // Something else can end the edit (Escape pressed elsewhere, undo): then it is completed here.
    const unsubscribe = store.subscribe((state) => {
      if (state.editingTextId !== id) complete();
    });

    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('compositionstart', onCompositionStart);
    el.addEventListener('compositionend', onCompositionEnd);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('paste', onPaste);
    el.addEventListener('cut', onCut);
    el.addEventListener('dragstart', refuse);
    el.addEventListener('drop', refuse);
    el.addEventListener('blur', onBlur);
    el.addEventListener('focus', onFocus);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDown, true);

    // Start with all of the text selected, as a text field does.
    el.focus({ preventScroll: true });
    setSelection(0, session.original?.characters.length ?? 0);
    sync();

    return () => {
      unsubscribe();
      redraw.current = () => undefined;
      registry?.delete(HIGHLIGHT);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('compositionstart', onCompositionStart);
      el.removeEventListener('compositionend', onCompositionEnd);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('cut', onCut);
      el.removeEventListener('dragstart', refuse);
      el.removeEventListener('drop', refuse);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('focus', onFocus);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [store, id]);

  // Whenever the layer changes (typing here, or a setting in the properties panel) the editor is redrawn from it.
  useLayoutEffect(() => {
    redraw.current();
  }, [node]);

  if (!isText(node)) return null;

  const m = getWorldMatrix(doc, id);
  const z = viewport.zoom;
  const lineHeight = resolveLineHeight(node);
  const autoWidth = node.textAutoResize === 'WIDTH_AND_HEIGHT';
  const fill = node.fills.find((paint) => paint.visible);
  const layout = layoutText(node, getBrowserMeasurer() ?? approximateMeasurer);
  // A little slack keeps text that sets its own width from wrapping while a character is being measured.
  const width = autoWidth && (node.textAlign === 'LEFT' || node.textAlign === 'JUSTIFIED') ? node.width + Math.ceil(node.fontSize) : Math.max(1, node.width);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 5,
        transformOrigin: '0 0',
        // A mirrored text is edited as it is drawn: turned over about the middle of its box.
        transform:
          `matrix(${m[0] * z}, ${m[1] * z}, ${m[2] * z}, ${m[3] * z}, ${(m[4] - viewport.x) * z}, ${(m[5] - viewport.y) * z})` +
          (node.flipX || node.flipY
            ? ` translate(${node.flipX ? node.width : 0}px, ${node.flipY ? node.height : 0}px) scale(${node.flipX ? -1 : 1}, ${node.flipY ? -1 : 1})`
            : ''),
        width,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* The bullets or numbers of a list, where the canvas would draw them. They are not part of the text. */}
      {layout.lines.map(
        (line, index) =>
          line.marker && (
            <span
              key={index}
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: line.marker.x,
                top: line.top,
                font: fontString(line.marker.style),
                lineHeight: `${line.height}px`,
                letterSpacing: `${line.marker.style.letterSpacing}px`,
                color: line.marker.style.color ? rgbToCss(line.marker.style.color) : inkOf(node),
                whiteSpace: 'pre',
                pointerEvents: 'none',
              }}
            >
              {line.marker.text}
            </span>
          ),
      )}
      <div
        ref={ref}
        role="textbox"
        aria-label="Edit text"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          minHeight: Math.max(node.height, lineHeight),
          paddingLeft: layout.indent,
          font: fontString(node),
          lineHeight: `${lineHeight}px`,
          letterSpacing: `${node.letterSpacing}px`,
          textAlign: node.textAlign === 'JUSTIFIED' ? 'justify' : (node.textAlign.toLowerCase() as 'left' | 'center' | 'right'),
          textTransform: TEXT_TRANSFORM[node.textCase],
          color: inkOf(node),
          caretColor: fill ? rgbToCss(paintColor(fill)) : 'var(--od-accent)',
          whiteSpace: autoWidth ? 'pre' : 'pre-wrap',
          overflowWrap: 'anywhere',
          userSelect: 'text',
          cursor: 'text',
          outline: '1px solid var(--od-accent)',
          outlineOffset: 1,
        }}
      />
    </div>
  );
}
