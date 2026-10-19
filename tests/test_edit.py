import contextlib
import io
import json
import os
import unittest

from helpers import TempDirTest, read

from reviewkit import cli, edit, model
from reviewkit.model import ReviewError


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main([str(a) for a in argv])
    return code, out.getvalue(), err.getvalue()


class InitTest(TempDirTest):
    def test_init_scaffolds(self):
        d = os.path.join(self.tmp, '.review')
        code, out, err = run('init', d, '--name', 'Shop', '--platforms', 'mobile,desktop', '--ignore-screenshots', '--accent', '#123456')
        self.assertEqual(code, 0, err)
        data = model.load(os.path.join(d, 'review.json'))
        self.assertEqual(data['project']['name'], 'Shop')
        self.assertEqual([p['id'] for p in data['platforms']], ['mobile', 'desktop'])
        self.assertEqual(data['platforms'][0]['shape'], 'portrait')
        self.assertTrue(os.path.isdir(os.path.join(d, 'screenshots')))
        self.assertTrue(os.path.isdir(os.path.join(d, 'pending')))
        self.assertIn('screenshots/*', read(os.path.join(d, '.gitignore')))
        self.assertEqual(run('validate', d)[0], 0)
        code, _, err = run('init', d, '--name', 'Again')
        self.assertEqual(code, 1)
        self.assertIn('already exists', err)


