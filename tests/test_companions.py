import io
import os
import tarfile
import unittest
from unittest import mock

from helpers import TempDirTest, read
from test_edit import run

from reviewkit import companions
from reviewkit.model import ReviewError


def tarball(files, links=()):
    """A gzipped tar shaped like a GitHub codeload download: everything under one top folder."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for name, body in files.items():
            data = body.encode()
            info = tarfile.TarInfo('repo-sha/' + name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for name, target in links:
            info = tarfile.TarInfo('repo-sha/' + name)
            info.type, info.linkname = tarfile.SYMTYPE, target
            tar.addfile(info)
    return buf.getvalue()


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


UI = '.claude/skills/ui-ux-pro-max/'


class CompanionsTest(TempDirTest):
    def setUp(self):
        super().setUp()
        self.bundle = os.path.join(self.tmp, 'bundle')
        self.skills = os.path.join(self.tmp, 'skills')
        self.urls = []
        blob = tarball({UI + 'SKILL.md': 'ui skill', UI + 'scripts/search.py': 'print(1)',
                        UI + 'scripts/tests/test_x.py': 'x', 'README.md': 'x', 'LICENSE': 'MIT License',
                        UI + '../../../evil.txt': 'nope'}, links=[(UI + 'data', '/etc')])

        def opener(url, timeout=None):
            self.urls.append(url)
            return FakeResponse(blob)
        self.opener = opener

    def update(self):
        return companions.update(['ui'], self.bundle, self.opener)

    def install(self, skills_dirs=None):
        return companions.install(['ui'], [self.skills] if skills_dirs is None else skills_dirs, self.bundle)

    def test_update_extracts_only_the_skill_with_license_and_source(self):
        self.update()
        self.assertEqual(self.urls, ['https://codeload.github.com/nextlevelbuilder/ui-ux-pro-max-skill/tar.gz/'
                                     + companions.SOURCES['nextlevelbuilder/ui-ux-pro-max-skill']])
        skill = os.path.join(self.bundle, 'ui-ux-pro-max')
        # no symlink, no README, no upstream tests
        self.assertEqual(sorted(os.listdir(skill)), ['LICENSE', 'SKILL.md', 'SOURCE', 'scripts'])
        self.assertEqual(os.listdir(os.path.join(skill, 'scripts')), ['search.py'])
        self.assertEqual(read(os.path.join(skill, 'LICENSE')), 'MIT License')
        self.assertIn(companions.SOURCES['nextlevelbuilder/ui-ux-pro-max-skill'], read(os.path.join(skill, 'SOURCE')))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'evil.txt')))

    def test_install_links_the_bundle_offline(self):
        self.update()
        self.urls.clear()
        self.assertIn('linked', '\n'.join(self.install()))
        self.assertEqual(self.urls, [])
        link = os.path.join(self.skills, 'ui-ux-pro-max')
        self.assertEqual(os.path.realpath(link), os.path.realpath(os.path.join(self.bundle, 'ui-ux-pro-max')))
        self.assertIn('already linked', '\n'.join(self.install()))

    def test_never_replaces_a_skill_installed_another_way(self):
        self.update()
        mine = os.path.join(self.skills, 'ui-ux-pro-max')
        os.makedirs(mine)
        with open(os.path.join(mine, 'SKILL.md'), 'w') as f:
            f.write('my copy')
        self.assertIn('left alone', '\n'.join(self.install()))
        self.assertEqual(read(os.path.join(mine, 'SKILL.md')), 'my copy')

    def test_bad_downloads_are_clean_errors(self):
        self.opener = lambda url, timeout=None: FakeResponse(tarball({'README.md': 'x'}))
        with self.assertRaisesRegex(ReviewError, 'not found'):
            self.update()
        self.opener = lambda url, timeout=None: FakeResponse(b'not a tarball')
        with self.assertRaisesRegex(ReviewError, 'not a valid archive'):
            self.update()
        with self.assertRaisesRegex(ReviewError, 'larger than'):
            companions._download('a/b', 'sha', lambda url, timeout=None: FakeResponse(b'x' * 11), limit=10)

    def test_find_prefers_installed_copies_over_the_bundle(self):
        self.update()
        with mock.patch.dict(os.environ, {'HOME': self.tmp}):
            self.assertEqual(companions.find('ui-ux-pro-max', self.tmp, self.bundle),
                             os.path.join(self.bundle, 'ui-ux-pro-max', 'SKILL.md'))
            agents = os.path.join(self.tmp, '.agents', 'skills', 'ui-ux-pro-max')
            os.makedirs(agents)
            open(os.path.join(agents, 'SKILL.md'), 'w').close()
            self.assertEqual(companions.find('ui-ux-pro-max', self.tmp, self.bundle), os.path.join(agents, 'SKILL.md'))

    def test_the_repo_bundles_every_companion(self):
        for kind in companions.KINDS:
            for c in companions.COMPANIONS[kind]:
                d = os.path.join(companions.BUNDLE, c['name'])
                for f in ('SKILL.md', 'LICENSE', 'SOURCE'):
                    self.assertTrue(os.path.isfile(os.path.join(d, f)), f'{c["name"]}/{f}')
                self.assertIn(companions.SOURCES[c['repo']], read(os.path.join(d, 'SOURCE')))

    def test_list_and_path_commands(self):
        with mock.patch.dict(os.environ, {'HOME': self.tmp}):
            code, out, err = run('companions', '--kind', 'backend')
            self.assertEqual(code, 0, err)
            for name in ('api-design-principles', 'architecture-patterns', 'error-handling-patterns'):
                self.assertIn(os.path.join(companions.BUNDLE, name), out)
            self.assertNotIn('ui-ux-pro-max', out)
            code, out, _ = run('companions', '--path', 'ui-ux-pro-max')
        self.assertEqual((code, out.strip()), (0, os.path.join(companions.BUNDLE, 'ui-ux-pro-max')))
        self.assertNotEqual(run('companions', '--path', 'nope')[0], 0)


if __name__ == '__main__':
    unittest.main()
