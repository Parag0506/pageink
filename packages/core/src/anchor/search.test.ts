import { expect, test } from 'vitest';
import {
  acceptExact,
  contextScore,
  editDistance,
  findExact,
  findFuzzy,
  maxErrors,
  similarity,
} from './search';
import { fold, widenToWords } from './text';

const filler = (n: number, seed = 1) => {
  const words = [
    'alpha',
    'river',
    'stone',
    'quiet',
    'market',
    'lantern',
    'orbit',
    'meadow',
    'copper',
    'signal',
  ];
  let s = seed;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(words[s % words.length]!);
  }
  return out.join(' ');
};

const quoteOf = (text: string, start: number, end: number) => ({
  exact: text.slice(start, end),
  prefix: text.slice(Math.max(0, start - 32), start),
  suffix: text.slice(end, end + 32),
});

test('edit distance and similarity', () => {
  expect(editDistance('kitten', 'sitting')).toBe(3);
  expect(editDistance('', 'abc')).toBe(3);
  expect(similarity('abc', 'abc')).toBe(1);
  expect(similarity('', '')).toBe(1);
});

test('fold and widen', () => {
  expect(fold('  a \n\t b  c ')).toBe('a b c');
  const t = 'the quick brown fox';
  expect(widenToWords(t, 6, 12)).toEqual({ start: 4, end: 15 });
  expect(widenToWords(t, 3, 4)).toEqual({ start: 4, end: 4 });
});

test('exact search picks the repeat whose context matches', () => {
  const text = `one two the same words here and more. ${filler(30)} the same words here but later ${filler(10)}`;
  const second = text.lastIndexOf('the same words here');
  const q = quoteOf(text, second, second + 'the same words here'.length);
  const ms = findExact(text, q, 0);
  expect(ms.length).toBe(2);
  expect(ms[0]!.start).toBe(second);
  expect(acceptExact(ms[0]!, q, ms.length)).toBe(true);
});

test('exact search uses the position when context ties', () => {
  const unit = 'repeat me please. ';
  const text = unit.repeat(5);
  const q = { exact: 'repeat me', prefix: '', suffix: '' };
  const ms = findExact(text, q, unit.length * 3);
  expect(ms[0]!.start).toBe(unit.length * 3);
});

test('short quote with no matching context is refused', () => {
  const text = `${filler(50)} the cat ${filler(50, 7)}`;
  const q = {
    exact: 'the cat',
    prefix: 'completely different words befor',
    suffix: ' and other unrelated text after',
  };
  const ms = findExact(text, q);
  expect(ms.length).toBe(1);
  expect(acceptExact(ms[0]!, q, 1)).toBe(false);
});

test('fuzzy search tolerates edits inside and around the quote', () => {
  const before = `${filler(200)} The committee approved the new budget after a long debate about schools. ${filler(200, 3)}`;
  const s = before.indexOf('The committee');
  const e = before.indexOf('schools.') + 'schools.'.length;
  const q = quoteOf(before, s, e);
  const after = before
    .replace('approved the new budget', 'approved the revised budget')
    .replace('long debate', 'lengthy debate');
  const m = findFuzzy(after, q, s);
  expect(m).not.toBeNull();
  const want = after.indexOf('The committee');
  expect(Math.abs(m!.start - want)).toBeLessThanOrEqual(2);
  expect(m!.score).toBeGreaterThan(0.78);
});

test('fuzzy search returns null when the passage is gone', () => {
  const before = `${filler(300)} The committee approved the new budget after a long debate about schools. ${filler(300, 9)}`;
  const s = before.indexOf('The committee');
  const e = before.indexOf('schools.') + 8;
  const q = quoteOf(before, s, e);
  const after = before.slice(0, s) + before.slice(e);
  expect(findFuzzy(after, q, s)).toBeNull();
});

