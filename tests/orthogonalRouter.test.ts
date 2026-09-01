import assert from 'node:assert/strict';
import test from 'node:test';
import { routeOrthogonally, type RouteBox, type RouteEnds, type RouterOptions } from '../src/orthogonalRouter';
import type { Point } from '../src/graphLayout';

const options: RouterOptions = {
  clearance: 12,
  turnCost: 40,
  congestionCost: 30,
  maxLines: 240,
};

const box = (id: string, x: number, y: number, width = 160, height = 60): RouteBox =>
  ({ id, x, y, width, height });

const link = (from: string, to: string): RouteEnds => ({ id: `${from}->${to}`, from, to });

const route = (
  boxes: readonly RouteBox[],
  ends: readonly RouteEnds[],
  overrides: Partial<RouterOptions> = {},
): Map<string, Point[]> => routeOrthogonally(boxes, ends, { ...options, ...overrides });

const at = (routes: Map<string, Point[]>, id: string): Point[] => {
  const points = routes.get(id);
  assert.ok(points, `${id} must be routed`);
  assert.ok(points.length >= 2, `${id} must have at least two points`);
  return points;
};

/** Every segment runs along one axis; a diagonal is not an orthogonal route. */
const assertOrthogonal = (points: readonly Point[], id: string): void => {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const one = points[index];
    const next = points[index + 1];
    assert.ok(one && next);
    const straight = Math.abs(one.x - next.x) < 0.51 || Math.abs(one.y - next.y) < 0.51;
    assert.ok(straight, `${id} has a diagonal from (${one.x}, ${one.y}) to (${next.x}, ${next.y})`);
  }
};

/** How far a segment reaches into a box, ignoring the two it connects. */
const intrusion = (points: readonly Point[], boxes: readonly RouteBox[], ends: readonly string[]): number => {
  let worst = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const one = points[index];
    const next = points[index + 1];
    if (!one || !next) {
      continue;
    }
    const minX = Math.min(one.x, next.x);
    const maxX = Math.max(one.x, next.x);
    const minY = Math.min(one.y, next.y);
    const maxY = Math.max(one.y, next.y);
    for (const obstacle of boxes) {
      if (ends.includes(obstacle.id)) {
        continue;
      }
      const overlapX = Math.min(maxX, obstacle.x + obstacle.width) - Math.max(minX, obstacle.x);
      const overlapY = Math.min(maxY, obstacle.y + obstacle.height) - Math.max(minY, obstacle.y);
      if (overlapX > 0 && overlapY > 0) {
        worst = Math.max(worst, Math.min(overlapX, overlapY));
      }
    }
  }
  return worst;
};

const onBorder = (point: Point, target: RouteBox): boolean => {
  const withinX = point.x >= target.x - 0.51 && point.x <= target.x + target.width + 0.51;
  const withinY = point.y >= target.y - 0.51 && point.y <= target.y + target.height + 0.51;
  const onVertical = Math.abs(point.x - target.x) < 0.51 || Math.abs(point.x - (target.x + target.width)) < 0.51;
  const onHorizontal = Math.abs(point.y - target.y) < 0.51 || Math.abs(point.y - (target.y + target.height)) < 0.51;
  return withinX && withinY && (onVertical || onHorizontal);
};

test('a route is made of axis-aligned segments only', () => {
  const boxes = [box('a', 0, 0), box('b', 400, 300)];
  const routes = route(boxes, [link('a', 'b')]);
  assertOrthogonal(at(routes, 'a->b'), 'a->b');
});

test('a route starts and ends on the borders of the boxes it joins', () => {
  const boxes = [box('a', 0, 0), box('b', 400, 300)];
  const points = at(route(boxes, [link('a', 'b')]), 'a->b');
  const first = points[0];
  const last = points[points.length - 1];
  assert.ok(first && last);
  assert.ok(onBorder(first, boxes[0] as RouteBox), 'the route must leave from a border');
  assert.ok(onBorder(last, boxes[1] as RouteBox), 'the route must arrive at a border');
});

