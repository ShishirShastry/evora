/**
 * A small XML reader: elements, attributes and text, which is what an SVG
 * file is made of. It runs wherever the core runs, so it does not lean on a
 * browser's parser. Comments, processing instructions and the document type
 * are skipped.
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: (XmlElement | string)[];
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Reads a document and gives its root element. Throws an `XmlError` when it is not well formed. */
export function parseXml(source: string): XmlElement {
  let at = 0;
  const root: XmlElement = { name: '#document', attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  const top = (): XmlElement => stack[stack.length - 1] as XmlElement;
  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open < 0) {
      const rest = source.slice(at);
      if (rest.trim() !== '' && stack.length > 1) top().children.push(decode(rest));
      break;
    }
    if (open > at) {
      const text = source.slice(at, open);
      if (stack.length > 1 && text !== '') top().children.push(decode(text));
    }
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end < 0) throw new XmlError('A comment is not closed.');
      at = end + 3;
    } else if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end < 0) throw new XmlError('A CDATA section is not closed.');
      top().children.push(source.slice(open + 9, end));
      at = end + 3;
    } else if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end < 0) throw new XmlError('A processing instruction is not closed.');
      at = end + 2;
    } else if (source.startsWith('<!', open)) {
      // The document type, with whatever it has in square brackets.
      let depth = 0;
      let end = open + 2;
      for (; end < source.length; end++) {
        const ch = source[end];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      at = end + 1;
    } else if (source[open + 1] === '/') {
      const end = source.indexOf('>', open);
      if (end < 0) throw new XmlError('A closing tag is not finished.');
      const name = source.slice(open + 2, end).trim();
      if (stack.length < 2 || top().name !== name) throw new XmlError(`“</${name}>” closes nothing that is open.`);
      stack.pop();
      at = end + 1;
    } else {
      // An opening tag: its name, then attributes, each name="value" or name='value'.
      const nameMatch = /^[^\s/>]+/.exec(source.slice(open + 1));
      if (!nameMatch) throw new XmlError('A tag has no name.');
      const element: XmlElement = { name: nameMatch[0], attributes: {}, children: [] };
      let cursor = open + 1 + nameMatch[0].length;
      let closed = false;
      let selfClosing = false;
      while (cursor < source.length) {
        const ch = source[cursor] as string;
        if (/\s/.test(ch)) {
          cursor++;
          continue;
        }
        if (ch === '>') {
          closed = true;
          cursor++;
          break;
        }
        if (ch === '/' && source[cursor + 1] === '>') {
          closed = true;
          selfClosing = true;
          cursor += 2;
          break;
        }
        const attribute = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(cursor));
        if (!attribute) throw new XmlError(`An attribute of <${element.name}> is not written name="value".`);
        element.attributes[attribute[1] as string] = decode(attribute[3] ?? attribute[4] ?? '');
        cursor += attribute[0].length;
      }
      if (!closed) throw new XmlError(`<${element.name}> is not finished.`);
      top().children.push(element);
      if (!selfClosing) stack.push(element);
      at = cursor;
    }
  }
  if (stack.length > 1) throw new XmlError(`<${top().name}> is not closed.`);
  const first = root.children.find((child): child is XmlElement => typeof child !== 'string');
  if (!first) throw new XmlError('There is no element in this file.');
  return first;
}

/** The element children of an element. */
export function elements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== 'string');
}

/** All the text in an element and what is in it. */
export function textOf(element: XmlElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

/** The name of an element or attribute without its namespace prefix. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}
