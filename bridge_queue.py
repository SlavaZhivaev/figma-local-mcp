"""Single-flight command lifecycle, independent of HTTP and the MCP client.

A delivered write is never replayed. If its outcome is unknown, only inspection
commands are allowed until its result arrives or the user explicitly unblocks.
"""
import math
import secrets
import threading
import time
import uuid
from collections import OrderedDict


class BridgeQueue:
    def __init__(self, read_only=()):
        self.token = secrets.token_urlsafe(32)
        self.read_only = frozenset(read_only)
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        self.job = None
        self.last_seen = float('-inf')
        self.session = None
        self.blocked = False
        self.visible = None
        self.move_to = None
        self.file_key = None
        self._uncertain = OrderedDict()
        self._block_id = None
        self._finished = OrderedDict()

    @staticmethod
    def _remember(cache, key, value):
        cache[key] = value
        while len(cache) > 128:
            cache.popitem(last=False)

    def _hold_uncertain(self, job):
        self.blocked = True
        self._block_id = job['id']
        self._remember(self._uncertain, job['id'], job)

    def _retire(self):
        """Called under the lock when the owning plugin window disappears."""
        job, self.job = self.job, None
        if job is None:
            return
        if job['sent']:
            if job['action'] not in self.read_only:
                self._hold_uncertain(job)
            else:
                self._remember(self._finished, job['id'], True)
            message = ('Figma plugin restarted after the command was delivered; '
                       'its outcome is unknown. Inspect the file before retrying.')
        else:
            message = ('Figma plugin restarted before the command was delivered; '
                       'nothing was applied.')
        job['result'] = {'id': job['id'], 'error': message}
        job['event'].set()

    def disconnect(self, session):
        with self.lock:
            if not isinstance(session, str) or session != self.session:
                return False
            self._retire()
            self.session = None
            self.last_seen = float('-inf')
            self.wake.notify_all()
            return True

    def poll(self, session, wait=0, visible=None):
        if not isinstance(session, str) or not 1 <= len(session) <= 100:
            raise ValueError('Invalid session')
        try:
            seconds = float(wait or 0)
        except (TypeError, ValueError):
            raise ValueError('Invalid poll wait')
        if not math.isfinite(seconds):
            raise ValueError('Invalid poll wait')
        deadline = time.monotonic() + max(0, min(seconds, 25))
        with self.wake:
            while True:
                job = self._poll_locked(session, visible)
                remaining = deadline - time.monotonic()
                if job is not None or remaining <= 0:
                    return job
                self.wake.wait(min(1.0, remaining))
                if self.session != session:
                    return None

    def _poll_locked(self, session, visible):
        stale = self.session is not None and self.session != session
        if stale and time.monotonic() - self.last_seen < 10:
            raise ValueError('Another Figma plugin is connected. Close it first.')
        if stale:
            self._retire()
        if isinstance(visible, bool):
            self.visible = visible
        if self.move_to and self.job is None and not self.blocked:
            port, self.move_to = self.move_to, None
            self.session, self.last_seen = None, float('-inf')
            return {'moveTo': port}
        self.session, self.last_seen = session, time.monotonic()
        if self.job is not None and not self.job['sent']:
            self.job['sent'] = True
            self.job['session'] = session
            return {key: self.job[key] for key in ('id', 'action', 'args')}
        return None

    def claim(self, wait=4):
        return False

    def unblock(self):
        with self.lock:
            self.blocked = False
            self._block_id = None
            self.wake.notify_all()

    def finish(self, data):
        """Acknowledge duplicate replies without completing any newer command."""
        if not isinstance(data, dict) or not isinstance(data.get('id'), str):
            raise ValueError('Invalid result')
        ident = data['id']
        with self.lock:
            active = self.job if self.job and self.job['id'] == ident else None
            job = active or self._uncertain.get(ident)
            if job is None:
                return ident in self._finished
            if not job['sent']:
                return False
            if data.get('session') is not None and data['session'] != job.get('session'):
                return False
            if ident in self._finished:
                return True
            self._remember(self._finished, ident, True)
            if active is not None:
                job['result'] = data
                job['event'].set()
            self._uncertain.pop(ident, None)
            if self._block_id == ident:
                self._block_id = None
                self.blocked = False
            self.wake.notify_all()
            return True

    def _check_available(self, action):
        if self.blocked and action not in self.read_only:
            raise ValueError('Previous command has unknown outcome. Inspect the file in Figma, '
                             'then call figma_status with unblock=true to allow writes again.')
        if self.job is not None:
            raise ValueError('Busy: wait for the current command.')

    def call(self, action, args, timeout=180):
        with self.lock:
            self._check_available(action)
            connected = time.monotonic() - self.last_seen <= 10
        if not connected and not self.claim():
            raise ValueError('Open Figma Local MCP plugin and connect using figma_status credentials.')
        with self.wake:
            # Claiming can wait for another session. State may have changed meanwhile.
            self._check_available(action)
            job = dict(id=str(uuid.uuid4()), action=action, args=args,
                       sent=False, event=threading.Event(), session=None)
            self.job = job
            self.wake.notify_all()
        job['event'].wait(timeout)
        with self.lock:
            # Check the event again under the lock: a reply may win the timeout race.
            if job['event'].is_set():
                if self.job is job:
                    self.job = None
                self.wake.notify_all()
                return job['result']
            if job['sent']:
                if action not in self.read_only:
                    self._hold_uncertain(job)
                else:
                    self._remember(self._finished, job['id'], True)
            if self.job is job:
                self.job = None
            self.wake.notify_all()
        raise ValueError('Command timed out. Delivery: %s. Do not retry a write blindly.' % job['sent'])
