// Research, ideas and design proposals: schema, validation (errors and weak-reasoning warnings), the edit commands,
// summary and the site data they compile to.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, minimal, quietly, read, run, withTmp } from './helpers.mjs';
import * as build from '../dist/build.js';
import * as model from '../dist/model.js';
import * as validate from '../dist/validate.js';
import { summarise } from '../dist/summary.js';

const EXAMPLE = path.join(ROOT, 'examples', 'ideas-design', '.review');

/** A review with research, ideas and one proposal that validates without warnings. */
function full() {
  const d = minimal();
  d.project.kind = 'design';
  d.research = [{ id: 'r-1', title: 'Finding', summary: 'Fact.', sources: [{ label: 'WCAG', href: 'https://www.w3.org/WAI/' }] }];
  d.ideas = [{
    id: 'i-1', title: 'Idea', status: 'go', problem: 'P', proposal: 'Q', reasoning: 'Because r-1.', evidence: ['r-1'],
    alternatives: 'Do nothing.', risks: 'Small.', decision: 'Go.',
  }];
  d.proposals = [{
    id: 'first-run', title: 'First run', criteria: [{ id: 'clarity', label: 'Clarity', weight: 3 }, { id: 'cost', label: 'Cost' }],
    recommendation: { option: 'a', reasoning: 'Wins on clarity.' },
    options: ['a', 'b'].map((id, n) => ({
      id, title: id.toUpperCase(), reasoning: 'Why.', scores: { clarity: { score: 5 - n }, cost: { score: 3 } },
    })),
  }];
  return d;
}

function check(d, base = '/nonexistent') {
  return validate.validate(d, base, false);
}

