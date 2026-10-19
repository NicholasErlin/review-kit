import os
import shutil
import subprocess
import unittest
from unittest import mock

from helpers import ROOT, TempDirTest, read
from test_edit import run

from reviewkit import attach, model


class AttachTest(TempDirTest):
    def test_creates_review_and_pointer(self):
        code, out, err = run('attach', self.tmp, '--name', 'Shop', '--platforms', 'web')
        self.assertEqual(code, 0, err)
        data = model.load(os.path.join(self.tmp, '.review', 'ui', 'review.json'))
        self.assertEqual(data['project']['name'], 'Shop')
        self.assertEqual(data['project']['kind'], 'ui')
        self.assertEqual(data['project']['title'], 'UI/UX review')
        self.assertEqual([p['id'] for p in data['platforms']], ['web'])
        agents = read(os.path.join(self.tmp, 'AGENTS.md'))
        self.assertIn(attach.BEGIN, agents)
        self.assertIn('UI/UX: `.review/ui/review.json`', agents)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'CLAUDE.md')))

    def test_rerun_is_idempotent_and_keeps_existing_text(self):
        claude = os.path.join(self.tmp, 'CLAUDE.md')
        with open(claude, 'w') as f:
            f.write('# Rules\n\nBe nice.\n')
        run('attach', self.tmp)
        first = read(claude)
        self.assertTrue(first.startswith('# Rules\n\nBe nice.\n\n' + attach.BEGIN))
        code, out, _ = run('attach', self.tmp)
        self.assertEqual(code, 0)
        self.assertIn('ui: using existing .review/ui/review.json', out)
        self.assertIn('CLAUDE.md: review-kit pointer unchanged', out)
        self.assertEqual(read(claude), first)

    def test_pointer_write_is_atomic_and_keeps_the_file_mode(self):
        # regression: backend review issue-10
        agents = os.path.join(self.tmp, 'AGENTS.md')
        with open(agents, 'w') as f:
            f.write('# Mine\n')
        os.chmod(agents, 0o640)
        self.assertEqual(run('attach', self.tmp, '--no-agents-file')[0], 0)
        with mock.patch('os.replace', side_effect=OSError('disk full')):
            code, _, err = run('attach', self.tmp)
        self.assertEqual(code, 1)
        self.assertIn('disk full', err)
        self.assertEqual(read(agents), '# Mine\n')
        self.assertEqual(sorted(os.listdir(self.tmp)), ['.review', 'AGENTS.md'])
        self.assertEqual(run('attach', self.tmp)[0], 0)
        self.assertIn(attach.BEGIN, read(agents))
        self.assertEqual(os.stat(agents).st_mode & 0o777, 0o640)

    def test_replaces_an_outdated_pointer(self):
        agents = os.path.join(self.tmp, 'AGENTS.md')
        with open(agents, 'w') as f:
            f.write(f'top\n{attach.BEGIN}\nold text\n{attach.END}\nbottom\n')
        run('attach', self.tmp)
        s = read(agents)
        self.assertNotIn('old text', s)
        self.assertTrue(s.startswith('top\n') and s.endswith('bottom\n'))
        self.assertEqual(s.count(attach.BEGIN), 1)

    def test_reuses_review_elsewhere_and_skips_agents_file(self):
        run('init', os.path.join(self.tmp, 'docs', 'review'))
        code, out, _ = run('attach', self.tmp, '--no-agents-file')
        self.assertEqual(code, 0)
        self.assertIn('docs/review/review.json', out)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, '.review')))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'AGENTS.md')))

    def test_both_kinds(self):
        code, out, err = run('attach', self.tmp, '--kind', 'ui,backend', '--platforms', 'web')
        self.assertEqual(code, 0, err)
        ui = model.load(os.path.join(self.tmp, '.review', 'ui', 'review.json'))
        be = model.load(os.path.join(self.tmp, '.review', 'backend', 'review.json'))
        self.assertEqual(be['project']['kind'], 'backend')
        self.assertEqual(be['project']['title'], 'Backend review')
        self.assertEqual([p['id'] for p in be['platforms']], ['default'])
        self.assertEqual([p['id'] for p in ui['platforms']], ['web'])
        agents = read(os.path.join(self.tmp, 'AGENTS.md'))
        self.assertIn('Backend practices: `.review/backend/review.json`', agents)
        # adding a kind later keeps the first review and lists both
        code, out, _ = run('attach', self.tmp, '--kind', 'backend,ui')
        self.assertIn('backend: using existing', out)
        run('attach', self.tmp)  # default kind ui: the backend review stays in the pointer
        self.assertIn('Backend practices: `.review/backend/review.json`', read(os.path.join(self.tmp, 'AGENTS.md')))

    def test_kind_shortcut_and_ambiguous_discovery(self):
        run('attach', self.tmp, '--kind', 'ui,backend', '--no-agents-file')
        cwd = os.getcwd()
        os.chdir(self.tmp)
        try:
            code, out, err = run('add-issue', 'backend', '--title', 'Unbounded upload size', '--severity', 'P1')
            self.assertEqual(code, 0, err)
            self.assertEqual(len(model.load('.review/backend/review.json')['issues']), 1)
            code, _, err = run('validate')
            self.assertNotEqual(code, 0)
            self.assertIn('several reviews', err)
        finally:
            os.chdir(cwd)

    def test_init_kind_defaults(self):
        d = os.path.join(self.tmp, 'be')
        code, _, err = run('init', d, '--kind', 'backend')
        self.assertEqual(code, 0, err)
        data = model.load(os.path.join(d, 'review.json'))
        self.assertEqual((data['project']['kind'], data['project']['title']), ('backend', 'Backend review'))
        self.assertEqual(len(data['platforms']), 1)

    def test_unknown_kind(self):
        code, _, err = run('attach', self.tmp, '--kind', 'mobile')
        self.assertNotEqual(code, 0)
        self.assertIn('unknown review kind', err)

    def test_home_prints_kit_folder(self):
        code, out, _ = run('home')
        self.assertEqual(out.strip(), ROOT)


