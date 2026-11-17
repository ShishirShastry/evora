// Rename layers: an example plugin with a window.
// The window (ui.html) sends what to do; this code does it, as one undo step.

evora.showUI({ width: 300, height: 196, title: 'Rename layers' });

async function sendSelection() {
  const layers = await evora.getSelection();
  evora.ui.postMessage({ type: 'selection', count: layers.length, first: layers[0] ? layers[0].name : '' });
}

evora.on('selectionchange', sendSelection);
await sendSelection();

/** The new name of a layer: "$&" stands for its old name and "$n" for its number. */
function newName(oldName, message, index) {
  if (message.find) return oldName.split(message.find).join(message.replace);
  return message.pattern.split('$n').join(String(message.start + index)).split('$&').join(oldName);
}

evora.on('message', async (message) => {
  if (message.type === 'cancel') {
    evora.closePlugin();
    return;
  }
  if (message.type !== 'rename') return;
  const layers = await evora.getSelection();
  if (layers.length === 0) {
    evora.notify('Select the layers to rename first.', { error: true });
    return;
  }
  let renamed = 0;
  // All of it is one step in the history, named after this plugin.
  await evora.batch(async () => {
    for (let i = 0; i < layers.length; i++) {
      const name = newName(layers[i].name, message, i);
      if (name && name !== layers[i].name) {
        await evora.setProperties(layers[i].id, { name });
        renamed++;
      }
    }
  });
  evora.notify(renamed === 0 ? 'No names changed.' : `Renamed ${renamed} layer${renamed === 1 ? '' : 's'}.`);
  await sendSelection();
});