describe('IdeasSchemaTest', () => {
  test('a full review validates without warnings', () => {
    const [errors, warnings] = check(full());
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  test('every kind is accepted', () => {
    for (const kind of ['ui', 'backend', 'ideas', 'design']) {
      const d = minimal();
      d.project.kind = kind;
      assert.deepEqual(check(d)[0], [], kind);
    }
    const d = minimal();
    d.project.kind = 'other';
    assert.ok(check(d)[0][0].includes('is not one of'));
  });

  test('scores must be whole numbers from 1 to 5; weights 1 to 5', () => {
    for (const bad of [0, 6, 2.5]) {
      const d = full();
      d.proposals[0].options[0].scores.clarity.score = bad;
      assert.ok(check(d)[0].length, String(bad));
    }
    const d = full();
    d.proposals[0].criteria[0].weight = 9;
    assert.ok(check(d)[0].some((e) => e.includes('must be <= 5')));
  });

  test('proposal and option ids must be ref-safe', () => {
    for (const bad of ['Bad', '-x', 'a b', 'a/b', 'a..b', 'x'.repeat(42)]) {
      const d = full();
      d.proposals[0].id = bad;
      assert.ok(check(d)[0].some((e) => e.includes('does not match')), bad);
      const e = full();
      e.proposals[0].options[1].id = bad;
      assert.ok(check(e)[0].some((x) => x.includes('does not match')), bad);
    }
  });

  test('cross-reference errors', () => {
    let d = full();
    d.ideas[0].evidence = ['r-1', 'r-9'];
    assert.deepEqual(check(d)[0], ['ideas[i-1]: unknown research "r-9" in evidence']);
    d = full();
    d.proposals[0].options[0].scores.speed = { score: 3 };
    assert.ok(check(d)[0].some((e) => e.includes('unknown criterion "speed"')));
    d = full();
    d.proposals[0].recommendation.option = 'zzz';
    assert.ok(check(d)[0].some((e) => e.includes('recommendation: "zzz" is not an option')));
    d = full();
    d.proposals[0].adopted = { option: 'zzz' };
    assert.ok(check(d)[0].some((e) => e.includes('adopted: "zzz" is not an option')));
    d = full();
    d.proposals[0].options[1].id = 'a';
    assert.ok(check(d)[0].some((e) => e.includes('duplicate proposals[first-run] option id "a"')));
    d = full();
    d.research.push({ ...d.research[0] });
    d.ideas.push({ ...d.ideas[0] });
    d.proposals.push({ ...d.proposals[0] });
    const errs = check(d)[0];
    for (const what of ['research', 'idea', 'proposal']) assert.ok(errs.some((e) => e.startsWith(`duplicate ${what} id`)), what);
    d = full();
    d.proposals[0].options[0].platforms = { tablet: { images: [] } };
    assert.ok(check(d)[0].some((e) => e.includes('unknown platform "tablet"')));
    d = full();
    d.research[0].sources[0].href = 'javascript:alert(1)';
    assert.ok(check(d)[0].some((e) => e.includes('research[r-1].sources: unsafe URL')));
  });

  test('absolute worktree paths are rejected', () => {
    for (const bad of ['/home/me/repo.designs/x', 'C:\\repo\\x']) {
      const d = full();
      d.proposals[0].options[0].worktree = bad;
      assert.ok(check(d)[0].some((e) => e.includes('worktree: must be relative')), bad);
    }
    const d = full();
    d.proposals[0].options[0].worktree = '../repo.designs/first-run--a';
    assert.deepEqual(check(d)[0], []);
  });

  test('diff snapshots must stay inside the review folder and exist', withTmp(async (t) => {
    const d = full();
    const o = d.proposals[0].options[0];
    o.diff = { path: 'diffs/a.patch' };
    assert.ok(validate.validate(d, t.tmp)[0].some((e) => e.includes('file not found: diffs/a.patch')));
    fs.mkdirSync(path.join(t.tmp, 'diffs'));
    fs.writeFileSync(path.join(t.tmp, 'diffs', 'a.patch'), 'diff --git a/x b/x\n');
    assert.deepEqual(validate.validate(d, t.tmp)[0], []);
    o.diff.path = '../outside.patch';
    assert.ok(validate.validate(d, t.tmp)[0].some((e) => e.includes('must stay inside the review folder')));
    o.diff.path = 'diffs/a.txt';
    assert.ok(validate.validate(d, t.tmp)[0].some((e) => e.includes('.patch or .diff')));
  }));

  test('weak reasoning shows up as warnings', () => {
    const d = full();
    d.research[0].sources = [];
    Object.assign(d.ideas[0], { reasoning: '', evidence: [], alternatives: ' ', decision: '' });
    delete d.ideas[0].risks;
    d.proposals[0].options[1].reasoning = '';
    delete d.proposals[0].options[1].scores.cost;
    delete d.proposals[0].recommendation;
    const [errors, warnings] = check(d);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [
      'research[r-1]: no sources; add at least one a reader can open',
      'ideas[i-1]: weak reasoning; missing reasoning, evidence, alternatives, risks',
      "ideas[i-1]: status go without a decision note (record the user's call and why)",
      'proposals[first-run]: no recommendation yet (`review-kit recommend`)',
      'proposals[first-run].options[b]: no score for cost',
      'proposals[first-run].options[b]: no reasoning',
    ]);
    const e = full();
    e.proposals[0].options = e.proposals[0].options.slice(0, 1);
    e.proposals[0].criteria = [];
    delete e.proposals[0].recommendation;
    e.proposals[0].options[0].scores = {};
    const w = check(e)[1];
    assert.ok(w.some((x) => x.includes('1 option(s); compare at least 2')));
    assert.ok(w.some((x) => x.includes('no criteria')));
  });

  test('the example reviews are valid', () => {
    for (const kind of ['ideas', 'design']) {
      const p = path.join(EXAMPLE, kind, 'review.json');
      const [errors, warnings] = validate.validate(model.load(p), path.dirname(p));
      assert.deepEqual(errors, [], kind);
      assert.deepEqual(warnings, [], kind);
    }
  });
});

describe('IdeasCommandsTest', () => {
  test('add-research, add-idea, decide, add-proposal and recommend', withTmp(async (t) => {
    const dir = path.join(t.tmp, '.review', 'ideas');
    let r = await run('init', dir, '--kind', 'ideas', '--name', 'App');
    assert.equal(r.code, 0, r.err);
    const p = path.join(dir, 'review.json');
    let data = model.load(p);
    assert.equal(data.project.title, 'Ideas and research');
    assert.deepEqual(data.platforms.map((x) => x.id), ['default']);
    assert.deepEqual([data.research, data.ideas], [[], []]);

    const research = ['--title', 'Empty states teach', '--summary', 'Fact vs *inference*.',
      '--source', 'NN/g=https://www.nngroup.com/articles/empty-state-interface-design/', '--quote', 'More successful',
      '--source', 'Local notes=notes.md', '--confidence', 'high', '--tags', 'ux, onboarding', '--kind', 'article'];
    r = await run('add-research', p, ...research);
    assert.equal(r.code, 1); // a local source must exist
    assert.ok(r.err.includes('local file not found: notes.md'), r.err);
    fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n');
    r = await run('add-research', p, '--title', 'Empty states teach', '--summary', 'Fact vs *inference*.',
      '--source', 'NN/g=https://www.nngroup.com/articles/empty-state-interface-design/', '--quote', 'More successful',
      '--source', 'Local notes=notes.md', '--confidence', 'high', '--tags', 'ux, onboarding', '--kind', 'article');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('research r-1: Empty states teach (2 source(s))'), r.out);
    data = model.load(p);
    const src = data.research[0].sources;
    assert.equal(src[0].quote, 'More successful');
    assert.match(src[0].accessed, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(src[1].accessed, undefined); // not a web source
    assert.deepEqual(data.research[0].tags, ['ux', 'onboarding']);

    r = await run('add-research', p, '--update', '--id', 'r-1', '--source', 'MDN=https://developer.mozilla.org/', '--accessed', '2026-01-02');
    assert.equal(r.code, 0, r.err);
    assert.equal(model.load(p).research[0].sources.length, 3);
    r = await run('add-research', p, '--title', 'No source');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('warning: research[r-2]: no sources'), r.out);
    r = await run('add-research', p, '--quote', 'q');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('one --source per quote'), r.err);

    r = await run('add-idea', 'ideas', '-r', p, '--title', 'Teach in the empty list', '--problem', 'Blank page',
      '--proposal', 'A message', '--reasoning', 'See r-1', '--evidence', 'r-1', '--alternatives', 'Do nothing',
      '--risks', 'Long copy', '--pro', 'Cheap', '--pro', 'In context', '--con', 'Teaches little', '--effort', 'S',
      '--impact', 'L', '--confidence', 'high');
    assert.equal(r.code, 1); // "ideas" and -r both given: -r is ignored only when no positional is given
    r = await run('add-idea', p, '--title', 'Teach in the empty list', '--problem', 'Blank page',
      '--proposal', 'A message', '--reasoning', 'See r-1', '--evidence', 'r-1', '--alternatives', 'Do nothing',
      '--risks', 'Long copy', '--pro', 'Cheap', '--pro', 'In context', '--con', 'Teaches little', '--effort', 'S',
      '--impact', 'L', '--confidence', 'high');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('idea i-1: Teach in the empty list [proposed]'), r.out);
    assert.ok(!r.out.includes('warning: ideas'), r.out);
    r = await run('add-idea', p, '--title', 'Bad', '--evidence', 'r-9');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('unknown research "r-9"'), r.err);
    assert.equal(model.load(p).ideas.length, 1); // left unchanged
    r = await run('add-idea', p, '--title', 'Thin');
    assert.ok(r.out.includes('warning: ideas[i-2]: weak reasoning; missing reasoning, evidence, alternatives, risks'), r.out);
    r = await run('add-idea', p, '--update', '--id', 'i-2', '--risks', 'None known');
    assert.equal(r.code, 0, r.err);
    assert.equal(model.load(p).ideas[1].risks, 'None known');
    r = await run('add-idea', p, '--update', '--id', 'i-9', '--risks', 'x');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('no idea with id "i-9"'), r.err);

    r = await run('decide', 'i-1', 'go', '--note', 'Cheap and backed by r-1', '-r', p);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('idea i-1 -> go'));
    r = await run('decide', p, 'i-2', 'no');
    assert.equal(r.code, 0, r.err);
    data = model.load(p);
    assert.equal(data.ideas[0].decision, 'Cheap and backed by r-1');
    assert.equal(data.ideas[1].status, 'no');
    r = await run('decide', p, 'i-2', 'later');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('status must be one of proposed, go, maybe, no, done'), r.err);
    r = await run('decide', p, 'i-9', 'go');
    assert.ok(r.err.includes('no idea with id "i-9"'), r.err);

    // a design review next to it: add-proposal --idea links the idea in the ideas review
    const ddir = path.join(t.tmp, '.review', 'design');
    assert.equal((await run('init', ddir, '--kind', 'design', '--name', 'App')).code, 0);
    const dp = path.join(ddir, 'review.json');
    r = await run('add-proposal', dp, '--id', 'first-run', '--title', 'First run', '--brief', 'Decide the first screen',
      '--idea', 'i-1', '--criterion', 'clarity=Clear first step:3', '--criterion', 'Small to build');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('proposal first-run: First run (2 criteria)'), r.out);
    assert.ok(r.out.includes('linked to proposal first-run'), r.out);
    assert.ok(!r.out.includes('0 option(s)'), r.out); // options come later
    assert.deepEqual(model.load(p).ideas[0].proposals, ['first-run']);
    const pr = model.load(dp).proposals[0];
    assert.deepEqual(pr.criteria, [{ id: 'clarity', label: 'Clear first step', weight: 3 }, { id: 'small-to-build', label: 'Small to build' }]);
    assert.equal(pr.status, 'open');
    for (const bad of ['First', 'a/b', '-x']) {
      r = await run('add-proposal', dp, `--id=${bad}`, '--title', 'x');
      assert.equal(r.code, 1, bad);
      assert.ok(r.err.includes('is not allowed'), r.err);
    }
    r = await run('add-proposal', dp, '--title', 'No id');
    assert.ok(r.err.includes('needs --id'), r.err);
    r = await run('add-proposal', dp, '--id', 'first-run', '--title', 'Again');
    assert.ok(r.err.includes('already exists'), r.err);
    r = await run('add-proposal', dp, '--id', 'first-run', '--update', '--criterion', 'clarity=Clarity:5', '--criterion', 'a11y=Accessible:3');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(model.load(dp).proposals[0].criteria.map((c) => [c.id, c.weight]), [['clarity', 5], ['small-to-build', undefined], ['a11y', 3]]);
    r = await run('add-proposal', dp, '--id', 'x', '--title', 'x', '--criterion', 'a=A:7');
    assert.ok(r.err.includes('weight must be 1 to 5'), r.err);

    // options (without git, as JSON) then recommend
    const dd = model.load(dp);
    dd.proposals[0].options = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
    fs.writeFileSync(dp, JSON.stringify(dd));
    r = await run('recommend', 'design', 'first-run', 'zzz', '--reasoning', 'x', '-r', dp);
    assert.equal(r.code, 1);
    r = await run('recommend', dp, 'first-run', 'zzz', '--reasoning', 'x');
    assert.ok(r.err.includes('has no option "zzz"'), r.err);
    r = await run('recommend', dp, 'first-run', 'a', '--reasoning', ' ');
    assert.ok(r.err.includes('--reasoning is required'), r.err);
    r = await run('recommend', dp, 'first-run', 'a', '--reasoning', 'Clearest; pick b if cost matters most');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(model.load(dp).proposals[0].recommendation, { option: 'a', reasoning: 'Clearest; pick b if cost matters most' });
  }));

  test('commands accept a kind as the review argument', withTmp(async (t) => {
    const cwd = process.cwd();
    process.chdir(t.tmp);
    try {
      await run('init', '.review/ideas', '--kind', 'ideas');
      await run('init', '.review/ui', '--kind', 'ui');
      let r = await run('add-idea', 'ideas', '--title', 'X');
      assert.equal(r.code, 0, r.err);
      r = await run('decide', 'ideas', 'i-1', 'maybe');
      assert.equal(r.code, 0, r.err);
      assert.equal(model.load('.review/ideas/review.json').ideas[0].status, 'maybe');
      r = await run('decide', 'i-1', 'go'); // several reviews: decide picks the ideas one
      assert.equal(r.code, 0, r.err);
      assert.equal(model.load('.review/ideas/review.json').ideas[0].status, 'go');
      r = await run('decide', 'ideas', 'i-1');
      assert.ok(r.err.includes('usage: review-kit decide'), r.err);
    } finally {
      process.chdir(cwd);
    }
  }));

  test('add-idea and add-proposal take --json', withTmp(async (t) => {
    const p = t.write(minimal());
    let r = await run('add-idea', p, '--json', JSON.stringify({ title: 'From JSON', pros: ['a'], tags: ['x'] }), '--effort', 'M');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(model.load(p).ideas[0].pros, ['a']);
    assert.equal(model.load(p).ideas[0].effort, 'M');
    r = await run('add-proposal', p, '--json', JSON.stringify({ id: 'p', title: 'P', criteria: [{ id: 'c', label: 'C', weight: 2 }] }));
    assert.equal(r.code, 0, r.err);
    r = await run('add-idea', p, '--json', '[1]');
    assert.ok(r.err.includes('expected a JSON object'), r.err);
  }));
});

