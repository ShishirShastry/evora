import { describe, expect, it } from 'vitest';
import { mentionsIn } from './collab/protocol';
import { decodeBody, encodeBody, insertMention, matchMentions, mentionName, mentionQueryAt, parseBody, plainBody } from './ui/collab/mentions';

/**
 * Mentions in comments: finding the `@` being typed, offering the people who
 * match, putting the one picked into the text, writing the comment as the
 * server keeps it (`@[Name](userId)`), and reading it back for showing and
 * for editing.
 */

const ana = { id: 'u1', name: 'Ana Lima', email: 'ana@example.com' };
const anabel = { id: 'u2', name: 'Anabel', email: 'bel@example.com' };
const bob = { id: 'u3', name: 'Bob Stone', email: 'bob@example.com' };
const people = [ana, anabel, bob];

describe('the mention being typed', () => {
  it('is found from the @ to the caret, at the start or after a space', () => {
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('Hi @An', 6)).toEqual({ start: 3, query: 'An' });
    expect(mentionQueryAt('Hi @Ana Li', 10)).toEqual({ start: 3, query: 'Ana Li' });
  });

  it('is not an email address, nor a sentence that has moved on', () => {
    expect(mentionQueryAt('ana@example', 11)).toBeNull();
    expect(mentionQueryAt('Hi @Ana Lima said so', 20)).toBeNull();
    expect(mentionQueryAt('Hi @ ana', 8)).toBeNull();
    expect(mentionQueryAt('No mention here', 15)).toBeNull();
    expect(mentionQueryAt('@Ana\nnext line', 14)).toBeNull();
  });

  it('only counts what is before the caret', () => {
    expect(mentionQueryAt('Hi @Ana, how are you', 7)).toEqual({ start: 3, query: 'Ana' });
  });
});

describe('the people offered', () => {
  it('are everyone for a bare @, by name', () => {
    expect(matchMentions(people, '').map((person) => person.id)).toEqual(['u1', 'u2', 'u3']);
  });

  it('match the start of a name before the start of a later word, then an email address, then anywhere', () => {
    expect(matchMentions(people, 'ana').map((person) => person.id)).toEqual(['u1', 'u2']);
    expect(matchMentions(people, 'sto').map((person) => person.id)).toEqual(['u3']);
    expect(matchMentions(people, 'bel').map((person) => person.id)).toEqual(['u2']);
    expect(matchMentions(people, 'ONE').map((person) => person.id)).toEqual(['u3']);
    expect(matchMentions(people, 'zed')).toEqual([]);
  });

  it('are limited in number', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, name: `Person ${index}` }));
    expect(matchMentions(many, 'per', 6)).toHaveLength(6);
  });
});

describe('putting a mention in', () => {
  it('replaces what was typed after the @ with the name and a space, and moves the caret after it', () => {
    const result = insertMention('Hi @an please look', 6, ana);
    expect(result.text).toBe('Hi @Ana Lima please look');
    expect(result.caret).toBe('Hi @Ana Lima '.length);
  });

  it('goes in at the caret when no @ is being typed', () => {
    expect(insertMention('Ping ', 5, bob)).toEqual({ text: 'Ping @Bob Stone ', caret: 16 });
  });

  it('keeps out of a name what would end a mention early', () => {
    expect(mentionName('Ana [design] (lead)')).toBe('Ana design lead');
    expect(mentionName('[]')).toBe('someone');
  });
});

describe('a comment as the server keeps it', () => {
  it('writes each picked mention as @[Name](userId), and the server finds the same people', () => {
    const body = encodeBody('Hi @Ana Lima and @Bob Stone, see this', [ana, bob]);
    expect(body).toBe('Hi @[Ana Lima](u1) and @[Bob Stone](u3), see this');
    expect(mentionsIn(body)).toEqual(['u1', 'u3']);
  });

  it('does not take a shorter name inside a longer one', () => {
    const annie = { id: 'u4', name: 'Ana' };
    expect(encodeBody('@Ana Lima and @Ana', [annie, ana])).toBe('@[Ana Lima](u1) and @[Ana](u4)');
  });

  it('leaves alone a name that was picked and then changed, and text that only looks like a name', () => {
    expect(encodeBody('@Ana Lim is here', [ana])).toBe('@Ana Lim is here');
    expect(encodeBody('mail ana@Ana Lima', [ana])).toBe('mail ana@Ana Lima');
    expect(encodeBody('@Anabelle', [anabel])).toBe('@Anabelle');
  });

  it('writes every place the same person is mentioned, and trims the text', () => {
    expect(encodeBody('  @Bob Stone, @Bob Stone!  ', [bob, bob])).toBe('@[Bob Stone](u3), @[Bob Stone](u3)!');
  });

  it('is read back into text and mentions for editing, and encodes to the same thing again', () => {
    const body = 'Thanks @[Ana Lima](u1)\nand @[Bob Stone](u3)';
    const decoded = decodeBody(body);
    expect(decoded.text).toBe('Thanks @Ana Lima\nand @Bob Stone');
    expect(decoded.mentions).toEqual([
      { id: 'u1', name: 'Ana Lima' },
      { id: 'u3', name: 'Bob Stone' },
    ]);
    expect(encodeBody(decoded.text, decoded.mentions)).toBe(body);
  });

  it('is split into text and mentions for showing, and read plainly for previews', () => {
    expect(parseBody('@[Ana](u1) look at @[Bob](u3)!')).toEqual([
      { kind: 'mention', name: 'Ana', userId: 'u1' },
      { kind: 'text', text: ' look at ' },
      { kind: 'mention', name: 'Bob', userId: 'u3' },
      { kind: 'text', text: '!' },
    ]);
    expect(plainBody('@[Ana](u1) look at @[Bob](u3)!')).toBe('@Ana look at @Bob!');
    expect(parseBody('no mentions')).toEqual([{ kind: 'text', text: 'no mentions' }]);
  });
});
