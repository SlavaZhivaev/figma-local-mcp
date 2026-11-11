import io
import unittest
from unittest.mock import patch
import updates

class Updates(unittest.TestCase):
    def check(self, payload, current='2.3.0'):
        with patch('urllib.request.urlopen',return_value=io.BytesIO(payload)):
            return updates.check(current)
    def test_new_version(self):
        result=self.check(b'{"version":"2.4.0","changes":["Fix"]}')
        self.assertTrue(result['available']);self.assertEqual(result['changes'],['Fix'])
    def test_equal_or_older(self):
        self.assertFalse(self.check(b'{"version":"2.3.0"}')['available'])
        self.assertFalse(self.check(b'{"version":"2.2.1-merged"}')['available'])
    def test_numeric_order(self):
        self.assertTrue(self.check(b'{"version":"2.10.0"}')['available'])
    def test_archive_installation_needs_no_git(self):
        import server
        with patch('updates.check',return_value={'available':True,'latest':'99.0.0'}), patch('subprocess.run',side_effect=AssertionError('git must not run')):
            self.assertTrue(server.check_updates()['available'])
    def test_network_failure(self):
        with patch('urllib.request.urlopen',side_effect=OSError('offline')):
            result=updates.check('2.3.0')
        self.assertFalse(result['available']);self.assertIn('error',result)
    def test_invalid_manifest(self):
        self.assertIn('error',self.check(b'{"version":"wrong"}'))
