import { expect, test } from 'vitest';
import { cursive, zigzag } from './fixtures';
import { outline } from './outline';

// The outline is what gets painted, so check it in a real renderer: it must
// cover the line it was drawn from and stay close to it.
test('the painted outline covers its samples and nothing far from them', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  svg.append(path);
  document.body.append(svg);
  for (const [samples, style] of [
    [cursive(300), { tool: 'pen', w: 3 }],
    [zigzag(), { tool: 'pen', w: 3 }],
    [cursive(300), { tool: 'hi', w: 14 }],
    [zigzag(), { tool: 'hi', w: 14 }],
  ] as const) {
    path.setAttribute('d', outline(samples, style));
    const pt = svg.createSVGPoint();
    let inside = 0;
    for (const s of samples) {
      pt.x = s.x;
      pt.y = s.y;
      if (path.isPointInFill(pt)) inside++;
    }
    // Tapered pen ends can be thinner than the sensor noise.
    expect(inside / samples.length).toBeGreaterThan(0.95);
    const b = path.getBBox();
    const xs = samples.map((s) => s.x);
    expect(b.x).toBeGreaterThan(Math.min(...xs) - style.w);
    expect(b.x + b.width).toBeLessThan(Math.max(...xs) + style.w);
  }
  svg.remove();
});
