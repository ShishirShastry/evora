// Lorem ipsum: fills text with placeholder words. It remembers, in its own
// storage, where in the words it got to, so each fill reads differently.

const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ' +
  'ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in ' +
  'reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in ' +
  'culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

let offset = (await evora.clientStorage.getAsync('offset')) || 0;

/** About `count` words of placeholder text, as sentences of up to nine words. */
function lorem(count) {
  const words = [];
  for (let i = 0; i < Math.max(1, count); i++) words.push(WORDS[(offset + i) % WORDS.length]);
  offset = (offset + count) % WORDS.length;
  const sentences = [];
  for (let i = 0; i < words.length; i += 9) {
    const part = words.slice(i, i + 9).join(' ');
    sentences.push(part[0].toUpperCase() + part.slice(1) + '.');
  }
  return sentences.join(' ');
}

const selection = await evora.getSelection();

if (evora.command === 'paragraph') {
  const anchor = selection[0];
  await evora.createText({
    parentId: anchor ? anchor.parentId : undefined,
    name: 'Lorem ipsum',
    x: anchor ? anchor.x : 0,
    y: anchor ? anchor.y + anchor.height + 24 : 0,
    width: 320,
    textAutoResize: 'HEIGHT',
    characters: lorem(40),
  });
  await evora.clientStorage.setAsync('offset', offset);
  evora.closePlugin('Added a paragraph of placeholder text.');
} else {
  const texts = selection.filter((layer) => layer.type === 'TEXT');
  if (texts.length === 0) {
    evora.closePlugin('Select one or more text layers to fill.');
  } else {
    await evora.batch(async () => {
      for (const text of texts) {
        const words = text.characters.trim() ? text.characters.trim().split(/\s+/).length : 8;
        await evora.setProperties(text.id, { characters: lorem(words) });
      }
    });
    await evora.clientStorage.setAsync('offset', offset);
    evora.closePlugin(`Filled ${texts.length} text layer${texts.length === 1 ? '' : 's'}.`);
  }
}
