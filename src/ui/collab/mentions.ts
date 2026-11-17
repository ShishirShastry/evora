/**
 * Mentions in comments. A comment's stored text writes a mention as
 * `@[Name](userId)` (see `protocol.ts`); while a comment is being written the
 * field shows it as `@Name`, and the mentions picked from the list are kept
 * beside the text and written back into it when the comment is posted.
 */

export interface Mentionable {
  id: string;
  name: string;
  email?: string;
}

export type BodyPart = { kind: 'text'; text: string } | { kind: 'mention'; name: string; userId: string };

const MENTION = /@\[([^\]]*)\]\(([A-Za-z0-9_-]+)\)/g;

/** Splits a comment's stored text into plain text and mentions, for showing it. */
export function parseBody(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: 'text', text: body.slice(last, at) });
    parts.push({ kind: 'mention', name: match[1] ?? '', userId: match[2] ?? '' });
    last = at + match[0].length;
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
  return parts;
}

/** A comment's text as it reads, with each mention as `@Name`: for previews and notifications. */
export function plainBody(body: string): string {
  return parseBody(body)
    .map((part) => (part.kind === 'text' ? part.text : `@${part.name}`))
    .join('');
}

/** A name as it can stand in a mention: brackets would end it early, and line breaks have no place in it. */
export function mentionName(name: string): string {
  return name.replace(/[[\]()\r\n]/g, '').trim() || 'someone';
}

/**
 * The mention being typed at the caret: an `@` at the start of the text or
 * after a space, followed by up to two words with nothing else between it
 * and the caret. Null when the caret is not in one.
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\r\n@[\]()]/.test(query)) return null;
  // A first name and a last name; a third word means the sentence has moved on.
  if (/\s\S*\s/.test(query) || /^\s/.test(query)) return null;
  return { start: at, query };
}

/** The people whose name or email address matches what has been typed after the `@`, best matches first. */
export function matchMentions<T extends Mentionable>(people: readonly T[], query: string, limit = 6): T[] {
  const wanted = query.trim().toLowerCase();
  const scored: { person: T; score: number }[] = [];
  for (const person of people) {
    const name = person.name.toLowerCase();
    const email = (person.email ?? '').toLowerCase();
    let score = -1;
    if (wanted === '') score = 1;
    else if (name.startsWith(wanted)) score = 4;
    else if (name.split(/\s+/).some((word) => word.startsWith(wanted))) score = 3;
    else if (email.startsWith(wanted)) score = 2;
    else if (name.includes(wanted)) score = 1;
    if (score >= 0) scored.push({ person, score });
  }
  scored.sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name));
  return scored.slice(0, limit).map((entry) => entry.person);
}

/**
 * Puts a picked person in place of the mention being typed (from its `@` to
 * the caret), followed by a space, and says where the caret goes.
 */
export function insertMention(text: string, caret: number, person: Mentionable): { text: string; caret: number } {
  const typing = mentionQueryAt(text, caret);
  const start = typing ? typing.start : caret;
  const inserted = `@${mentionName(person.name)} `;
  const after = text.slice(caret).replace(/^ /, '');
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Writes the mentions picked while typing into the text as `@[Name](userId)`:
 * each `@Name` that is still there, as a whole name (not the start of a longer
 * word). Longer names go first, so "@Ana Lima" is not taken as "@Ana".
 */
export function encodeBody(text: string, picked: readonly Mentionable[]): string {
  const seen = new Set<string>();
  const people = [...picked]
    .filter((person) => (seen.has(person.id) ? false : (seen.add(person.id), true)))
    .sort((a, b) => mentionName(b.name).length - mentionName(a.name).length);
  // Each mention is swapped for a placeholder first, so a shorter name cannot match inside one already written.
  const written: string[] = [];
  let out = text;
  for (const person of people) {
    const name = mentionName(person.name);
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gu');
    out = out.replace(pattern, (_match, lead: string) => {
      written.push(`@[${name}](${person.id})`);
      return `${lead}\u0000${written.length - 1}\u0000`;
    });
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => written[Number(index)] ?? '').trim();
}

/** The reverse of `encodeBody`: a stored text as it is shown in the field, with the mentions it holds. */
export function decodeBody(body: string): { text: string; mentions: Mentionable[] } {
  const mentions: Mentionable[] = [];
  const text = parseBody(body)
    .map((part) => {
      if (part.kind === 'text') return part.text;
      if (!mentions.some((person) => person.id === part.userId)) mentions.push({ id: part.userId, name: part.name });
      return `@${part.name}`;
    })
    .join('');
  return { text, mentions };
}
