"""Public version checks work for both archive and Git installations."""
import json
import re
import urllib.request

REPOSITORY = 'https://github.com/SlavaZhivaev/figma-local-mcp'
MANIFEST = 'https://raw.githubusercontent.com/SlavaZhivaev/figma-local-mcp/main/version.json'

def version_key(value):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?', str(value))
    if not match: raise ValueError('Invalid version')
    return tuple(map(int, match.groups()))

def check(current):
    info = {'checked': True, 'current': current, 'available': False, 'url': REPOSITORY + '#установка'}
    try:
        request = urllib.request.Request(MANIFEST, headers={'User-Agent': 'Figma-Local-MCP', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read(65536))
        latest = data['version']
        info.update(latest=latest, available=version_key(latest) > version_key(current),
                    changes=[str(s)[:300] for s in data.get('changes', [])[:10]])
    except (OSError, ValueError, KeyError, TypeError) as error:
        info['error'] = 'Could not check GitHub: ' + str(error)
    return info