test('fuzzy search refuses a similar sentence in another place', () => {
  const para = 'The committee approved the new budget after a long debate about schools.';
  const near = 'The council approved a new budget after the long debate about roads.';
  const before = `${filler(100)} ${para} ${filler(100, 5)} ${near} ${filler(100, 11)}`;
  const s = before.indexOf(para);
  const q = quoteOf(before, s, s + para.length);
  const after = before.replace(para, '');
  expect(findFuzzy(after, q, s)).toBeNull();
});

test('allowed errors scale with quote length', () => {
  expect(maxErrors(10)).toBe(1);
  expect(maxErrors(100)).toBe(19);
  expect(maxErrors(1000)).toBe(48);
});

test('context score is 1 for identical context and lower for edits', () => {
  const t = 'aaaa bbbb cccc dddd eeee';
  const q = { exact: 'cccc', prefix: 'aaaa bbbb ', suffix: ' dddd eeee' };
  expect(contextScore(t, 10, 14, q)).toBe(1);
  const t2 = 'zzzz bbbb cccc dddd yyyy';
  expect(contextScore(t2, 10, 14, q)).toBeLessThan(1);
  expect(contextScore(t2, 10, 14, q)).toBeGreaterThan(0.5);
});

// A templated feed: every item has the same sentence with a few words swapped.
const SLOT = ['amber', 'basin', 'cedar', 'delta', 'ember', 'fjord', 'heath', 'inlet', 'jetty', 'kelp'];
const pick = (i: number, k: number) => SLOT[((i * 2654435761 + k * 40503) >>> 7) % SLOT.length]!;
const item = (i: number) =>
  `Entry ${i}: ${pick(i, 1)} ${pick(i, 2)}. Notes on the ${pick(i, 3)} near the ${pick(i, 4)}, recorded after the ${pick(i, 5)} season (item ${i}).`;
const feed = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1)).join(' ');

test('a look-alike item whose context changed on both sides is refused', () => {
  const full = feed(60);
  const own = full.indexOf(item(45));
  const words = `near the ${pick(45, 4)}`;
  const at = own + item(45).indexOf(words);
  const q = quoteOf(full, at, at + words.length);
  // Only the first 20 items have loaded: item 45 is not on the page yet.
  const early = feed(20);
  const ms = findExact(early, q, at);
  expect(ms.length).toBeGreaterThan(0);
  expect(acceptExact(ms[0]!, q, ms.length, ms[1])).toBe(false);
  const line = quoteOf(full, own + 18, own + 90);
  expect(findFuzzy(early, line, own)).toBeNull();
});

test('an edit on one side of the words keeps the match', () => {
  const before = `${filler(80)} For combining strings in more complicated ways, we can instead use the format macro to build them. ${filler(80, 4)}`;
  const s = before.indexOf('instead use');
  const q = quoteOf(before, s, s + 'instead use'.length);
  const after = before.replace(
    'For combining strings in more complicated ways',
    'For more complicated string combining',
  );
  const ms = findExact(after, q, s);
  expect(ms.length).toBe(1);
  expect(ms[0]!.side).toBe(1);
  expect(acceptExact(ms[0]!, q, 1)).toBe(true);
});

test('repeats that agree with the context about equally go to the tray', () => {
  const text = `${filler(40)} stone river the gate opens here at noon. ${filler(40, 2)} stone lake the gate opens here at dusk. ${filler(40, 3)}`;
  const q = { exact: 'the gate', prefix: 'quiet market stone pond ', suffix: ' opens here at dawn.' };
  const ms = findExact(text, q);
  expect(ms.length).toBe(2);
  expect(acceptExact(ms[0]!, q, ms.length, ms[1])).toBe(false);
});

test('a fuzzy match with an equally good near repeat elsewhere goes to the tray', () => {
  const x = 'Notice from the town office, posted.';
  const y = 'Questions go to the clerk by Friday.';
  const para = 'The committee approved the new budget after a long debate.';
  const before = `${filler(60)} ${x} ${para} ${y} ${filler(60, 5)}`;
  const s = before.indexOf(para);
  const q = quoteOf(before, s, s + para.length);
  const block = `${x} ${para.replace('new budget', 'revised budget')} ${y}`;
  expect(findFuzzy(`${filler(60)} ${block} ${filler(60, 5)} ${block} ${filler(60, 6)}`, q, s)).toBeNull();
  expect(findFuzzy(`${filler(60)} ${block} ${filler(60, 5)}`, q, s)).not.toBeNull();
});

