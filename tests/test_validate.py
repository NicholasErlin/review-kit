import unittest

from helpers import DEMO, load_demo, minimal

from reviewkit import model, validate


def schema_errors(data):
    return validate.SchemaValidator(model.load_schema()).errors(data)


class SchemaTest(unittest.TestCase):
    def test_minimal_document_is_valid(self):
        self.assertEqual(validate.validate(minimal(), DEMO), ([], []))

    def test_demo_is_valid(self):
        errors, warnings = validate.validate(load_demo(), DEMO)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_version_and_project_required(self):
        errs = schema_errors({})
        self.assertIn('(root): missing required "version"', errs)
        self.assertIn('(root): missing required "project"', errs)
        self.assertTrue(any('must be 1' in e for e in schema_errors({'version': 2, 'project': {'name': 'x'}})))

    def test_unknown_property_rejected(self):
        d = minimal()
        d['issues'] = [{'id': 'a', 'title': 't', 'severty': 'P0'}]
        self.assertIn('issues[0]: unknown property "severty"', schema_errors(d))

    def test_bad_status_enum(self):
        d = minimal()
        d['issues'] = [{'id': 'a', 'title': 't', 'status': 'done'}]
        self.assertTrue(any('issues[0].status' in e and 'not one of' in e for e in schema_errors(d)))

    def test_bad_id_pattern_and_types(self):
        d = minimal()
        d['issues'] = [{'id': 'has space', 'title': 't'}, {'id': 'ok', 'title': '', 'top': 'yes'}]
        errs = schema_errors(d)
        self.assertTrue(any(e.startswith('issues[0].id') for e in errs))
        self.assertIn('issues[1].title: must not be empty', errs)
        self.assertIn('issues[1].top: expected boolean, got str', errs)

    def test_image_forms(self):
        d = minimal()
        d['issues'] = [{'id': 'a', 'title': 't', 'screenshots': ['x.png', {'src': 'y.png', 'caption': 'c'}]}]
        self.assertEqual(schema_errors(d), [])
        d['issues'][0]['screenshots'] = [{'caption': 'no src'}]
        self.assertTrue(any('missing required "src"' in e for e in schema_errors(d)))

    def test_pair_needs_before_or_after(self):
        d = minimal()
        d['fixes'] = [{'id': 'f', 'title': 't', 'platforms': {'default': {'pairs': [{'caption': 'x'}]}}}]
        self.assertTrue(any('needs one of before, after' in e for e in schema_errors(d)))

    def test_theme_colour_pattern(self):
        d = minimal()
        d['project']['theme'] = {'accent': 'red'}
        self.assertTrue(any('theme.accent' in e for e in schema_errors(d)))


    def test_anchored_patterns_reject_a_trailing_newline(self):
        # regression: backend review issue-6 (Python's $ also matches before a final newline)
        d = minimal()
        d['project']['theme'] = {'accent': '#fff\n'}
        d['issues'] = [{'id': 'abc\n', 'title': 'x'}]
        errs = schema_errors(d)
        self.assertTrue(any('theme.accent' in e for e in errs), errs)
        self.assertTrue(any('issues[0].id' in e for e in errs), errs)
        d['project']['theme'] = {'accent': '#fff'}
        d['issues'][0]['id'] = 'abc'
        self.assertEqual(schema_errors(d), [])


class SemanticTest(unittest.TestCase):
    def test_cross_references(self):
        d = load_demo()
        d['issues'][0]['platform'] = 'tablet'
        d['issues'][1]['severity'] = 'P9'
        d['fixes'][0]['issues'].append('nope')
        d['fixes'][1]['platforms']['watch'] = {}
        d['plan'][0]['items'][0]['fixes'] = ['fix-404']
        errors, _ = validate.validate(d, DEMO)
        joined = '\n'.join(errors)
        self.assertIn('unknown platform "tablet"', joined)
        self.assertIn('unknown severity "P9"', joined)
        self.assertIn('fixes[fix-1]: unknown issue "nope"', joined)
        self.assertIn('fixes[fix-2]: unknown platform "watch"', joined)
        self.assertIn('unknown fix "fix-404"', joined)

    def test_duplicate_ids(self):
        d = load_demo()
        d['issues'].append(dict(d['issues'][0]))
        errors, _ = validate.validate(d, DEMO)
        self.assertIn('duplicate issue id "m-1"', errors)

    def test_missing_image(self):
        d = load_demo()
        d['fixes'][0]['platforms']['mobile']['pairs'][0]['after']['src'] = 'screenshots/missing.png'
        errors, _ = validate.validate(d, DEMO)
        self.assertTrue(any('image not found: screenshots/missing.png' in e for e in errors))
        self.assertEqual(validate.validate(d, DEMO, check_files=False)[0], [])

    def test_warnings(self):
        d = load_demo()
        d['issues'][0]['area'] = 'free text page'
        del d['issues'][1]['platform']
        d['fixes'][1]['number'] = 1
        _, warnings = validate.validate(d, DEMO)
        joined = '\n'.join(warnings)
        self.assertIn('not an area id', joined)
        self.assertIn('no platform set', joined)
        self.assertIn('number 1 also used', joined)

    def test_custom_severities(self):
        d = minimal()
        d['severities'] = [{'id': 'critical', 'color': '#ff0000'}, {'id': 'minor'}]
        d['issues'] = [{'id': 'a', 'title': 't', 'severity': 'critical'}, {'id': 'b', 'title': 't', 'severity': 'P0'}]
        errors, _ = validate.validate(d, DEMO)
        self.assertEqual(errors, ['issues[b]: unknown severity "P0" (known: critical, minor)'])


if __name__ == '__main__':
    unittest.main()