describe('IdeasSummaryTest', () => {
  test('ideas and design summaries', () => {
    const ideas = model.load(path.join(EXAMPLE, 'ideas', 'review.json'));
    const s = summarise(ideas);
    assert.ok(s.includes('**Research:** 5 findings, 6 sources'), s);
    assert.ok(s.includes('**Ideas:** 4 total, 1 maybe, 2 go, 1 no') || s.includes('**Ideas:** 4 total, 2 go, 1 maybe, 1 no'), s);
    assert.ok(s.includes('- i-1 [go, impact L, effort S]'), s);
    assert.ok(!s.includes('i-4 ['), 'rejected ideas are not top ideas');
    assert.ok(!s.includes('Issues:'), s);
    assert.ok(s.includes('**Plan:** 2 items'), s);
    const des = summarise(model.load(path.join(EXAMPLE, 'design', 'review.json')), 8, false);
    assert.ok(des.includes('- first-run: First-run experience for new users [open] 3 option(s) (empty-state, sample-tasks, coach-mark); recommends empty-state'), des);
    const d = full();
    d.proposals[0].status = 'adopted';
    d.proposals[0].adopted = { option: 'a', commit: 'abcdef1234' };
    assert.ok(summarise(d).includes('[adopted a in abcdef1]'));
    d.issues = [{ id: 'x', title: 'X' }];
    assert.ok(summarise(d).includes('**Issues:** 1 total'), 'issues still summarised next to proposals');
  });
});

