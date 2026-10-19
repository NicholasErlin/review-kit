import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, loadDemo, minimal } from './helpers.mjs';
import * as model from '../dist/model.js';
import * as validate from '../dist/validate.js';

function schemaErrors(data) {
  return new validate.SchemaValidator(model.loadSchema()).errors(data);
}

describe('SchemaTest', () => {
  test('minimal document is valid', () => {
    assert.deepEqual(validate.validate(minimal(), DEMO), [[], []]);
  });

  test('demo is valid', () => {
    const [errors, warnings] = validate.validate(loadDemo(), DEMO);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  test('version and project required', () => {
    const errs = schemaErrors({});
    assert.ok(errs.includes('(root): missing required "version"'), errs.join('\n'));
    assert.ok(errs.includes('(root): missing required "project"'), errs.join('\n'));
    assert.ok(schemaErrors({ version: 2, project: { name: 'x' } }).some((e) => e.includes('must be 1')));
  });

  test('unknown property rejected', () => {
    const d = minimal();
    d.issues = [{ id: 'a', title: 't', severty: 'P0' }];
    assert.ok(schemaErrors(d).includes('issues[0]: unknown property "severty"'));
  });

  test('bad status enum', () => {
    const d = minimal();
    d.issues = [{ id: 'a', title: 't', status: 'done' }];
    assert.ok(schemaErrors(d).some((e) => e.includes('issues[0].status') && e.includes('not one of')));
  });

  test('bad id pattern and types', () => {
    const d = minimal();
    d.issues = [{ id: 'has space', title: 't' }, { id: 'ok', title: '', top: 'yes' }];
    const errs = schemaErrors(d);
    assert.ok(errs.some((e) => e.startsWith('issues[0].id')), errs.join('\n'));
    assert.ok(errs.includes('issues[1].title: must not be empty'), errs.join('\n'));
    assert.ok(errs.includes('issues[1].top: expected boolean, got str'), errs.join('\n'));
  });

  test('image forms', () => {
    const d = minimal();
    d.issues = [{ id: 'a', title: 't', screenshots: ['x.png', { src: 'y.png', caption: 'c' }] }];
    assert.deepEqual(schemaErrors(d), []);
    d.issues[0].screenshots = [{ caption: 'no src' }];
    assert.ok(schemaErrors(d).some((e) => e.includes('missing required "src"')));
  });

  test('pair needs before or after', () => {
    const d = minimal();
    d.fixes = [{ id: 'f', title: 't', platforms: { default: { pairs: [{ caption: 'x' }] } } }];
    assert.ok(schemaErrors(d).some((e) => e.includes('needs one of before, after')));
  });

  test('theme colour pattern', () => {
    const d = minimal();
    d.project.theme = { accent: 'red' };
    assert.ok(schemaErrors(d).some((e) => e.includes('theme.accent')));
  });

  test('anchored patterns reject a trailing newline', () => {
    // regression: backend review issue-6 (Python's $ also matches before a final newline)
    const d = minimal();
    d.project.theme = { accent: '#fff\n' };
    d.issues = [{ id: 'abc\n', title: 'x' }];
    const errs = schemaErrors(d);
    assert.ok(errs.some((e) => e.includes('theme.accent')), errs.join('\n'));
    assert.ok(errs.some((e) => e.includes('issues[0].id')), errs.join('\n'));
    d.project.theme = { accent: '#fff' };
    d.issues[0].id = 'abc';
    assert.deepEqual(schemaErrors(d), []);
  });
});

describe('SemanticTest', () => {
  test('cross references', () => {
    const d = loadDemo();
    d.issues[0].platform = 'tablet';
    d.issues[1].severity = 'P9';
    d.fixes[0].issues.push('nope');
    d.fixes[1].platforms.watch = {};
    d.plan[0].items[0].fixes = ['fix-404'];
    const [errors] = validate.validate(d, DEMO);
    const joined = errors.join('\n');
    assert.ok(joined.includes('unknown platform "tablet"'), joined);
    assert.ok(joined.includes('unknown severity "P9"'), joined);
    assert.ok(joined.includes('fixes[fix-1]: unknown issue "nope"'), joined);
    assert.ok(joined.includes('fixes[fix-2]: unknown platform "watch"'), joined);
    assert.ok(joined.includes('unknown fix "fix-404"'), joined);
  });

  test('duplicate ids', () => {
    const d = loadDemo();
    d.issues.push({ ...d.issues[0] });
    const [errors] = validate.validate(d, DEMO);
    assert.ok(errors.includes('duplicate issue id "m-1"'), errors.join('\n'));
  });

  test('missing image', () => {
    const d = loadDemo();
    d.fixes[0].platforms.mobile.pairs[0].after.src = 'screenshots/missing.png';
    const [errors] = validate.validate(d, DEMO);
    assert.ok(errors.some((e) => e.includes('image not found: screenshots/missing.png')), errors.join('\n'));
    assert.deepEqual(validate.validate(d, DEMO, false)[0], []);
  });

  test('warnings', () => {
    const d = loadDemo();
    d.issues[0].area = 'free text page';
    delete d.issues[1].platform;
    d.fixes[1].number = 1;
    const [, warnings] = validate.validate(d, DEMO);
    const joined = warnings.join('\n');
    assert.ok(joined.includes('not an area id'), joined);
    assert.ok(joined.includes('no platform set'), joined);
    assert.ok(joined.includes('number 1 also used'), joined);
  });

  test('custom severities', () => {
    const d = minimal();
    d.severities = [{ id: 'critical', color: '#ff0000' }, { id: 'minor' }];
    d.issues = [{ id: 'a', title: 't', severity: 'critical' }, { id: 'b', title: 't', severity: 'P0' }];
    const [errors] = validate.validate(d, DEMO);
    assert.deepEqual(errors, ['issues[b]: unknown severity "P0" (known: critical, minor)']);
  });
});
