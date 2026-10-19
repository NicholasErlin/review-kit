import copy
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
DEMO = os.path.join(ROOT, 'examples', 'demo')


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def minimal():
    return {'version': 1, 'project': {'name': 'Test'}}


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='rk-test-')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def copy_demo(self):
        """A writable copy of the demo review (review.json + screenshots)."""
        d = os.path.join(self.tmp, 'demo')
        shutil.copytree(DEMO, d, ignore=shutil.ignore_patterns('site'))
        with open(os.path.join(d, 'review.json')) as f:
            data = json.load(f)
        data.pop('$schema', None)
        with open(os.path.join(d, 'review.json'), 'w') as f:
            json.dump(data, f)
        return os.path.join(d, 'review.json')

    def write(self, data, name='review.json'):
        p = os.path.join(self.tmp, name)
        with open(p, 'w') as f:
            json.dump(data, f)
        return p

    def png(self, name, w=4, h=8):
        sys.path.insert(0, DEMO)
        from make_images import Canvas
        p = os.path.join(self.tmp, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        Canvas(w, h, (10, 20, 30)).save(p)
        return p


def load_demo():
    with open(os.path.join(DEMO, 'review.json')) as f:
        return copy.deepcopy(json.load(f))