test('a word with more repeats than are scored is still found where its context is', () => {
  const lead = 'a b c '.repeat(1200);
  const text = `${lead}the tower was interrupted after it had reached a significantly advanced state of work.`;
  const at = text.indexOf('reached a') + 'reached '.length;
  const q = quoteOf(text, at, at + 1);
  expect(q.exact).toBe('a');
  // The suffix was edited, the prefix was not.
  const after = text.replace('significantly advanced', 'very advanced');
  const ms = findExact(after, q, at);
  expect(ms[0]!.start).toBe(at);
  expect(acceptExact(ms[0]!, q, ms.length, ms[1])).toBe(true);
});

test('only the repeat that kept one side of its context wins a close race', () => {
  const P = 'abcdefghijklmnopqrstuvwxyz012345';
  const S = ' 9876543210zyxwvutsrqponmlkjihgf';
  const q = { exact: 'MARK', prefix: P, suffix: S };
  // First place: the prefix is intact and the suffix is all new.
  const one = `${P}MARK ##############################`;
  // Second place: both sides half changed.
  const two = `XXXXXXXXXXXXXXXXqrstuvwxyz012345MARK 9876543210zyx################`;
  const text = `${one} ... ${two}`;
  const ms = findExact(text, q);
  expect(ms.length).toBe(2);
  expect(ms[0]!.start).toBe(P.length);
  expect(Math.abs(ms[0]!.context - ms[1]!.context)).toBeLessThan(0.1);
  expect(ms[0]!.side).toBe(1);
  expect(acceptExact(ms[0]!, q, ms.length, ms[1])).toBe(true);
});

test('a long quote found once needs its surroundings to agree at least loosely', () => {
  const exact = 'The lighthouse keepers kept a careful log of every passing ship';
  const q = {
    exact,
    prefix: 'In the winter of that year, then ',
    suffix: ' and storm along the northern coast.',
  };
  // Both sides reworded but still about the same thing.
  const loose = `Over the winter months of that year, ${exact} or storm on the coast to the north.`;
  const m1 = findExact(loose, q)[0]!;
  expect(m1.context).toBeGreaterThan(0.3);
  expect(acceptExact(m1, q, 1)).toBe(true);
  // The same sentence pasted into unrelated text: a pull quote, not the place it was written.
  const pasted = `#### 12 ## 7 ### 3 # 99 ##### ${exact} ## 4 ### 81 # 6 #### 2 ## 5`;
  const m2 = findExact(pasted, q)[0]!;
  expect(m2.context).toBeLessThan(0.3);
  expect(acceptExact(m2, q, 1)).toBe(false);
});

test('identical twins are told apart only by a clearly nearer old position', () => {
  const twin = ' Note: the log was kept in ink and never in pencil, so no entry could change. ';
  const text = `${filler(40)}${twin}${filler(40, 2)}${twin}${filler(40, 3)}`;
  const first = text.indexOf(twin) + 1;
  const second = text.lastIndexOf(twin) + 1;
  const q = quoteOf(text, second + 34, second + 44);
  expect(twin.includes(q.prefix + q.exact + q.suffix)).toBe(true);
  // A few characters added above: the old position still points at the second twin.
  let ms = findExact(text, q, second + 34 - 6);
  expect(ms[0]!.start).toBe(second + 34);
  expect(acceptExact(ms[0]!, q, ms.length, ms[1], second + 34 - 6)).toBe(true);
  // Text the size of the gap between them was added: the old position is no help.
  const mid = Math.round((first + second) / 2) + 34;
  ms = findExact(text, q, mid);
  expect(acceptExact(ms[0]!, q, ms.length, ms[1], mid)).toBe(false);
});
