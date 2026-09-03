import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the panel HTML contains every element required by its webview script', () => {
  const script = readFileSync('webview-src/main.ts', 'utf8');
  const panel = readFileSync('src/panel.ts', 'utf8');
  const requiredIds = [...script.matchAll(/findElement<[^>]+>\('([^']+)'\)/g)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id));

  assert.ok(requiredIds.length > 0, 'the webview script should declare required elements');
  for (const id of requiredIds) {
    assert.match(panel, new RegExp(`id=["']${escapeRegExp(id)}["']`), `panel HTML is missing #${id}`);
  }
});

test('collapsed details uses a compact bottom rail in the narrow stacked layout', () => {
  const styles = readFileSync('webview-src/styles.css', 'utf8');
  const stackedSelector = '.workspace:not(.is-drawer):not(.is-stacked),';
  const collapsedSelector = '.workspace:not(.is-drawer):not(.is-stacked).is-details-closed,';
  const collapsedPanelSelector =
    '.workspace:not(.is-drawer):not(.is-stacked).is-details-closed > .details-panel.is-collapsed,';

  assert.ok(styles.indexOf(collapsedSelector) > styles.indexOf(stackedSelector),
    'the collapsed override must follow the general narrow stacked rule');
  assert.match(ruleBody(styles, collapsedSelector),
    /grid-template-rows:\s*minmax\(0, 1fr\) var\(--repogram-details-collapsed-size\)/);
  assert.match(ruleBody(styles, collapsedPanelSelector),
    /height:\s*var\(--repogram-details-collapsed-size\)/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleBody(styles: string, selector: string): string {
  const selectorIndex = styles.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `missing CSS selector: ${selector}`);
  const bodyStart = styles.indexOf('{', selectorIndex);
  const bodyEnd = styles.indexOf('}', bodyStart);
  assert.notEqual(bodyStart, -1, `missing CSS body: ${selector}`);
  assert.notEqual(bodyEnd, -1, `unterminated CSS body: ${selector}`);
  return styles.slice(bodyStart + 1, bodyEnd);
}
