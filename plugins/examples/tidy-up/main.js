// Tidy up: an example plugin without a window. It runs, changes the file as
// one undo step, says what it did, and closes.

const GRID = 8;
const GAP = 16;
const layers = await evora.getSelection();

if (layers.length === 0) {
  evora.closePlugin('Select some layers to tidy up first.');
  return;
}

const snap = (value) => Math.round(value / GRID) * GRID;
const plural = (count) => `${count} layer${count === 1 ? '' : 's'}`;

if (evora.command === 'snap') {
  await evora.batch(async () => {
    for (const layer of layers) {
      await evora.setProperties(layer.id, {
        x: snap(layer.x),
        y: snap(layer.y),
        width: Math.max(GRID, snap(layer.width)),
        height: Math.max(GRID, snap(layer.height)),
      });
    }
  });
  evora.closePlugin(`Snapped ${plural(layers.length)} to the ${GRID} px grid.`);
} else {
  // Reading order: top to bottom, then left to right.
  const ordered = [...layers].sort((a, b) => a.y - b.y || a.x - b.x);
  const columns = Math.ceil(Math.sqrt(ordered.length));
  const cell = {
    width: Math.max(...ordered.map((layer) => layer.width)),
    height: Math.max(...ordered.map((layer) => layer.height)),
  };
  const left = Math.min(...ordered.map((layer) => layer.x));
  const top = Math.min(...ordered.map((layer) => layer.y));
  await evora.batch(async () => {
    for (let i = 0; i < ordered.length; i++) {
      await evora.setProperties(ordered[i].id, {
        x: left + (i % columns) * (cell.width + GAP),
        y: top + Math.floor(i / columns) * (cell.height + GAP),
      });
    }
  });
  evora.closePlugin(`Arranged ${plural(ordered.length)} in ${columns} column${columns === 1 ? '' : 's'}.`);
}
