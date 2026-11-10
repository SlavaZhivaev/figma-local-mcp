import threading
import time
import unittest
from bridge_queue import BridgeQueue
from server import READ_ONLY
class Bridge(BridgeQueue):
    def __init__(self): super().__init__(READ_ONLY)


class Lifecycle(unittest.TestCase):
    def connected(self):
        bridge = Bridge()
        bridge.poll('owner')
        return bridge

    def launch(self, bridge, action='figma_apply', timeout=1):
        result = {}
        def call():
            try:
                result['value'] = bridge.call(action, {}, timeout)
            except ValueError as error:
                result['error'] = str(error)
        thread = threading.Thread(target=call)
        thread.start()
        for _ in range(100):
            with bridge.lock:
                if bridge.job is not None:
                    return result, thread
            time.sleep(.002)
        self.fail('No command queued')

    def unknown_write(self, bridge):
        result, thread = self.launch(bridge, timeout=.03)
        command = bridge.poll('owner')
        thread.join(1)
        self.assertIn('timed out', result['error'])
        self.assertTrue(bridge.blocked)
        return command

    def test_inspection_allowed_after_write_timeout(self):
        bridge = self.connected()
        self.unknown_write(bridge)
        result, thread = self.launch(bridge, 'figma_read')
        command = bridge.poll('owner')
        bridge.finish({'id': command['id'], 'result': {'nodes': []}})
        thread.join(1)
        self.assertIn('value', result)
        self.assertTrue(bridge.blocked, 'Inspection must not acknowledge the earlier write')
        with self.assertRaisesRegex(ValueError, 'unknown outcome'):
            bridge.call('figma_apply', {})

    def test_late_result_resolves_its_own_write_only(self):
        bridge = self.connected()
        first = self.unknown_write(bridge)
        bridge.unblock()
        second = self.unknown_write(bridge)
        self.assertTrue(bridge.finish({'id': first['id'], 'result': 1}))
        self.assertTrue(bridge.blocked)
        self.assertTrue(bridge.finish({'id': second['id'], 'result': 2}))
        self.assertFalse(bridge.blocked)

    def test_disconnect_delivered_write_not_replayed(self):
        bridge = self.connected()
        result, thread = self.launch(bridge)
        command = bridge.poll('owner')
        self.assertTrue(bridge.disconnect('owner'))
        thread.join(1)
        self.assertIn('outcome is unknown', result['value']['error'])
        self.assertTrue(bridge.blocked)
        self.assertIsNone(bridge.poll('replacement'))
        self.assertTrue(bridge.finish({'id': command['id'], 'session': 'owner', 'result': 1}))
        self.assertFalse(bridge.blocked)

    def test_disconnect_undelivered_command_not_given_to_new_window(self):
        bridge = self.connected()
        result, thread = self.launch(bridge)
        bridge.disconnect('owner')
        thread.join(1)
        self.assertIn('before the command was delivered', result['value']['error'])
        self.assertFalse(bridge.blocked)
        self.assertIsNone(bridge.poll('replacement'))

    def test_wrong_session_cannot_complete_command(self):
        bridge = self.connected()
        result, thread = self.launch(bridge)
        command = bridge.poll('owner')
        self.assertFalse(bridge.finish({'id': command['id'], 'session': 'other', 'result': 1}))
        self.assertTrue(bridge.finish({'id': command['id'], 'session': 'owner', 'result': 2}))
        thread.join(1)
        self.assertEqual(result['value']['result'], 2)

    def test_duplicate_reply_does_not_complete_next_job(self):
        bridge = self.connected()
        result, thread = self.launch(bridge)
        first = bridge.poll('owner')
        bridge.finish({'id': first['id'], 'result': 1})
        thread.join(1)
        next_result, next_thread = self.launch(bridge)
        second = bridge.poll('owner')
        self.assertTrue(bridge.finish({'id': first['id'], 'result': 999}))
        self.assertFalse(bridge.job['event'].is_set())
        bridge.finish({'id': second['id'], 'result': 2})
        next_thread.join(1)
        self.assertEqual(next_result['value']['result'], 2)

    def test_state_rechecked_after_claim(self):
        bridge = Bridge()
        def claim():
            bridge.blocked = True
            return True
        bridge.claim = claim
        with self.assertRaisesRegex(ValueError, 'unknown outcome'):
            bridge.call('figma_apply', {})
        self.assertIsNone(bridge.job)

    def test_busy_long_poll_wakes_once(self):
        bridge = self.connected()
        result, thread = self.launch(bridge)
        first = bridge.poll('owner')
        self.assertIsNone(bridge.poll('owner'))
        bridge.finish({'id': first['id'], 'result': 1})
        thread.join(1)
        self.assertIn('value', result)

    def test_non_finite_wait_rejected(self):
        bridge = self.connected()
        for value in [float('nan'), float('inf'), 'invalid']:
            with self.assertRaises(ValueError):
                bridge.poll('owner', value)

    def test_late_read_reply_is_acknowledged_without_touching_next_command(self):
        bridge = self.connected()
        result, thread = self.launch(bridge, 'figma_read', timeout=.03)
        first = bridge.poll('owner')
        thread.join(1)
        self.assertFalse(bridge.blocked)
        next_result, next_thread = self.launch(bridge, 'figma_read')
        second = bridge.poll('owner')
        self.assertTrue(bridge.finish({'id': first['id'], 'result': 'late'}))
        self.assertFalse(bridge.job['event'].is_set())
        bridge.finish({'id': second['id'], 'result': 'current'})
        next_thread.join(1)
        self.assertEqual(next_result['value']['result'], 'current')
