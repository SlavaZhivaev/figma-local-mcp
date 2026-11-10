"""Route independent plugin windows to the 2.2 command lifecycle.

Each window owns a 2.2 queue; unknown writes also protect other windows of the same file.
"""
import threading
import time
from bridge_queue import BridgeQueue


class MultiBridge:
    def __init__(self, read_only=(), stale_after=10):
        self.read_only = read_only
        self.stale_after = stale_after
        self.lock = threading.RLock()
        self.sessions = {}
        self.active_files = set()

    def poll(self, session, info=None, wait=0, visible=None):
        if not isinstance(session, str) or not 1 <= len(session) <= 100:
            raise ValueError('Invalid session')
        info = info or {}
        with self.lock:
            entry = self.sessions.get(session)
            if entry is None:
                entry = {'queue': BridgeQueue(self.read_only), 'file': '(file name unknown)', 'page': '', 'fileKey': None}
                self.sessions[session] = entry
            for key in ('file', 'page', 'fileKey'):
                value = info.get(key)
                if isinstance(value, str) and value:
                    entry[key] = value[:200]
            queue = entry['queue']
        return queue.poll(session, wait, visible)

    def files(self):
        with self.lock:
            for sid, entry in self.sessions.items():
                q = entry["queue"]
                if q.session and time.monotonic() - q.last_seen >= self.stale_after:
                    q.disconnect(sid)
            return [{'file': e['file'], 'page': e['page'], 'fileKey': e['fileKey'],
                     'session': sid, 'busy': e['queue'].job is not None,
                     'blocked': e['queue'].blocked}
                    for sid, e in self.sessions.items()
                    if time.monotonic() - e['queue'].last_seen < self.stale_after]

    def _pick(self, file=None):
        files = self.files()
        if file:
            matches = [f for f in files if f['session'] == file]
            if not matches:
                matches = [f for f in files if f['file'].lower() == file.lower()]
            if not matches:
                matches = [f for f in files if file.lower() in f['file'].lower()]
        else:
            matches = files
        if len(matches) > 1:
            raise ValueError('Several Figma files match; pass the session id as file')
        if not matches:
            raise ValueError('No matching Figma file is connected')
        return matches[0]

    def call(self, action, args, file=None, timeout=180, wait=8):
        deadline = time.monotonic() + wait
        while True:
            try:
                with self.lock:
                    entry = self.sessions[self._pick(file)["session"]]
                break
            except ValueError as error:
                if "Several" in str(error) or time.monotonic() >= deadline: raise
                time.sleep(.05)
        identity = entry.get('fileKey') or entry['file']
        with self.lock:
            blocked = any((e.get('fileKey') or e['file']) == identity and e['queue'].blocked for e in self.sessions.values())
            if blocked and action not in self.read_only:
                raise ValueError('Previous command has unknown outcome; inspect the file before unblocking')
            if identity in self.active_files:
                raise ValueError('Busy: another command targets this file')
            self.active_files.add(identity)
        try:
            return entry['queue'].call(action, args, timeout)
        finally:
            with self.lock: self.active_files.discard(identity)

    def finish(self, data):
        with self.lock:
            entry = self.sessions.get(data.get('session'))
        if entry is None and not data.get('session'):
            with self.lock:
                candidates = [e for e in self.sessions.values() if e['queue'].job and e['queue'].job['id'] == data.get('id')]
                entry = candidates[0] if len(candidates) == 1 else None
        return bool(entry and entry['queue'].finish(data))

    def disconnect(self, session):
        with self.lock:
            entry = self.sessions.get(session)
        return bool(entry and entry['queue'].disconnect(session))

    def unblock(self, file=None):
        with self.lock:
            if file is None:
                queues = [e['queue'] for e in self.sessions.values()]
            else:
                chosen = self.sessions[self._pick(file)['session']]
                identity = chosen.get('fileKey') or chosen['file']
                queues = [e['queue'] for e in self.sessions.values() if (e.get('fileKey') or e['file']) == identity]
        for queue in queues:
            queue.unblock()
