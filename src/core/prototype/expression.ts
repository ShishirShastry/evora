import type { RGB } from '../document/schema';

/**
 * The small language of prototype expressions: what a "Set variable" action
 * computes and what a condition tests.
 *
 *   {count} + 1          a variable, by name, in braces
 *   {name} == "Ada"      strings in single or double quotes
 *   not {open} and {count} >= 3
 *   #FF8800              a colour
 *
 * Numbers, strings, true and false, + - * / %, comparisons, and / or / not
 * (also && || !), and parentheses. `+` joins when either side is a string.
 */

export type Value = number | string | boolean | RGB;

export class ExpressionError extends Error {}

type Token = { kind: 'number'; value: number } | { kind: 'string'; value: string } | { kind: 'variable'; value: string } | { kind: 'colour'; value: RGB } | { kind: 'word'; value: string } | { kind: 'op'; value: string };

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^(\d+\.?\d*|\.\d+)/.exec(source.slice(i));
      if (!match) throw new ExpressionError(`"${ch}" is not a number`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) throw new ExpressionError('A string is not closed');
      tokens.push({ kind: 'string', value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      const end = source.indexOf('}', i + 1);
      if (end < 0) throw new ExpressionError('A variable name is not closed with }');
      tokens.push({ kind: 'variable', value: source.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (ch === '#') {
      const match = /^#([0-9a-fA-F]{6})/.exec(source.slice(i));
      if (!match) throw new ExpressionError('A colour is written #RRGGBB');
      const hex = match[1] as string;
      const part = (at: number): number => parseInt(hex.slice(at, at + 2), 16) / 255;
      tokens.push({ kind: 'colour', value: { r: part(0), g: part(2), b: part(4) } });
      i += 7;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_]+/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'word', value: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`"${ch}" is not understood`);
    tokens.push({ kind: 'op', value: op });
    i += op.length;
  }
  return tokens;
}

export function truthy(value: Value): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  return true;
}

const isColour = (value: Value): value is RGB => typeof value === 'object';

/** A value as text: a whole number without a decimal point, a colour as #RRGGBB. */
export function valueText(value: Value): string {
  if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
  if (isColour(value)) {
    const part = (n: number): string => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');
    return `#${part(value.r)}${part(value.g)}${part(value.b)}`.toUpperCase();
  }
  return String(value);
}

function same(a: Value, b: Value): boolean {
  if (isColour(a) || isColour(b)) return isColour(a) && isColour(b) && valueText(a) === valueText(b);
  return a === b;
}

function number(value: Value, what: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new ExpressionError(`${what} needs numbers`);
}

/**
 * Works out an expression. `lookup` gives the value of a variable by name,
 * or null when there is none of that name. Throws an `ExpressionError` that
 * says what is wrong when the expression cannot be read or worked out.
 */
export function evaluate(source: string, lookup: (name: string) => Value | null): Value {
  const tokens = tokenize(source);
  if (tokens.length === 0) throw new ExpressionError('The expression is empty');
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const takeOp = (...ops: string[]): string | null => {
    const token = peek();
    if (token && ((token.kind === 'op' && ops.includes(token.value)) || (token.kind === 'word' && ops.includes(token.value)))) {
      at++;
      return token.value;
    }
    return null;
  };

  const primary = (): Value => {
    const token = tokens[at++];
    if (!token) throw new ExpressionError('The expression ends too soon');
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'colour') return token.value;
    if (token.kind === 'variable') {
      const value = lookup(token.value);
      if (value === null) throw new ExpressionError(`There is no variable "${token.value}"`);
      return value;
    }
    if (token.kind === 'word') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      throw new ExpressionError(`"${token.value}" is not understood. A variable is written in braces: {${token.value}}`);
    }
    if (token.value === '(') {
      const inner = or();
      if (!takeOp(')')) throw new ExpressionError('A ( is not closed');
      return inner;
    }
    throw new ExpressionError(`"${token.value}" is not expected there`);
  };
  const unary = (): Value => (takeOp('-') ? -number(unary(), 'Negation') : primary());
  const product = (): Value => {
    let left = unary();
    for (let op = takeOp('*', '/', '%'); op; op = takeOp('*', '/', '%')) {
      const a = number(left, 'Arithmetic');
      const b = number(unary(), 'Arithmetic');
      if (op !== '*' && b === 0) throw new ExpressionError('Division by zero');
      left = op === '*' ? a * b : op === '/' ? a / b : a % b;
    }
    return left;
  };
  const sum = (): Value => {
    let left = product();
    for (let op = takeOp('+', '-'); op; op = takeOp('+', '-')) {
      const right = product();
      if (op === '+' && (typeof left === 'string' || typeof right === 'string')) left = valueText(left) + valueText(right);
      else left = op === '+' ? number(left, 'Arithmetic') + number(right, 'Arithmetic') : number(left, 'Arithmetic') - number(right, 'Arithmetic');
    }
    return left;
  };
  const comparison = (): Value => {
    const left = sum();
    const op = takeOp('==', '!=', '<=', '>=', '<', '>');
    if (!op) return left;
    const right = sum();
    if (op === '==') return same(left, right);
    if (op === '!=') return !same(left, right);
    if (typeof left === 'string' && typeof right === 'string') return op === '<' ? left < right : op === '>' ? left > right : op === '<=' ? left <= right : left >= right;
    const a = number(left, 'A comparison');
    const b = number(right, 'A comparison');
    return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
  };
  const not = (): Value => (takeOp('!', 'not') ? !truthy(not()) : comparison());
  const and = (): Value => {
    let left = not();
    while (takeOp('&&', 'and')) {
      const right = not();
      left = truthy(left) && truthy(right);
    }
    return left;
  };
  function or(): Value {
    let left = and();
    while (takeOp('||', 'or')) {
      const right = and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  const result = or();
  if (at < tokens.length) throw new ExpressionError('The expression goes on after it should have ended');
  return result;
}

/** What is wrong with an expression as far as can be told without running it, or null. Variables are taken as given. */
export function expressionProblem(source: string, names: readonly string[]): string | null {
  try {
    evaluate(source, (name) => (names.includes(name) ? 1 : null));
    return null;
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error;
    // With every variable a number, a problem of types may not be one with the real values.
    return /needs numbers|Division by zero/.test(error.message) ? null : error.message;
  }
}
