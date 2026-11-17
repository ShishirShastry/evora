// Vote counter: an example widget plugin. A widget draws itself from its
// state (render) and changes its state when a part of it is clicked
// (handlers). Evora turns what render returns into real layers.

function button(label, name, onClick, background, color) {
  return {
    type: 'frame',
    name,
    direction: 'horizontal',
    width: 32,
    height: 32,
    cornerRadius: 16,
    fill: background,
    align: 'center',
    justify: 'center',
    onClick,
    children: [{ type: 'text', text: label, fontSize: 18, fontWeight: 600, fill: color }],
  };
}

evora.widget.register('counter', {
  initialState: { count: 0 },
  render(state) {
    return {
      type: 'frame',
      name: 'Counter',
      direction: 'horizontal',
      padding: { vertical: 8, horizontal: 10 },
      spacing: 10,
      align: 'center',
      fill: '#ffffff',
      stroke: '#d9d9de',
      strokeWidth: 1,
      cornerRadius: 14,
      children: [
        button('−', 'Take one away', 'decrement', '#f1f1f4', '#18181c'),
        { type: 'text', name: 'Count', text: String(state.count), fontSize: 20, fontWeight: 600, width: 48, textAlign: 'center', fill: '#18181c' },
        button('+', 'Add one', 'increment', '#0d99ff', '#ffffff'),
      ],
    };
  },
  handlers: {
    increment: (state) => ({ ...state, count: state.count + 1 }),
    decrement: (state) => ({ ...state, count: state.count - 1 }),
  },
});

evora.widget.register('upvote', {
  initialState: { votes: 0 },
  render(state) {
    return {
      type: 'frame',
      name: 'Upvote',
      direction: 'vertical',
      padding: 12,
      spacing: 4,
      align: 'center',
      fill: '#fff4c2',
      cornerRadius: 10,
      onClick: 'vote',
      children: [
        { type: 'text', text: '▲', fontSize: 16, fill: '#8a6d00' },
        { type: 'text', name: 'Votes', text: String(state.votes), fontSize: 24, fontWeight: 700, fill: '#3d3000' },
        { type: 'text', text: state.votes === 1 ? 'vote' : 'votes', fontSize: 11, fill: '#8a6d00' },
      ],
    };
  },
  handlers: {
    vote: (state) => ({ ...state, votes: state.votes + 1 }),
  },
});