test('a route goes around a box standing between its ends', () => {
  // A wall directly on the straight line from a to b.
  const boxes = [box('a', 0, 100), box('wall', 220, 60, 120, 200), box('b', 500, 100)];
  const points = at(route(boxes, [link('a', 'b')]), 'a->b');
  assertOrthogonal(points, 'a->b');
  assert.ok(
    intrusion(points, boxes, ['a', 'b']) < 1,
    `the route cut ${intrusion(points, boxes, ['a', 'b']).toFixed(1)}px into the wall`,
  );
});

test('no route crosses a box it does not belong to', () => {
  // A grid of boxes with edges wired across it, so most routes must detour.
  const boxes: RouteBox[] = [];
  for (let column = 0; column < 5; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      boxes.push(box(`n${column}-${row}`, column * 260, row * 150));
    }
  }
  const ends = [
    link('n0-0', 'n4-3'),
    link('n0-3', 'n4-0'),
    link('n2-0', 'n2-3'),
    link('n0-1', 'n3-2'),
    link('n1-3', 'n4-1'),
  ];
  const routes = route(boxes, ends);
  for (const end of ends) {
    const points = at(routes, end.id);
    assertOrthogonal(points, end.id);
    const cut = intrusion(points, boxes, [end.from, end.to]);
    assert.ok(cut < 1, `${end.id} cut ${cut.toFixed(1)}px into a box`);
  }
});

test('edges leaving one box leave from different points on it', () => {
  const boxes = [
    box('hub', 0, 300),
    box('t0', 400, 0),
    box('t1', 400, 200),
    box('t2', 400, 400),
    box('t3', 400, 600),
  ];
  const ends = ['t0', 't1', 't2', 't3'].map((target) => link('hub', target));
  const routes = route(boxes, ends);
  const starts = ends.map((end) => at(routes, end.id)[0]?.y ?? 0);
  const unique = new Set(starts.map((value) => Math.round(value)));
  assert.equal(unique.size, ends.length, `four edges shared a port: ${starts.join(', ')}`);
});

test('two edges running the same way do not share one line', () => {
  // Both go left to right through the same gap; the second must take another.
  const boxes = [box('a', 0, 0), box('b', 0, 200), box('c', 600, 0), box('d', 600, 200)];
  const routes = route(boxes, [link('a', 'd'), link('b', 'c')]);
  const one = at(routes, 'a->d');
  const other = at(routes, 'b->c');
  const verticals = (points: readonly Point[]): number[] => {
    const found: number[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (from && to && Math.abs(from.x - to.x) < 0.51 && Math.abs(from.y - to.y) > 1) {
        found.push(Math.round(from.x));
      }
    }
    return found;
  };
  const shared = verticals(one).filter((value) => verticals(other).includes(value));
  assert.equal(shared.length, 0, `both routes ran down x=${shared.join(', ')}`);
});

test('a direct edge is bent once and never searched', () => {
  const boxes = [box('a', 0, 0), box('wall', 220, -40, 120, 200), box('b', 500, 0)];
  const routes = routeOrthogonally(boxes, [{ id: 'a->b', from: 'a', to: 'b', direct: true }], options);
  const points = at(routes, 'a->b');
  assertOrthogonal(points, 'a->b');
  // One bend means at most four points once the collinear ones are dropped.
  assert.ok(points.length <= 4, `a direct edge came back with ${points.length} points`);
});

test('the same diagram is always routed the same way', () => {
  const boxes = [box('a', 0, 0), box('b', 300, 180), box('c', 620, 40), box('d', 300, 400)];
  const ends = [link('a', 'b'), link('b', 'c'), link('a', 'd'), link('d', 'c')];
  const first = route(boxes, ends);
  const second = route([...boxes].reverse(), [...ends].reverse());
  for (const end of ends) {
    assert.deepEqual(at(first, end.id), at(second, end.id), `${end.id} moved when the input order changed`);
  }
});

test('an edge to a missing box is skipped rather than thrown over', () => {
  const routes = route([box('a', 0, 0)], [link('a', 'ghost'), { id: 'self', from: 'a', to: 'a' }]);
  assert.equal(routes.size, 0);
});

test('routing nothing returns nothing', () => {
  assert.equal(route([], []).size, 0);
});
