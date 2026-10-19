import os
import shutil
import subprocess
import unittest

from helpers import ROOT, TempDirTest, read
from test_edit import run

from reviewkit import attach, model


class AttachTest(TempDirTest):
    def test_creates_review_and_pointer(self):
        code, out, err = run('attach', self.tmp, '--name', 'Shop', '--platforms', 'web')
        self.assertEqual(code, 0, err)
        data = model.load(os.path.join(self.tmp, '.review', 'review.json'))
        self.assertEqual(data['project']['name'], 'Shop')
        agents = read(os.path.join(self.tmp, 'AGENTS.md'))
        self.assertIn(attach.BEGIN, agents)
        self.assertIn('`.review/review.json`', agents)
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
        self.assertIn('using existing .review/review.json', out)
        self.assertIn('CLAUDE.md: review-kit pointer unchanged', out)
        self.assertEqual(read(claude), first)

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
