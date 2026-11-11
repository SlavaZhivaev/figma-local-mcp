import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from multi_bridge import MultiBridge
from updater import Updater, unpack

class UpdateTests(unittest.TestCase):
    def archive(self, name):
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as z:z.writestr(name,'content')
        return data.getvalue()
    def test_unpack(self):
        with tempfile.TemporaryDirectory() as d:
            unpack(self.archive('repo/file.txt'),d)
            self.assertEqual((Path(d)/'file.txt').read_text(),'content')
    def test_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):unpack(self.archive('repo/../../escape'),d)
    def test_busy_bridge_cannot_update(self):
        b=MultiBridge();b.active_files.add('Deck')
        u=Updater('/unused',b,lambda:None)
        with self.assertRaises(ValueError):u.start()
        self.assertFalse(b.maintenance)
    def test_failure_releases_maintenance_and_preserves_installation(self):
        b=MultiBridge();b.maintenance=True
        u=Updater('/unused',b,lambda:self.fail('must not restart'))
        with patch('urllib.request.urlopen',side_effect=OSError('offline')),patch('deploy.install') as install:
            u.run();install.assert_not_called()
        self.assertEqual(u.state['status'],'error');self.assertFalse(b.maintenance)
    def test_repeated_click_does_not_start_second_worker(self):
        b=MultiBridge();u=Updater('/unused',b,lambda:None);u.state={'status':'running'}
        with patch('threading.Thread') as thread:
            self.assertEqual(u.start()['status'],'running');thread.assert_not_called()
