"""Explicit, authenticated one-click updates from the fixed upstream repository."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile
import deploy


def unpack(payload, destination):
    root = Path(destination).resolve()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 32 * 1024 * 1024:
            raise ValueError('Archive too large')
        for item in archive.infolist():
            relative = Path(*Path(item.filename).parts[1:])
            target = (root / relative).resolve()
            if not target.is_relative_to(root): raise ValueError('Unsafe archive path')
            if item.is_dir(): continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(item))


class Updater:
    def __init__(self, destination, bridge, restart):
        self.destination = destination
        self.bridge = bridge
        self.restart = restart
        self.state = {'status':'idle'}
        self.lock = threading.Lock()

    def start(self):
        with self.lock, self.bridge.lock:
            if self.state['status'] == 'running': return dict(self.state)
            if self.bridge.active_files or any(f['busy'] or f['blocked'] for f in self.bridge.files()):
                raise ValueError('Дождитесь завершения команд и проверьте незавершённые записи перед обновлением')
            self.bridge.maintenance = True
            self.state = {'status':'running', 'message':'Скачиваю и проверяю обновление…'}
            threading.Thread(target=self.run, daemon=True).start()
            return dict(self.state)

    def run(self):
        result = None
        try:
            def fetch(url, limit):
                req = urllib.request.Request(url, headers={'User-Agent':'Figma-Local-MCP'})
                with urllib.request.urlopen(req, timeout=30) as response: data = response.read(limit+1)
                if len(data)>limit: raise ValueError('Download too large')
                return data
            commit = json.loads(fetch('https://api.github.com/repos/SlavaZhivaev/figma-local-mcp/commits/main', 1024*1024))['sha']
            if not re.fullmatch('[0-9a-f]{40}', commit): raise ValueError('Invalid commit')
            with tempfile.TemporaryDirectory(prefix='figma-update-') as folder:
                unpack(fetch('https://codeload.github.com/SlavaZhivaev/figma-local-mcp/zip/'+commit, 16*1024*1024), folder)
                env = dict(os.environ, FIGMA_AUTO_RAISE='0', PYTHONWARNINGS='ignore')
                for command in ([sys.executable,'build_plugin.py','--check'], [sys.executable,'-m','unittest','-q'], ['node','--test','tests/test_connection.mjs']):
                    result = subprocess.run(command,cwd=folder,env=env,capture_output=True,timeout=180)
                    if result.returncode: raise ValueError('Проверки обновления не прошли; установленная версия сохранена')
                completed = subprocess.run([sys.executable, 'deploy.py', str(self.destination)], cwd=folder, capture_output=True, text=True, timeout=60)
                if completed.returncode: raise ValueError('Не удалось установить обновление')
                result = json.loads(completed.stdout)
                for base in (Path.home()/'.codex', Path.home()/'.agents'):
                    target = base/'skills/figma-local/SKILL.md'
                    if target.is_file():
                        deploy.atomic_write(target.with_suffix('.md.pre-update.bak'),target.read_bytes(),0o600)
                        deploy.atomic_write(target,(Path(folder)/'skill/figma-local/SKILL.md').read_bytes(),0o644)
            self.state = {'status':'done','message':'Обновление установлено. Переподключаюсь…','backup':result['backup']}
            threading.Timer(3, self.restart).start()
        except Exception as error:
            if result and result.get('backup'):
                try: deploy.restore(result['backup'])
                except Exception: pass
            self.state = {'status':'error','message':str(error)}
        finally:
            with self.bridge.lock: self.bridge.maintenance = False
