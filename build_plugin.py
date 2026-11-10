#!/usr/bin/env python3
"""Bundle the dependency-free browser controller into Figma's single UI file."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def build(check=False):
    source = ROOT / 'plugin/src'
    template = (source / 'ui.html').read_text()
    marker = '/*__FIGMA_CONNECTION__*/'
    if template.count(marker) != 1:
        raise ValueError('Expected one connection module slot')
    module = (source / 'connection.js').read_text().replace('</script', '<\\/script')
    result = template.replace(marker, module)
    target = ROOT / 'plugin/ui.html'
    if check:
        if not target.exists() or target.read_text() != result:
            raise SystemExit('plugin/ui.html is out of date; run python3 build_plugin.py')
    else:
        target.write_text(result)
    return result

if __name__ == '__main__':
    import sys
    build(check='--check' in sys.argv)
