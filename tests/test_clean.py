import os
import unittest

from helpers import ROOT, TempDirTest
from test_edit import run

from reviewkit import build, clean, model, validate

BASIC_APP = os.path.join(ROOT, 'examples', 'basic-app', 'review')


class CleanTest(TempDirTest):
    def setUp(self):
        super().setUp()
        self.review = self.copy_demo()
        self.base = model.base_dir(self.review)
        self.site = os.path.join(self.base, 'site')
        build.build(self.review, self.site, quiet=True)
        self.pending = os.path.join(self.base, 'pending')
        os.makedirs(self.pending, exist_ok=True)
        for n in ('fix1.applied.json', 'fix2.json'):
            with open(os.path.join(self.pending, n), 'w') as f:
                f.write('{}')
        self.orphan = self.png('demo/screenshots/old/unused.png')

    def test_default_removes_site_and_applied_only(self):
        code, out, err = run('clean', self.review)
        self.assertEqual(code, 0, err)
        self.assertFalse(os.path.exists(self.site))
        self.assertEqual(sorted(os.listdir(self.pending)), ['fix2.json'])
        self.assertTrue(os.path.exists(self.orphan))
        self.assertEqual(validate.validate(model.load(self.review), self.base)[0], [])

    def test_orphans_removes_unreferenced_screenshots_only(self):
        self.assertEqual(clean.orphans(self.review), [os.path.normpath(self.orphan)])
        run('clean', self.review, '--orphans', '--keep-site')
        self.assertTrue(os.path.isdir(self.site))
        self.assertFalse(os.path.exists(os.path.dirname(self.orphan)))
        self.assertEqual(validate.validate(model.load(self.review), self.base)[0], [])

    def test_dry_run_touches_nothing(self):
        code, out, _ = run('clean', self.review, '--orphans', '--dry-run')
        self.assertEqual(code, 0)
        self.assertIn('would remove', out)
        self.assertTrue(os.path.isdir(self.site))
        self.assertTrue(os.path.exists(os.path.join(self.pending, 'fix1.applied.json')))
        self.assertTrue(os.path.exists(self.orphan))

    def test_leaves_folders_not_built_by_review_kit(self):
        other = os.path.join(self.tmp, 'mine')
        os.makedirs(other)
        code, out, _ = run('clean', self.review, '--out', other)
        self.assertEqual(code, 0)
        self.assertIn('skipped', out)
        self.assertTrue(os.path.isdir(other))


class BasicAppExampleTest(unittest.TestCase):
    def test_committed_review_is_valid_and_tidy(self):
        path = os.path.join(BASIC_APP, 'review.json')
        errors, _ = validate.validate(model.load(path), BASIC_APP)
        self.assertEqual(errors, [])
        self.assertEqual(clean.orphans(path), [])


if __name__ == '__main__':
    unittest.main()
