from pathlib import Path
import tempfile
import unittest
import deploy


class Deployment(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        source, destination = root / 'src', root / 'dest'
        source.mkdir(); destination.mkdir()
        (source / 'bridge.py').write_text('new bridge')
        (source / 'server.py').write_text('new server')
        (destination / 'server.py').write_text('old server')
        return source, destination

    def test_backup_and_restore_include_new_files(self):
        source, destination = self.fixture()
        result = deploy.install(destination, source, files=['bridge.py', 'server.py'])
        self.assertEqual(result['changed'], 2)
        self.assertEqual((destination / 'server.py').read_text(), 'new server')
        deploy.restore(result['backup'])
        self.assertEqual((destination / 'server.py').read_text(), 'old server')
        self.assertFalse((destination / 'bridge.py').exists())

    def test_failed_install_restores_already_written_files(self):
        source, destination = self.fixture()
        calls = []
        def failing_write(path, payload, mode):
            calls.append(path.name)
            if path.name == 'server.py':
                raise OSError('simulated failure')
            deploy.atomic_write(path, payload, mode)
        with self.assertRaises(OSError):
            deploy.install(destination, source, writer=failing_write, files=['bridge.py', 'server.py'])
        self.assertEqual(calls, ['bridge.py', 'server.py'])
        self.assertFalse((destination / 'bridge.py').exists())
        self.assertEqual((destination / 'server.py').read_text(), 'old server')

    def test_restore_preserves_later_user_edits(self):
        source, destination = self.fixture()
        result = deploy.install(destination, source, files=['bridge.py', 'server.py'])
        (destination / 'server.py').write_text('user edit')
        with self.assertRaisesRegex(ValueError, 'changed after installation'):
            deploy.restore(result['backup'])
        self.assertEqual((destination / 'server.py').read_text(), 'user edit')

    def test_repeated_install_is_noop(self):
        source, destination = self.fixture()
        deploy.install(destination, source, files=['bridge.py', 'server.py'])
        result = deploy.install(destination, source, files=['bridge.py', 'server.py'])
        self.assertEqual(result['changed'], 0)
        self.assertIsNone(result['backup'])