describe('IdeasBuildTest', () => {
  test('site data follows the contract and has no absolute paths', withTmp(async (t) => {
    const src = path.join(t.tmp, 'ex');
    fs.cpSync(EXAMPLE, src, { recursive: true, filter: (s) => path.basename(s) !== 'site' });
    const out = path.join(t.tmp, 'site');
    const { value: stats } = await quietly(() => build.buildAny([path.join(src, 'ideas', 'review.json'), path.join(src, 'design', 'review.json')], out));
    assert.deepEqual(stats.reviews.map((r) => [r.key, r.label]), [['ideas', 'Ideas'], ['design', 'Designs']]);
    const js = read(path.join(out, 'data.js'));
    assert.ok(!js.includes(t.tmp) && !js.includes(ROOT) && !js.includes('/Users/') && !js.includes('/home/'));
    assert.ok(!js.includes('worktree') && !js.includes('.designs'));
    const reviews = JSON.parse(js.slice('window.REVIEWS = '.length).trimEnd().replace(/;$/, ''));
    const ideas = reviews[0].data;
    const design = reviews[1].data;
    assert.equal(ideas.project.kind, 'ideas');
    assert.deepEqual(Object.keys(ideas.ideaStatusLabels), ['proposed', 'go', 'maybe', 'no', 'done']);
    assert.deepEqual(Object.keys(design.proposalStatusLabels), ['open', 'adopted', 'closed']);
    const r1 = ideas.research[0];
    assert.deepEqual(Object.keys(r1).sort(), ['confidence', 'date', 'html', 'id', 'ideas', 'sources', 'tags', 'title']);
    assert.deepEqual(r1.ideas, ['i-1', 'i-3', 'i-4']);
    assert.deepEqual(Object.keys(r1.sources[0]).sort(), ['accessed', 'href', 'kind', 'label', 'quote']);
    const i1 = ideas.ideas[0];
    for (const k of ['problem', 'proposal', 'reasoning', 'alternatives', 'risks', 'decision']) assert.equal(typeof i1[k], 'string', k);
    assert.ok(i1.alternatives.includes('<li>'), i1.alternatives);
    assert.ok(i1.pros.every((x) => typeof x === 'string'));
    assert.deepEqual(i1.proposals, ['first-run']);
    assert.deepEqual(design.research, []);
    assert.deepEqual(design.ideas, []);
    const pr = design.proposals[0];
    assert.deepEqual(pr.criteria[0], { id: 'clarity', label: 'First task without help', weight: 3, desc: 'How clearly the screen says what to do first.' });
    assert.equal(pr.recommendation.option, 'empty-state');
    assert.ok(pr.recommendation.html.includes('<strong>sample tasks</strong>') || pr.recommendation.html.includes('<b>sample tasks</b>'), pr.recommendation.html);
    assert.equal(pr.adopted, null);
    const [a, b, c] = pr.options;
    assert.equal(a.total, 94); // (3*4 + 3*5 + 2*5 + 2*5) / 50
    assert.ok(a.total > b.total && a.total > c.total);
    assert.equal(a.gone, false);
    assert.equal(a.branch, 'design/first-run/empty-state');
    assert.ok(a.diff.text.startsWith('diff --git a/app/app.js b/app/app.js'));
    assert.deepEqual(a.diff.files[0], { path: 'app/app.js', add: 2, del: 0, binary: false });
    assert.equal(a.diff.truncated, false);
    assert.equal(a.scores.clarity.score, 4);
    assert.ok(a.platforms.mobile.images[0].src.startsWith('img/design/screenshots/first-run--empty-state/mobile.png?v='));
    assert.ok(fs.existsSync(path.join(out, 'img', 'design', 'screenshots', 'first-run--empty-state', 'mobile.png')));
  }));

  test('weighted totals', () => {
    const crit = [{ id: 'a', weight: 3 }, { id: 'b' }];
    assert.equal(build.weightedTotal(crit, { a: { score: 5 }, b: { score: 5 } }), 100);
    assert.equal(build.weightedTotal(crit, { a: { score: 5 } }), 75);
    assert.equal(build.weightedTotal(crit, {}), 0);
    assert.equal(build.weightedTotal([], { a: { score: 3 } }), null);
  });

  test('a hand-made diff over the cap is cut in the site data', withTmp(async (t) => {
    const d = full();
    fs.mkdirSync(path.join(t.tmp, 'diffs'));
    const line = '+' + 'x'.repeat(99) + '\n';
    fs.writeFileSync(path.join(t.tmp, 'diffs', 'a.patch'), line.repeat(Math.ceil(model.DIFF_CAP / line.length) + 10));
    d.proposals[0].options[0].diff = { path: 'diffs/a.patch', files: [], insertions: 0, deletions: 0 };
    const p = t.write(d);
    const out = path.join(t.tmp, 'site');
    await quietly(() => build.build(p, out));
    const js = read(path.join(out, 'data.js'));
    const data = JSON.parse(js.slice('window.REVIEW = '.length).trimEnd().replace(/;$/, ''));
    const diff = data.proposals[0].options[0].diff;
    assert.equal(diff.truncated, true);
    assert.ok(diff.text.length <= model.DIFF_CAP && diff.text.endsWith('\n'));
    assert.equal(data.proposals[0].options[1].diff, null);
  }));

  test('a combined site with all four kinds, ordered ideas, design, ui, backend', withTmp(async (t) => {
    const root = path.join(t.tmp, '.review');
    for (const kind of ['backend', 'ui', 'design', 'ideas']) {
      const d = minimal();
      d.project.kind = kind;
      if (kind === 'ideas') d.ideas = [{ id: 'i-1', title: 'I' }];
      fs.mkdirSync(path.join(root, kind), { recursive: true });
      fs.writeFileSync(path.join(root, kind, 'review.json'), JSON.stringify(d));
    }
    const cwd = process.cwd();
    process.chdir(t.tmp);
    try {
      const r = await run('build');
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.indexOf('Ideas:') < r.out.indexOf('Designs:') && r.out.indexOf('Designs:') < r.out.indexOf('UI/UX:')
        && r.out.indexOf('UI/UX:') < r.out.indexOf('Backend:'), r.out);
      assert.ok(r.out.includes('warning: Ideas: ideas[i-1]: weak reasoning'), r.out);
      const js = read(path.join(root, 'site', 'data.js'));
      const reviews = JSON.parse(js.slice('window.REVIEWS = '.length).trimEnd().replace(/;$/, ''));
      assert.deepEqual(reviews.map((x) => x.key), ['ideas', 'design', 'ui', 'backend']);
      assert.deepEqual(reviews.map((x) => x.label), ['Ideas', 'Designs', 'UI/UX', 'Backend']);
    } finally {
      process.chdir(cwd);
    }
  }));
});

