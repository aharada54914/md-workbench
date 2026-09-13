#!/usr/bin/env python3
"""Deterministic artificial Markdown corpus. No networking or third-party packages."""
import argparse
import base64
import hashlib
import json
from pathlib import Path

VERSION = 1
PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='


def payloads(large=False):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect x="1" y="1" width="158" height="78" fill="none" stroke="black"/><text x="12" y="44">MD Workbench</text></svg>\n'
    core = '''---
title: "日本語・Markdown基準文書"
tags: [baseline, synthetic]
---
# 基準文書：図と文章

これは人工データです。利用者の文書・会話は含みません。

## GFM

| 項目 | 内容 |
| :--- | ---: |
| 図 | 2 |
| メモ | **強調** と `code` |

- [ ] 未完了
- [x] 完了

> 引用と ~~取り消し~~。

[相対リンク](./source-resources.md) / [見出し](#gfm)

![PNG](./assets/pixel.png "人工画像")
![SVG](./assets/box.svg)

```python
print("日本語とUTF-8")
```

数式: $x^2 + y^2 = z^2$。
'''
    unknown = '''# 未知構文の保持

<!-- mdw-resource:{"v":999,"kind":"unknown","extra":"保持"} -->

````unknown-language
```nested
Do not delete this source.
```
````

<div data-unknown="preserve">安全なHTML本文</div>

前後の空白も、無変更保存では保持する。  

'''
    mmd = 'flowchart LR\n  A["入力"] --> B{"確認"}\n  B -->|はい| C["保存"]\n'
    pages = []
    for i in (1, 2):
        pages.append(f'<diagram id="page-{i}" name="Page {i}"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Node {i}" vertex="1" parent="1" style="rounded=0;whiteSpace=wrap;html=0;"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram>')
    drawio = '<mxfile host="md-workbench-fixture">' + ''.join(pages) + '</mxfile>\n'
    diagrams = '# Mermaid 10図\n\n' + ''.join(f'## 図 {i}\n\n```mermaid\nflowchart LR\n  A{i}["入力 {i}"] --> B{i}["確認 {i}"]\n```\n\n' for i in range(1, 11))
    refs = '# 外部ソースと内蔵画像\n\n[Mermaid source](./diagrams/flow.mmd)\n\n[draw.io source](./diagrams/two-pages.drawio)\n\n![内蔵PNG](data:image/png;base64,' + PNG_BASE64 + ')\n'
    files = {
        'core-ja.md': core.encode('utf-8'),
        '日本語 空白/encoding-bom-crlf.md': b'\xef\xbb\xbf' + '# 日本語\r\n\r\n空白を保持。  \r\n'.encode('utf-8'),
        'unknown-syntax.md': unknown.encode('utf-8'),
        'mermaid-10.md': diagrams.encode('utf-8'),
        'source-resources.md': refs.encode('utf-8'),
        'assets/pixel.png': base64.b64decode(PNG_BASE64),
        'assets/box.svg': svg.encode('utf-8'),
        'diagrams/flow.mmd': mmd.encode('utf-8'),
        'diagrams/two-pages.drawio': drawio.encode('utf-8'),
    }
    prefix = b'# Deterministic document\n\n![PNG](./assets/pixel.png)\n![SVG](./assets/box.svg)\n\n'
    line = b'Artificial baseline paragraph. Same bytes on every platform.\n\n'
    for size, name in [(100 * 1024, 'document-100kib.md')] + ([(10 * 1024 * 1024, 'document-10mib.md')] if large else []):
        remaining = size - len(prefix)
        files[name] = prefix + (line * (remaining // len(line) + 1))[:remaining]
    return files


def manifest(files):
    return {'schema': 1, 'fixture_version': VERSION, 'generator': 'python-stdlib-no-randomness',
            'files': [{'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                      for name, data in sorted(files.items())]}


def write_fixture_set(destination, large=False):
    destination = Path(destination)
    data = payloads(large)
    # Check every destination before writing anything. Never overwrite an existing corpus.
    targets = [destination / name for name in data] + [destination / 'manifest.json']
    if any(p.exists() or p.is_symlink() for p in targets):
        raise FileExistsError('Choose an empty destination; existing fixture files are never overwritten')
    for name in data:
        target = destination / name
        if not target.resolve().is_relative_to(destination.resolve()):
            raise ValueError('Fixture path escapes destination')
    destination.mkdir(parents=True, exist_ok=True)
    for name, content in data.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as f:
            f.write(content)
    result = manifest(data)
    with (destination / 'manifest.json').open('x', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--large', action='store_true', help='Include exact 10 MiB document')
    args = parser.parse_args()
    result = write_fixture_set(args.out, args.large)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
