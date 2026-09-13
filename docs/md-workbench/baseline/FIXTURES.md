# T01 比較用fixture v1

実在の文書・会話・画像は使わず、Python標準ライブラリだけで人工データを生成する。
ソースは `scripts/generate_mdw_fixtures.py`、全11ファイルのbytesとSHA-256は `fixtures.lock.json` を正とする。
大きなファイルやバイナリをGitに重複登録せず、生成器＋固定manifestとして保存する。

```sh
python scripts/generate_mdw_fixtures.py --out test-files/mdw-baseline-v1 --large
python scripts/test_mdw_fixtures.py
```

`--large`で10MiB文書を含む。出力先は未使用のディレクトリを指定し、既存fixtureへの上書きは拒否する。
既存 `.gitignore` の `test-files/` 配下は生成物の保存先として利用できる。

| fixture | 用途 |
|---|---|
| `core-ja.md` | 日本語、front matter、GFM表、task、画像、数式、相対リンク |
| `document-100kib.md` | 正確に102400 bytes、画像2参照 |
| `document-10mib.md` | 正確に10485760 bytes、負荷比較用。性能値はまだ測定しない |
| `mermaid-10.md` | 日本語label付きの10図 |
| `日本語 空白/encoding-bom-crlf.md` | UTF-8 BOM、CRLF、末尾2空白 |
| `unknown-syntax.md` | 未知fence、長いdelimiter、未知metadata、HTMLの保持 |
| `source-resources.md` | 外部ソースへの通常リンク、内蔵data URI画像 |
| `assets/pixel.png` | 有効な1×1 RGBA PNG。CRCと解凍後pixelsを検証 |
| `assets/box.svg` | 人工の安全なSVG。XML構造を検証 |
| `diagrams/flow.mmd` | Mermaidの外部ソース |
| `diagrams/two-pages.drawio` | 2pageの未圧縮XML。XML構造のみ検証済み |

## 検証の境界

10件のPython試験は**fixture生成器・bytes・構文の検査**であり、アプリが表示・往復保存できた証拠ではない。
既存アプリのテスト件数に合算しない。T03／T06／T10以降で同じmanifestを使って比較する。
TEST_PLANの全fixtureを実装したわけではない。最大data URI（上限未合意）、編集metadata付きPNG／SVG、攻撃corpus、OS長pathは対応taskで追加する。
PNGはgeneric imageでありdraw.io編集metadataを持たない。draw.io GUIでのimport、IME、OS関連付けの受入は未実施。

## 変更規則

生成内容を変えるPRではVERSIONとmanifestを同時に更新し、旧versionを比較対象として識別する。
テストを緑にするために期待hashだけを無断変更しない。固定manifestを変える理由と差分をPRへ書く。
