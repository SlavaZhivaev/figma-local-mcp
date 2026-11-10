import threading
import time
import unittest
from multi_bridge import MultiBridge


class RoutingTests(unittest.TestCase):
    def test_routes_parallel_commands_and_rejects_ambiguous_target(self):
        b = MultiBridge(read_only=('figma_read',))
        b.poll('one', {'file': 'Vision'})
        b.poll('two', {'file': 'Kit'})
        with self.assertRaisesRegex(ValueError, 'Several'):
            b.call('figma_read', {})
        results = {}
        def run(file):
            results[file] = b.call('figma_read', {}, file, timeout=2)
        workers = [threading.Thread(target=run, args=(name,)) for name in ('Vision', 'Kit')]
        for worker in workers: worker.start()
        jobs = {}
        deadline = time.monotonic() + 1
        while len(jobs) < 2 and time.monotonic() < deadline:
            for sid in ('one', 'two'):
                if sid not in jobs:
                    job = b.poll(sid)
                    if job: jobs[sid] = job
            time.sleep(.005)
        self.assertEqual(len(jobs), 2)
        for sid, job in jobs.items():
            self.assertTrue(b.finish({'session': sid, 'id': job['id'], 'result': sid}))
        for worker in workers: worker.join(2)
        self.assertEqual(results['Vision']['result'], 'one')
        self.assertEqual(results['Kit']['result'], 'two')

    def test_duplicate_names_require_session(self):
        b = MultiBridge()
        b.poll('one', {'file': 'Deck'})
        b.poll('two', {'file': 'Deck'})
        with self.assertRaisesRegex(ValueError, 'session'):
            b._pick('Deck')
        self.assertEqual(b._pick('two')['session'], 'two')

if __name__ == '__main__':
    unittest.main()

class OutcomeTests(unittest.TestCase):
    def test_unknown_write_blocks_another_window_of_same_file_and_late_reply_clears(self):
        b = MultiBridge(read_only=('figma_read',))
        for sid in ('one', 'two'): b.poll(sid, {'file':'Deck','fileKey':'same'})
        errors = []
        def write():
            try: b.call('figma_apply', {}, 'one', timeout=.1)
            except ValueError as error: errors.append(str(error))
        worker = threading.Thread(target=write); worker.start()
        deadline = time.monotonic()+1; job=None
        while job is None and time.monotonic()<deadline:
            job=b.poll('one'); time.sleep(.005)
        worker.join(1)
        self.assertTrue(errors)
        with self.assertRaisesRegex(ValueError,'unknown outcome'):
            b.call('figma_apply',{},'two',timeout=.01)
        self.assertTrue(b.finish({'session':'one','id':job['id'],'result':1}))
        self.assertFalse(b.sessions['one']['queue'].blocked)

    def test_disconnect_retires_delivered_write(self):
        b=MultiBridge();b.poll('one',{'file':'Deck'})
        results=[]
        def write(): results.append(b.call('figma_apply',{},'one',timeout=1))
        worker=threading.Thread(target=write);worker.start()
        job=None
        for _ in range(100):
            job=b.poll('one')
            if job: break
            time.sleep(.005)
        self.assertIsNotNone(job)
        b.disconnect('one');worker.join(1)
        self.assertIn('unknown',results[0]['error'])
        b.poll('two',{'file':'Deck'})
        with self.assertRaisesRegex(ValueError,'unknown outcome'): b.call('figma_apply',{},'two',timeout=.01)