describe('IdeasAttachTest', () => {
  test('attach ideas and design: defaults, pointer order and the flow sentence', withTmp(async (t) => {
    let r = await run('attach', t.tmp, '--kind', 'design,ideas', '--platforms', 'phone,web');
    assert.equal(r.code, 0, r.err);
    const ideas = model.load(path.join(t.tmp, '.review', 'ideas', 'review.json'));
    const design = model.load(path.join(t.tmp, '.review', 'design', 'review.json'));
    assert.deepEqual([ideas.project.kind, ideas.project.title], ['ideas', 'Ideas and research']);
    assert.deepEqual(ideas.platforms.map((p) => p.id), ['default']);
    assert.deepEqual([design.project.kind, design.project.title], ['design', 'Design proposals']);
    assert.deepEqual(design.platforms.map((p) => p.id), ['phone', 'web']);
    assert.deepEqual(design.proposals, []);
    assert.ok(!r.out.includes('ideas: companion skills not found'), r.out);
    let agents = read(path.join(t.tmp, 'AGENTS.md'));
    assert.ok(agents.includes('apply fixes only for the issues the user approves.'), agents);
    assert.ok(agents.includes('Ideation only researches and proposes; design options are built on their own branches and adopted only when the\nuser picks one.'), agents);
    assert.ok(agents.indexOf('Ideas and research: `.review/ideas/review.json`') < agents.indexOf('Design proposals: `.review/design/review.json`'));
    r = await run('attach', t.tmp, '--kind', 'ui');
    assert.equal(r.code, 0, r.err);
    agents = read(path.join(t.tmp, 'AGENTS.md'));
    const rows = agents.split('\n').filter((l) => l.startsWith('- '));
    assert.deepEqual(rows, [
      '- Ideas and research: `.review/ideas/review.json`',
      '- Design proposals: `.review/design/review.json`',
      '- UI/UX: `.review/ui/review.json`',
    ]);
    assert.equal(agents.split('<!-- review-kit:begin -->').length, 2, 'one pointer block');
  }));

  test('init --kind ideas|design and the unknown-kind message', withTmp(async (t) => {
    let r = await run('init', path.join(t.tmp, 'd'), '--kind', 'design');
    assert.equal(r.code, 0, r.err);
    const d = model.load(path.join(t.tmp, 'd', 'review.json'));
    assert.deepEqual(d.platforms.map((p) => p.id), ['mobile', 'desktop']);
    r = await run('attach', t.tmp, '--kind', 'idea');
    assert.ok(r.err.includes("expected one of ui, backend, ideas, design"), r.err);
  }));

  test('companions for the new kinds', async () => {
    let r = await run('companions', '--kind', 'design', '--json');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).map((c) => c.name),
      ['ui-ux-pro-max', 'api-design-principles', 'architecture-patterns', 'error-handling-patterns']);
    r = await run('companions', '--kind', 'ideas');
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes('ideas') && r.out.includes('no companion skills'), r.out);
    r = await run('companions', '--json');
    assert.deepEqual([...new Set(JSON.parse(r.out).map((c) => c.kind))], ['ui', 'backend'], 'no duplicate design rows by default');
  });
});

