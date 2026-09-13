# 上流実装・fork監査 v0.2

調査日: 2026-09-13。対象は固定SHA `c5aecc311f5295e872002309dcf72cfd96a8ad84`、version 0.7.3、既定branch master。
コードと設定を読んだ監査であり、ビルド・GUI操作・脆弱性実証・性能測定ではない。

## 確認結果

| ID | 確認した根拠 | 現状と対応 |
|---|---|---|
| A01 | [package.json](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/package.json) | Vue／Tiptap／CodeMirror／Mermaid／Tauri、test:runとtest:e2eを定義。KEEP候補。dependency定義を動作保証としない |
| A02 | [tauri.conf.json](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/src-tauri/tauri.conf.json) | .md関連付け定義あり、csp:null、上流identifier／updater URL／公開鍵／deep-link。T02とT04でMODIFY |
| A03 | [capabilities/default.json](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/src-tauri/capabilities/default.json) | read／write／remove等のfs scopeに**を許可。previewの権限分離とbackend認可を要検証 |
| A04 | [ai/types.rs](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/src-tauri/src/ai/types.rs) | file_readとfile_writeが既定true。今回のAsk既定と異なる。T19／T20でMODIFY |
| A05 | [ai/process/codex.rs](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/src-tauri/src/ai/process/codex.rs) | exec --json、書込有効時workspace-write、resume経路、画像時の新session、bypass分岐。安全な原本保護を別途検証 |
| A06 | [release.yml](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/.github/workflows/release.yml) | master pushからreleaseを生成し得る。Markdownはpaths-ignore対象。T02で配布条件を分離する |
| A07 | [MermaidNode.vue](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/src/components/MermaidNode.vue) | diagram単位のAI target／candidate反映を持つ。KEEP接点だがGUI構造編集はNEW扱い |
| A08 | [imageImport.ts](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/src/services/imageImport.ts) | 画像取込の既存接点。全形式の双方向変換と同一機能だと扱わない |
| A09 | [LICENSE](https://github.com/aharada54914/md-workbench/blob/c5aecc311f5295e872002309dcf72cfd96a8ad84/LICENSE) | 本体MIT。元copyright／noticeを保持。新規組込部品のlicenseは別確認 |

A07〜A09は前段の同じupstream基準ソース確認と固定SHA参照を引き継ぐ。A01〜A06は今回fork上でも再取得した。全srcファイルを分類した監査ではない。

## KEEP / MODIFY / NEWの境界

KEEP候補: Tauri shell、Vue UI、TiptapとCodeMirror、Mermaid描画、AI UI、snapshot、既存試験。
MODIFY: AI原本write、session policy、保存経路、CSP／fs scopes、updater／identity／release trigger、lazy loading。
NEW: Resource parser／format、CAS＋journal、Visimer adapter、draw.io隔離provider、render context、要件対応テストとbenchmark。
DELETE: 現段階では確定しない。余分に見える機能を試験前に削って上流との互換性を壊さない。

## 採用部品の根拠と検証限界

[Visimer](https://github.com/inkeep/visimer)はMermaidの視覚編集部品、core／domの分離を提供するとREADMEで説明する。採用version、Vue統合、未知構文保持、日本語入力はT13で実証する。

[draw.io embed](https://www.drawio.com/docs/reference/embed-mode/)はpostMessageによる編集・XML受渡しとxmlpng／xmlsvg等の形式を説明する。hosted embedの仕様確認は同梱offline実装の保証ではない。T16でlicense・asset・origin・CSPを検証する。

[Codex app-server](https://developers.openai.com/codex/app-server/)は認証・履歴・approval・streaming client統合の候補。現行forkのexec実装とは別経路であり、対応protocol／CLI版をT19で検証する。

[Tauri CSP](https://v2.tauri.app/security/csp/)と[Capabilities](https://v2.tauri.app/security/capabilities/)を安全境界の参考にする。UI側scopeだけでRust commandの認可が自動で成立するわけではない。

## この作業でしていないこと

デスクトップ実行、依存install、unit／E2E／Rust test実行、性能比較、全依存の脆弱性scan、OS署名確認は未実施。今回の検証はGitHub接続で取得したコード・設定の確認と、仕様／バックログの整合性検査である。したがって「起動1秒」「全テスト成功」「全4要件実装済み」とは報告しない。
