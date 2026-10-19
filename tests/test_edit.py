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


if __name__ == '__main__':
    unittest.main()
