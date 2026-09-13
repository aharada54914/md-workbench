# T01 上流ベースライン実行報告

実行日: **2026-09-13 UTC**（日本時間2026-09-14）。対象: [T01 / #11](https://github.com/aharada54914/md-workbench/issues/11)、要件R03・R18。
成果物PR: [#35](https://github.com/aharada54914/md-workbench/pull/35)。仕様PR #1とは別の検証用変更。

**ベースライン採取は実施済み。ただしWindowsの上流単体テスト1件は失敗している。全テスト成功とはしない。**
本PRは既存機能の試験結果・依存解決・人工fixtureを保存するもので、製品の新機能実装や受入完了を意味しない。

## 1. 固定した入力と実行環境

- アプリソース: `c5aecc311f5295e872002309dcf72cfd96a8ad84`（MerMark Editor v0.7.3由来）。tree: `a5f002aef62a4d729520debb23769cacd07d314b`。
- 初回検証ツール: `ed191c8c75e2c550108c93784f58b94d2c7eb352`。PRのソースではなく、別checkoutの固定アプリSHAを実行した。
- 追加のfixture／Windows改行診断: `c23cb0c0a4c2255c03d13ea50f658d1f239ac19c`。
- Node **22.16.0**、pnpm **11.3.0**、rustc **1.93.0**、cargo **1.93.0**。実際のversion出力はActions artifact内にある。
- Ubuntu runner: `ubuntu-24.04` / image `20260907.300.1`、Python3.12.3、git2.55.0、Rust host `x86_64-unknown-linux-gnu`。
- Windows runner: **Windows Server 2022** / image `20260907.297.1`、Python3.12.10、git2.55.0.windows.5、Rust host `x86_64-pc-windows-msvc`。Windows11実機ではない。
- rustc commit: `254b59607d4417e9dffbc307138ae5c86280fe4c`、LLVM21.1.8。OSイメージ・system libraryまで将来完全固定される環境ではない。

上流のpackage.json／pnpm-lock.yaml／pnpm-workspace.yamlを変更せず`--frozen-lockfile`で導入した。主要な解決値はVue3.5.26、Tiptap3.15.3、Mermaid11.15.0、KaTeX0.18.4、Vite6.4.3、Vitest4.1.8、Playwright1.58.2、TypeScript5.7.3。Rust側はTauri2.11.5、tauri-build2.6.3、tokio1.53.1、reqwest0.13.5。全件は元pnpm lockと下記Cargo snapshotを参照。

## 2. 既存テスト・ビルドの実測結果

[初回baseline run 34765975038](https://github.com/aharada54914/md-workbench/actions/runs/34765975038)

| 対象 | Ubuntu 24.04 | Windows Server 2022 |
|---|---|---|
| frozen install | 成功 | 成功 |
| `pnpm test:run` | 87 files、**1182成功** | 86 files成功・1 file失敗、**1181成功・1失敗** |
| `pnpm build` | 成功 | 成功 |
| `pnpm test:e2e --reporter=list,json` | **37成功・2スキップ** | **37成功・2スキップ** |
| Cargo依存解決 | 成功 | 成功 |
| `cargo test --locked` | **188成功・0失敗** | **189成功・0失敗** |
| `cargo build --locked` | 成功（debug） | 成功（debug） |
| アプリsource／manifest／pnpm lockのgit diff | 変更なし | 変更なし |

Windowsの単体テスト失敗後も独立するbuild／E2E／Rust試験を実行し、最後にrunnerは非0終了した。baselineのWindowsジョブは失敗として保存されている。

ブラウザE2EはVite（port1421）と上流のTauri mockを使う。37件成功は、OS関連付け・実filesystem権限・AI sandbox・日本語IMEのネイティブ受入を意味しない。native buildは実行ファイルのコンパイルであり、起動・installer・署名・release buildの検証ではない。

### 上流で既に設定されていた2件のスキップ

- `tests/e2e/large-file-open.test.ts:173`: `external file change reloads lazy visual mode without full conversion`。上流の`test.fixme`。T01で新たに除外したのではない。
- `tests/e2e/release-screenshots.test.ts:4`: release用スクリーンショット生成。`RELEASE_SCREENSHOTS=1`の明示実行が必要であり、今回は未指定。

## 3. Windows失敗の切り分け

対象: `src/__tests__/utils/math.test.ts:86` の `rendering and exports > renders all examples in the demonstration document`。
この試験は`docs/math-showcase.md`から読み込んだ数式source列と、Markdown→HTML→Markdown後のsource列の一致を確認する。

[改行診断 run 34766651345](https://github.com/aharada54914/md-workbench/actions/runs/34766651345)では、同じWindows runner・同じアプリSHA・同じ依存で次を確認した。

| 条件 | 結果 |
|---|---|
| Gitの既定checkout（`core.autocrlf=true`、文書4719 bytes・195 CRLF）でmath単体試験 | 再現、exit1 |
| **デモ文書1個だけ**を`git show HEAD:docs/math-showcase.md`のGit object bytes（4524 bytes・LF）に戻す | アプリコード変更なし |
| その状態で既存unit全件を再実行 | **87 files・1182成功、exit0** |

したがって、この再現例では入力文書の改行が失敗の発生条件になっている。差分はCRLF→LFだけでなく`$to_jest_kod$`の数式認識差を含み、単なる表示上の差として無視しない。`src/utils/math.ts`のfence終端認識などは次の調査対象であり、ここで全原因を修正済みとはしない。

**LF文書に差し替えた診断成功で、元のWindows baseline失敗を上書きしない。** 製品修正は[T06 / #16](https://github.com/aharada54914/md-workbench/issues/16)へ引き継ぐ。CRLF／LF／BOMの両入力と数式を含むcode fenceの不透明性を回帰試験にする。改行を全体LFへ強制してテストを緑にするだけでは、R03／R19の保持要件を満たさない。

## 4. Rust依存を再現するための保存物

上流は`src-tauri/Cargo.lock`を持たず、`.gitignore`でも明示除外していた。初回は両OSで`cargo generate-lockfile`を実行し、**同一の590 package entryのlock**を取得した。

保存先: [upstream.Cargo.lock](upstream.Cargo.lock)

- bytes: **153245**
- SHA-256: `55c44597a38aa33cbf7e1bc6e14df419cf16ac80e4efccce8986c2327b679439`
- Git blob: `7c3f93b7c484af012b5770a995fc25a24d38662e`

これは上流が公開したlockではなく、**今回の実行で解決して保存したsnapshot**である。アプリ側のCargo.lockポリシー／.gitignoreは変更しない。snapshotだけをLF固定する`.gitattributes`を追加し、他の文書のWindows改行動作を変えない。

初回runner `scripts/baseline/run.py`は依存解決を採取するため`generate-lockfile`を実行する。そのまま将来再実行すると新しい依存へ変わり得る。**今回のRust依存を再現する場合は、下記のsnapshotコピー＋`--locked`手順を使う。** OS imageやsystem package、将来のregistry可用性まで含むビット完全再現は保証しない。

## 5. 再実行手順

新しい作業ディレクトリを使い、Node22.16.0・pnpm11.3.0・Rust1.93.0・Python3.9以上を準備する。Linuxのnative依存はbaseline workflowのapt一覧、WindowsはMSVC環境を参照する。現在の作業ツリーを強制resetしない。

```sh
git clone https://github.com/aharada54914/md-workbench.git tooling
git -C tooling switch test/t01-upstream-baseline
git -C tooling worktree add --detach ../baseline c5aecc311f5295e872002309dcf72cfd96a8ad84
python tooling/scripts/generate_mdw_fixtures.py --out comparison-fixtures --large
python tooling/scripts/test_mdw_fixtures.py
cd baseline
pnpm install --frozen-lockfile
pnpm test:run
pnpm build
pnpm exec playwright install chromium
# Linuxでは、必要に応じてplaywright install --with-deps chromiumを使用する。
pnpm test:e2e --reporter=list,json
cp ../tooling/docs/md-workbench/baseline/upstream.Cargo.lock src-tauri/Cargo.lock
cargo +1.93.0 test --locked --manifest-path src-tauri/Cargo.toml
cargo +1.93.0 build --locked --manifest-path src-tauri/Cargo.toml
```

shellの設定によって失敗で後続が止まる場合は、各コマンドを個別実行し、exit codeを個別記録する。Windowsの既定改行による既知失敗を隠すためにautocrlfを変えない。LF診断は別worktreeで実施する。新規依存の解決を含む再採取には`python tooling/scripts/baseline/run.py --source baseline --out new-evidence`を使い、snapshotとのhash差を記録する。

## 6. fixtureと追加検証

[FIXTURES.md](FIXTURES.md)と[fixtures.lock.json](fixtures.lock.json)に人工11ファイルの生成方法・bytes・SHA-256を保存した。100KiB／10MiB文書、日本語・BOM・CRLF、Mermaid10図、通常PNG／SVG、外部Mermaid／2page draw.ioなどを含む。

[fixture run 34766651337](https://github.com/aharada54914/md-workbench/actions/runs/34766651337): Ubuntu／Windowsで**各10件成功**。ローカルPython3.13.5でも10件成功。これは生成器の整合性検査であり、アプリの1182件等には合算しない。GUIでの図import、全形式の往復保存、攻撃corpusはそれぞれ後続タスクの受入対象。

## 7. 証跡・保存期間

[OBSERVATIONS.json](OBSERVATIONS.json)に実行結果・各コマンドのexit status・環境・入力hashを機械可読で記録した。全文ログとPlaywright JSONは以下のActions artifactにある。fixture・sourceと顧客データを混ぜない。

| run / artifact | ID | ZIP SHA-256 |
|---|---:|---|
| baseline Ubuntu | 10321126259 | `306013002f26340ec10cf0991086dbb8375711876f072ba3260c796c3509fd51` |
| baseline Windows | 10320371909 | `b54739d72b8bd50cf20dcbb359d0c2afe71117d4d39c11916b6226df135a3d31` |
| Windows newline diagnosis | 10320004095 | `0e01a62fcab535a08423d2c6e70a61ef4e3840e586336d2c4dd3bdf0efc49de3` |

保持期間90日、取得時の有効期限は2026-12-12。artifactの可用性はGitHub設定／削除に依存する。永続的な基準としてlock・fixture生成器・hash・観測結果を本PRに保存した。元の失敗ログも成功ログも削除していない。

153245 bytesのlockをGitへ保存する一時workflowは、固定artifactのhash検証後にimmutable blobだけを作成した。refs・master・releaseには触れず、取得後はworkflow自体を削除した。恒久的な検証workflowの権限は`contents:read`。

## 8. 既知の注意点・後続タスク

- 上流release.ymlはmaster pushから公開し得る。app ID・updater・release設定の分離は[T02 / #12](https://github.com/aharada54914/md-workbench/issues/12)。本PRをmasterへmergeしない。
- Viteには500kB超のchunk警告があり、Linuxでmain bundle約7139.88kB（gzip2413.10kB）。これは配信JSサイズで、アプリの実行メモリや起動時間ではない。T03／T23で測る。
- Rust／Vueにwarning出力がある。コンパイル・テスト成功とwarningゼロを混同しない。
- macOS、Windows11実機、IME、OS関連付け、起動時間・メモリ、実AI provider、installer・署名・更新の検証は未実施。
- rollback: 本PRの追加ファイルだけを取り消す。本体source・依存manifest・上流README／LICENSE・既存workflowは無変更。

T01の成果物はレビュー待ち。Issueを閉じたり、仕様を承認済みにしたり、後続タスクまで完了と扱わない。