@unittest.skipUnless(shutil.which('bash'), 'needs bash')
class InstallTest(TempDirTest):
    def install(self, *args, stdin=None):
        env = dict(os.environ, HOME=self.tmp)
        cmd = ['bash', '-s', '--', *args] if stdin else ['bash', os.path.join(ROOT, 'install.sh'), *args]
        return subprocess.run(cmd, input=stdin, env=env, capture_output=True, text=True)

    def test_from_clone_links_command_and_skill(self):
        os.makedirs(os.path.join(self.tmp, '.claude', 'skills', 'review-kit'))
        r = self.install()
        self.assertEqual(r.returncode, 0, r.stderr)
        cmd = os.path.join(self.tmp, '.local', 'bin', 'review-kit')
        self.assertEqual(os.path.realpath(cmd), os.path.realpath(os.path.join(ROOT, 'bin', 'review-kit')))
        skill = os.path.join(self.tmp, '.claude', 'skills', 'review-kit')
        self.assertEqual(os.path.realpath(skill), os.path.realpath(os.path.join(ROOT, 'skill', 'review-kit')))
        self.assertEqual(os.listdir(os.path.dirname(skill)), ['review-kit'])
        self.assertTrue(os.listdir(os.path.join(self.tmp, '.review-kit-backups'))[0].startswith('claude-skill-'))
        out = subprocess.run([cmd, 'home'], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, ROOT)
        self.assertEqual(self.install().returncode, 0)

    def test_truncated_piped_install_does_nothing(self):
        # regression: backend review issue-11 (curl | bash cut off mid-download)
        script = read(os.path.join(ROOT, 'install.sh'))
        cut = script.index('ln -sfn')
        kit = os.path.join(self.tmp, 'kit')
        os.makedirs(os.path.join(kit, '.git'))
        bindir = os.path.join(self.tmp, 'bin')
        env = dict(os.environ, HOME=self.tmp, GIT_CEILING_DIRECTORIES=self.tmp)
        subprocess.run(['bash', '-s', '--', '--dir', kit, '--bin', bindir, '--no-skill'], input=script[:cut],
                       env=env, capture_output=True, text=True)
        self.assertFalse(os.path.exists(bindir))
        self.assertEqual(script.rstrip().splitlines()[-1], 'main "$@"')

    def test_piped_install_clones(self):
        if not os.path.isdir(os.path.join(ROOT, '.git')):
            self.skipTest('needs the kit as a git clone')
        env_repo = 'file://' + ROOT
        os.environ['REVIEW_KIT_REPO'] = env_repo
        try:
            r = self.install('--no-skill', stdin=read(os.path.join(ROOT, 'install.sh')))
        finally:
            del os.environ['REVIEW_KIT_REPO']
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('cloning', r.stdout)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, 'review-kit', 'bin', 'review-kit')))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, '.claude')))


if __name__ == '__main__':
    unittest.main()