describe('DefaultReviewTest', () => {
  /** Run fn with the cwd at t.tmp, after `attach --kind ideas,design` there. */
  const attached = (fn) => withTmp(async (t) => {
    const r = await run('attach', t.tmp, '--kind', 'ideas,design', '--no-agents-file');
    assert.equal(r.code, 0, r.err);
    const cwd = process.cwd();
    process.chdir(t.tmp);
    try {
      await fn(t);
    } finally {
      process.chdir(cwd);
    }
  });
  const IDEAS = '.review/ideas/review.json';
  const DESIGN = '.review/design/review.json';
  const addOptions = (p, ids) => {
    const d = model.load(p);
    d.proposals[0].options = ids.map((id) => ({ id, title: id }));
    fs.writeFileSync(p, JSON.stringify(d));
  };

  test('ideas commands pick the ideas review, design commands the design review', attached(async () => {
    let r = await run('add-research', '--title', 'F', '--source', 'W=https://www.w3.org/WAI/');
    assert.equal(r.code, 0, r.err);
    r = await run('add-idea', '--title', 'I', '--evidence', 'r-1');
    assert.equal(r.code, 0, r.err);
    r = await run('decide', 'i-1', 'go', '--note', 'yes');
    assert.equal(r.code, 0, r.err);
    assert.equal(model.load(IDEAS).ideas[0].status, 'go');
    r = await run('add-proposal', '--id', 'hero', '--title', 'Hero', '--criterion', 'c=C', '--idea', 'i-1');
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes('0 option(s)'), r.out); // a new proposal has no options yet: no warning
    assert.ok(r.out.includes(`idea i-1 in ${IDEAS}: linked to proposal hero`), r.out);
    assert.equal(model.load(DESIGN).proposals[0].id, 'hero');
    r = await run('validate', 'design');
    assert.ok(r.out.includes('warning: proposals[hero]: 0 option(s)'), r.out); // validate still says so
    addOptions(DESIGN, ['plain', 'bold']);
    r = await run('recommend', 'hero', 'plain', '--reasoning', 'x');
    assert.equal(r.code, 0, r.err);
    assert.equal(model.load(DESIGN).proposals[0].recommendation.option, 'plain');
    r = await run('discard', 'hero', '--dry-run');
    assert.equal(r.code, 1); // found the design review; it is just not in a git repo
    assert.ok(r.err.includes('not inside a git repository'), r.err);
  }));

  test('several design reviews: the one holding the proposal, else an error naming the kind', attached(async () => {
    await run('init', '.review/design-b', '--kind', 'design');
    await run('add-proposal', DESIGN, '--id', 'hero', '--title', 'Hero');
    addOptions(DESIGN, ['plain', 'bold']);
    let r = await run('recommend', 'hero', 'plain', '--reasoning', 'x');
    assert.equal(r.code, 0, r.err);
    r = await run('add-proposal', '--id', 'other', '--title', 'O');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('pass one, e.g. `review-kit add-proposal design --id other ...`'), r.err);
    await run('add-proposal', '.review/design-b', '--id', 'hero', '--title', 'Hero B');
    r = await run('adopt', 'hero', 'plain');
    assert.equal(r.code, 1);
    assert.ok(r.err.includes('several reviews here') && r.err.includes('pass one, e.g. `review-kit adopt design hero plain`'), r.err);
    r = await run('recommend', 'hero', 'plain', '--reasoning', 'x');
    assert.ok(r.err.includes('`review-kit recommend design hero plain --reasoning ...`'), r.err);
  }));

  test('without a design review, the single review holding the proposal', withTmp(async (t) => {
    await run('attach', t.tmp, '--kind', 'ui,backend', '--no-agents-file');
    const be = path.join(t.tmp, '.review', 'backend', 'review.json');
    await run('add-proposal', be, '--id', 'api', '--title', 'API shape');
    addOptions(be, ['rest', 'rpc']);
    const cwd = process.cwd();
    process.chdir(t.tmp);
    try {
      let r = await run('recommend', 'api', 'rest', '--reasoning', 'x');
      assert.equal(r.code, 0, r.err);
      assert.equal(model.load(be).proposals[0].recommendation.option, 'rest');
      r = await run('add-idea', '--title', 'X');
      assert.ok(r.err.includes('pass one, e.g. `review-kit add-idea ideas --title ...`'), r.err);
    } finally {
      process.chdir(cwd);
    }
  }));
});