class EditTest(TempDirTest):
    def setUp(self):
        super().setUp()
        self.dir = os.path.join(self.tmp, 'r')
        edit.init(self.dir, 'P', platforms=['mobile', 'desktop'])
        self.review = os.path.join(self.dir, 'review.json')

    def data(self):
        return model.load(self.review)

    def test_add_issue_flags_and_auto_id(self):
        code, out, err = run('add-issue', self.review, '--title', 'Broken', '--platform', 'mobile', '--severity', 'P1', '--area', 'Home')
        self.assertEqual(code, 0, err)
        issue = self.data()['issues'][0]
        self.assertEqual(issue, {'title': 'Broken', 'platform': 'mobile', 'severity': 'P1', 'area': 'Home', 'id': 'm-1', 'status': 'open'})
        run('add-issue', self.review, '--title', 'Root', '--platform', 'desktop', '--severity', 'none')
        self.assertEqual(self.data()['issues'][1]['id'], 'd-2')
        self.assertIsNone(self.data()['issues'][1]['severity'])

    def test_add_issue_rejects_invalid_and_leaves_file(self):
        before = read(self.review)
        code, _, err = run('add-issue', self.review, '--title', 'X', '--platform', 'watch')
        self.assertEqual(code, 1)
        self.assertIn('unknown platform "watch"', err)
        self.assertEqual(read(self.review), before)

    def test_add_issue_json_list_and_update(self):
        items = [{'id': 'a', 'title': 'A', 'platform': 'mobile'}, {'id': 'b', 'title': 'B', 'platform': 'desktop', 'severity': 'P0'}]
        self.assertEqual(run('add-issue', self.review, '--json', json.dumps(items))[0], 0)
        code, _, err = run('add-issue', self.review, '--id', 'a', '--title', 'dup', '--platform', 'mobile')
        self.assertEqual(code, 1)
        self.assertIn('already exists', err)
        self.assertEqual(run('add-issue', self.review, '--id', 'a', '--status', 'partial', '--update')[0], 0)
        a = self.data()['issues'][0]
        self.assertEqual((a['title'], a['status']), ('A', 'partial'))

    def test_add_issue_copies_absolute_screenshot(self):
        shot = self.png('outside/s.png')
        run('add-issue', self.review, '--title', 'With shot', '--platform', 'mobile', '--screenshot', shot)
        self.assertEqual(self.data()['issues'][0]['screenshots'], ['screenshots/issues/s.png'])
        self.assertTrue(os.path.isfile(os.path.join(self.dir, 'screenshots/issues/s.png')))

    def test_add_fix_flags_pairs_and_resolves(self):
        run('add-issue', self.review, '--json', json.dumps([{'id': 'a', 'title': 'A', 'platform': 'mobile'}, {'id': 'b', 'title': 'B', 'platform': 'mobile'}]))
        before, after = self.png('cap/before.png'), self.png('cap/after.png')
        code, out, err = run('add-fix', self.review, '--title', 'Sticky footer', '--files', 'a.tsx, b.tsx', '--pair', 'mobile', before, after,
                             '--pair', 'desktop', '-', after, '--resolves', 'a', '--partial', 'b', '--commit', 'abc1234', '--link', 'PR=https://x/pr/1')
        self.assertEqual(code, 0, err)
        d = self.data()
        fx = d['fixes'][0]
        self.assertEqual((fx['id'], fx['number']), ('fix-1', 1))
        self.assertEqual(fx['files'], ['a.tsx', 'b.tsx'])
        self.assertEqual(fx['issues'], ['a', 'b'])
        self.assertEqual(fx['platforms']['mobile']['pairs'][0], {'before': 'screenshots/fix-1/before.png', 'after': 'screenshots/fix-1/after.png'})
        self.assertEqual(fx['platforms']['desktop']['pairs'][0], {'after': 'screenshots/fix-1/after.png'})
        self.assertEqual(fx['links'], [{'label': 'PR', 'href': 'https://x/pr/1'}])
        self.assertEqual([i['status'] for i in d['issues']], ['fixed', 'partial'])
        self.assertRegex(fx['date'], r'^\d{4}-\d{2}-\d{2}$')
        run('add-fix', self.review, '--title', 'Second')
        self.assertEqual(self.data()['fixes'][1]['id'], 'fix-2')

    def test_add_fix_unknown_issue_fails(self):
        code, _, err = run('add-fix', self.review, '--title', 'X', '--resolves', 'ghost')
        self.assertEqual(code, 1)
        self.assertIn('ghost', err)
        self.assertEqual(self.data()['fixes'], [])

    def test_mark_issue_and_plan(self):
        run('add-issue', self.review, '--id', 'a', '--title', 'A', '--platform', 'mobile')
        run('add-plan', self.review, '--group', 'Roadmap', '--id', 'p1', '--title', 'Do it', '--files', 'x.ts')
        run('add-fix', self.review, '--title', 'F')
        self.assertEqual(run('mark', '-r', self.review, 'notabug', 'a', '--note', 'works as designed', '--fix', 'fix-1')[0], 0)
        self.assertEqual(run('mark', '-r', self.review, 'done', 'p1')[0], 0)
        d = self.data()
        self.assertEqual((d['issues'][0]['status'], d['issues'][0]['note']), ('notabug', 'works as designed'))
        self.assertEqual(d['fixes'][0]['issues'], ['a'])
        self.assertEqual(d['plan'][0]['items'][0]['status'], 'done')
        self.assertEqual(d['plan'][0]['items'][0]['files'], ['x.ts'])
        code, _, err = run('mark', '-r', self.review, 'fixed', 'p1')
        self.assertEqual(code, 1)
        self.assertIn('status must be one of', err)

    def test_apply_pending_envelopes_in_natural_order(self):
        run('add-issue', self.review, '--json', json.dumps([{'id': 'a', 'title': 'A', 'platform': 'mobile'}, {'id': 'b', 'title': 'B', 'platform': 'desktop'}]))
        run('add-plan', self.review, '--id', 'p1', '--title', 'Plan item')
        shot = self.png('agent/after.png')
        pending = os.path.join(self.dir, 'pending')
        with open(os.path.join(pending, 'fix10.json'), 'w') as f:
            json.dump({'title': 'Ten', 'number': 10, 'issues': ['b']}, f)  # bare fix
        with open(os.path.join(pending, 'fix2.json'), 'w') as f:
            json.dump({
                'fix': {'title': 'Two', 'summary': 'did **it**', 'platforms': {'mobile': {'pairs': [{'after': {'src': shot, 'caption': 'now'}}]}}},
                'issues': [{'id': 'c', 'title': 'Found while fixing', 'platform': 'mobile', 'severity': 'P2'}],
                'marks': [{'issue': 'a', 'status': 'fixed', 'note': 'done'}, {'plan': 'p1', 'status': 'partial'}],
            }, f)
        code, out, err = run('apply-pending', self.review)
        self.assertEqual(code, 0, err)
        self.assertLess(out.index('fix2.json'), out.index('fix10.json'))
        d = self.data()
        self.assertEqual([f['title'] for f in d['fixes']], ['Two', 'Ten'])
        self.assertEqual(d['fixes'][0]['number'], 1)
        self.assertEqual(d['fixes'][0]['issues'], ['a'])
        self.assertEqual(d['fixes'][0]['platforms']['mobile']['pairs'][0]['after'], {'src': 'screenshots/fix-1/after.png', 'caption': 'now'})
        self.assertEqual([i['id'] for i in d['issues']], ['a', 'b', 'c'])
        self.assertEqual(d['issues'][0]['status'], 'fixed')
        self.assertEqual(d['plan'][0]['items'][0]['status'], 'partial')
        self.assertEqual(sorted(os.listdir(pending)), ['.gitkeep', 'fix10.applied.json', 'fix2.applied.json'])
        self.assertEqual(run('apply-pending', self.review)[1].strip(), 'nothing pending')

    def test_apply_pending_stops_on_invalid_file(self):
        pending = os.path.join(self.dir, 'pending')
        with open(os.path.join(pending, 'bad.json'), 'w') as f:
            json.dump({'fix': {'title': 'Bad', 'issues': ['ghost']}}, f)
        code, _, err = run('apply-pending', self.review)
        self.assertEqual(code, 1)
        self.assertIn('ghost', err)
        self.assertTrue(os.path.exists(os.path.join(pending, 'bad.json')))
        self.assertEqual(self.data()['fixes'], [])

    def test_envelope_unknown_keys(self):
        with self.assertRaises(ReviewError):
            edit.normalise_envelope({'fix': {}, 'extra': 1})

    def test_summary(self):
        run('add-issue', self.review, '--json', json.dumps([{'id': 'a', 'title': 'A', 'platform': 'mobile', 'severity': 'P0'},
                                                             {'id': 'b', 'title': 'B', 'platform': 'desktop', 'severity': 'P2'}]))
        run('add-fix', self.review, '--title', 'Fix A', '--resolves', 'a')
        code, out, _ = run('summary', self.review)
        self.assertEqual(code, 0)
        self.assertIn('**Issues:** 2 total, 1 fixed, 0 partly fixed, 1 open (50% done)', out)
        self.assertIn('- #1 Fix A', out)
        self.assertIn('- P2 b [Desktop]: B', out)

    # -- regression: imported screenshots with the same file name (backend review issue-1)
    def test_same_basename_screenshots_do_not_overwrite_each_other(self):
        a, b = self.png('a/home.png', 4, 8), self.png('b/home.png', 6, 8)
        code, _, err = run('add-fix', self.review, '--title', 'T', '--pair', 'mobile', a, b)
        self.assertEqual(code, 0, err)
        for shot in (a, b):
            self.assertEqual(run('add-issue', self.review, '--title', 'I', '--platform', 'mobile', '--screenshot', shot)[0], 0)
        data = self.data()
        pair = data['fixes'][0]['platforms']['mobile']['pairs'][0]
        stored = [pair['before'], pair['after']] + [i['screenshots'][0] for i in data['issues']]
        self.assertEqual(len(set(stored)), 4, stored)
        for rel, orig in zip(stored, (a, b, a, b)):
            self.assertEqual(read_bytes(os.path.join(self.dir, rel)), read_bytes(orig), rel)

    def test_reimporting_an_identical_screenshot_reuses_the_copy(self):
        a = self.png('a/home.png')
        for _ in range(2):
            run('add-issue', self.review, '--title', 'I', '--platform', 'mobile', '--screenshot', a)
        self.assertEqual([i['screenshots'] for i in self.data()['issues']], [['screenshots/issues/home.png']] * 2)

    # -- regression: malformed input and OS errors are clean CLI errors (issue-3)
    def test_malformed_pending_envelope_is_a_clean_error(self):
        pending = os.path.join(self.dir, 'pending')
        for n, body in (('fix1.json', {'issues': 'x'}), ('fix2.json', {'fix': [1]}), ('fix3.json', {'marks': [1]})):
            with open(os.path.join(pending, n), 'w') as f:
                json.dump(body, f)
            code, _, err = run('apply-pending', self.review)
            self.assertEqual(code, 1, n)
            self.assertNotIn('Traceback', err)
            self.assertIn('review-kit:', err)
            os.remove(os.path.join(pending, n))

    def test_broken_review_json_is_reported_before_editing(self):
        data = self.data()
        data['issues'] = [{'title': 'no id'}]
        with open(self.review, 'w') as f:
            json.dump(data, f)
        for argv in (('add-issue', self.review, '--title', 'x'), ('add-fix', self.review, '--title', 'x'),
                     ('mark', '-r', self.review, 'fixed', 'a'), ('summary', self.review)):
            code, _, err = run(*argv)
            self.assertEqual(code, 1, argv)
            self.assertIn('run `review-kit validate`', err)

    def test_unknown_companion_kind_is_a_clean_error(self):
        code, _, err = run('companions', '--kind', 'foo')
        self.assertEqual(code, 1)
        self.assertIn('unknown review kind', err)

    @unittest.skipIf(hasattr(os, 'geteuid') and os.geteuid() == 0, 'root ignores permissions')
    def test_os_errors_are_clean_errors(self):
        os.chmod(self.dir, 0o555)
        try:
            code, _, err = run('add-issue', self.review, '--title', 'x', '--platform', 'mobile')
        finally:
            os.chmod(self.dir, 0o755)
        self.assertEqual(code, 1)
        self.assertIn('review-kit:', err)
        self.assertIn('ermission denied', err)

    # -- regression: mark takes the review positionally like every other command (issue-12)
    def test_mark_accepts_review_positionally_and_with_r(self):
        run('add-issue', self.review, '--json', json.dumps([{'id': 'a', 'title': 'A', 'platform': 'mobile'},
                                                             {'id': 'b', 'title': 'B', 'platform': 'mobile'}]))
        code, out, err = run('mark', self.dir, 'fixed', 'a')
        self.assertEqual(code, 0, err)
        code, out, err = run('mark', '-r', self.review, 'wontfix', 'b')
        self.assertEqual(code, 0, err)
        self.assertEqual([i['status'] for i in self.data()['issues']], ['fixed', 'wontfix'])
        code, _, err = run('mark', self.dir, 'fixed')
        self.assertEqual(code, 1)
        self.assertIn('ids', err)


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


if __name__ == '__main__':
    unittest.main()
