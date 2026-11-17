// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NumberField } from './Fields';

/**
 * A number field of the properties panel: what is typed stays until it is
 * committed, and once committed with Enter the field shows the document's
 * value again, also when someone else changes it while the field still has
 * the keyboard (collaboration).
 */

afterEach(cleanup);

function show(value: number) {
  const commits: number[] = [];
  const view = render(<NumberField label="X position" value={value} onCommit={(next) => commits.push(next)} />);
  const input = screen.getByRole('textbox', { name: 'X position' }) as HTMLInputElement;
  const rerender = (next: number): void => view.rerender(<NumberField label="X position" value={next} onCommit={(n) => commits.push(n)} />);
  return { input, commits, rerender };
}

describe('a number field', () => {
  it('keeps what is being typed when the value changes elsewhere', () => {
    const { input, commits, rerender } = show(10);
    input.focus();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '25' } });
    rerender(40);
    expect(input.value).toBe('25');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(commits).toEqual([25]);
  });

  it('shows the value as it is after Enter, also when someone else changes it while it has the keyboard', () => {
    const { input, commits, rerender } = show(10);
    input.focus();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(commits).toEqual([25]);
    rerender(25);
    expect(input.value).toBe('25');
    // Someone else's change wins: the field says so at once, still selected to be typed over.
    rerender(0);
    expect(input.value).toBe('0');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]);
    // Leaving the field commits nothing more.
    fireEvent.blur(input);
    expect(commits).toEqual([25]);
    // Typing again is an edit of its own.
    input.focus();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    expect(commits).toEqual([25, 7]);
  });
});
