# Issue対応表 — MD Workbench v0.2

登録日: 2026-09-13 / 登録先: `aharada54914/md-workbench`
登録元仕様commit: `4d6a9bd60987f7a7051db9796464f2dfde90a7d9`

**tracking 1件＋Epic 8件＋実装task 24件＝33件を登録済み。** 作成時は全てopen。進捗の最新状態は各GitHub Issueを正とする。Issue作成は仕様承認・機能実装・テスト成功ではない。

[全体管理 #2](https://github.com/aharada54914/md-workbench/issues/2) / [仕様レビューPR #1](https://github.com/aharada54914/md-workbench/pull/1) / [実装計画](IMPLEMENTATION_PLAN.md) / [登録元データ](ISSUE_BACKLOG.md)

## Tracking・Epic

| 計画ID | Issue | 内容 | 親 | 子task |
|---|---|---|---|---|
| PLAN | [#2](https://github.com/aharada54914/md-workbench/issues/2) | v1の仕様と受入ゲート | — | E0〜E7 |
| E0 | [#3](https://github.com/aharada54914/md-workbench/issues/3) | 基盤検証・fork分離・性能ベースライン | PLAN | T01〜T03 |
| E1 | [#4](https://github.com/aharada54914/md-workbench/issues/4) | 安全な閲覧・ファイル起点UX・日本語編集 | PLAN | T04〜T06 |
| E2 | [#5](https://github.com/aharada54914/md-workbench/issues/5) | Resource共通層・永続化・操作UI | PLAN | T07〜T09 |
| E3 | [#6](https://github.com/aharada54914/md-workbench/issues/6) | 画像・図ソースの内蔵／外部変換 | PLAN | T10〜T12 |
| E4 | [#7](https://github.com/aharada54914/md-workbench/issues/7) | Mermaid GUI編集 | PLAN | T13〜T15 |
| E5 | [#8](https://github.com/aharada54914/md-workbench/issues/8) | draw.io GUI・編集可能PNG／SVG | PLAN | T16〜T18 |
| E6 | [#9](https://github.com/aharada54914/md-workbench/issues/9) | AIへの質問・承認付き修正・描画結果の共有 | PLAN | T19〜T21 |
| E7 | [#10](https://github.com/aharada54914/md-workbench/issues/10) | 統合検証・軽量化・配布ゲート | PLAN | T22〜T24 |

## 実装task・依存関係

先行Issueは受入完了後に着手する条件。親Epicは集約関係であり着手依存ではない。

| 計画ID | Issue | 実装内容 | 親Epic | 先行Issue |
|---|---|---|---|---|
| T01 | [#11](https://github.com/aharada54914/md-workbench/issues/11) | 上流固定・依存環境・既存テストのベースライン | E0 / #3 | なし |
| T02 | [#12](https://github.com/aharada54914/md-workbench/issues/12) | アプリID・更新先・release workflowをfork用に分離 | E0 / #3 | #11 |
| T03 | [#13](https://github.com/aharada54914/md-workbench/issues/13) | 起動・メモリの比較測定ハーネス | E0 / #3 | #11 |
| T04 | [#14](https://github.com/aharada54914/md-workbench/issues/14) | CSP・HTML／SVG描画・IPC権限の安全境界 | E1 / #4 | #11 |
| T05 | [#15](https://github.com/aharada54914/md-workbench/issues/15) | OS関連付け・ファイル起動・パス許可 | E1 / #4 | #12, #14 |
| T06 | [#16](https://github.com/aharada54914/md-workbench/issues/16) | 閲覧・Source・Visual・Splitと日本語round-trip | E1 / #4 | #15 |
| T07 | [#17](https://github.com/aharada54914/md-workbench/issues/17) | Resource形式・parser・revisionモデルの契約 | E2 / #5 | #11 |
| T08 | [#18](https://github.com/aharada54914/md-workbench/issues/18) | journal付き保存・CAS・snapshot・障害回復 | E2 / #5 | #14, #15, #17 |
| T09 | [#19](https://github.com/aharada54914/md-workbench/issues/19) | Resource toolbar・provider registry・遅延ロード | E2 / #5 | #16, #17 |
| T10 | [#20](https://github.com/aharada54914/md-workbench/issues/20) | PNG／SVGのdata URIと外部ファイルの双方向変換 | E3 / #6 | #18, #19 |
| T11 | [#21](https://github.com/aharada54914/md-workbench/issues/21) | draw.io metadata検出と安全な画像プレビュー | E3 / #6 | #14, #20 |
| T12 | [#22](https://github.com/aharada54914/md-workbench/issues/22) | Mermaid／draw.ioソースの外部化・再内蔵 | E3 / #6 | #18, #19 |
| T13 | [#23](https://github.com/aharada54914/md-workbench/issues/23) | Visimer互換性・license・編集能力のspike | E4 / #7 | #11, #14 |
| T14 | [#24](https://github.com/aharada54914/md-workbench/issues/24) | Mermaid GUI編集providerを統合 | E4 / #7 | #19, #23 |
| T15 | [#25](https://github.com/aharada54914/md-workbench/issues/25) | Mermaidの保存モード・Undo・AI候補の同期 | E4 / #7 | #18, #22, #24 |
| T16 | [#26](https://github.com/aharada54914/md-workbench/issues/26) | draw.ioの同梱・隔離・embed protocol spike | E5 / #8 | #12, #14 |
| T17 | [#27](https://github.com/aharada54914/md-workbench/issues/27) | draw.io GUIとXML保存を統合 | E5 / #8 | #18, #19, #22, #26 |
| T18 | [#28](https://github.com/aharada54914/md-workbench/issues/28) | 編集データ付きPNG／SVG出力と再編集 | E5 / #8 | #21, #27 |
| T19 | [#29](https://github.com/aharada54914/md-workbench/issues/29) | AI provider・権限・sessionの契約検証 | E6 / #9 | #11, #14 |
| T20 | [#30](https://github.com/aharada54914/md-workbench/issues/30) | Ask／Propose／Review／Applyをホスト制御にする | E6 / #9 | #18, #29 |
| T21 | [#31](https://github.com/aharada54914/md-workbench/issues/31) | 図source・描画結果のAI添付と履歴 | E6 / #9 | #19, #24, #27, #30 |
| T22 | [#32](https://github.com/aharada54914/md-workbench/issues/32) | 統合E2E・障害注入・security回帰をCIへ追加 | E7 / #10 | #16, #20, #21, #22, #25, #28, #31 |
| T23 | [#33](https://github.com/aharada54914/md-workbench/issues/33) | 性能最適化・比較再測定・目標判定 | E7 / #10 | #13, #32 |
| T24 | [#34](https://github.com/aharada54914/md-workbench/issues/34) | installer・署名・SBOM・更新・release受入 | E7 / #10 | #12, #33 |

Markdownファイル内の裸の`#番号`がリンクにならないviewerでは、同じ行のIssueまたは上表の対応Issueを開く。各Issue本文では親・依存先をGitHubリンクとして参照できる。

## 最初の着手

まずT01 / #11。その受入後、T02 / #12、T03 / #13、T04 / #14、T07 / #17を独立範囲で進める。
**T02 / #12完了前に実装コードをmasterへマージしない。** 仕様PRのDraftは維持し、実装開始・merge・tag・releaseを実行済みとはしない。

## 登録の検証と運用

- 登録前の一覧ではPR #1のみで、対象markerを持つ既存Issueはなかった。
- 全33件の作成レスポンスで実番号とopen状態を確認した。
- 登録後にGitHub検索で本文markerを再取得し、PLAN・E0〜E7・T01〜T24が各1件、#2〜#34に対応することを照合した。
- 8 Epicの子taskチェックリスト、24taskの親・先行リンクを更新・照合した。親子関係は32本、task依存は52本。
- ローカルの決定論的検査で、対応番号の一意性、24taskの依存参照・循環なし、R01〜R20の割当、初期着手可能taskがT01のみであることを確認した。
- これは登録・計画データの検証であり、アプリbuild／unit／Rust／E2E／実機性能試験ではない。

**native sub-issues／Dependencies、Projects、Milestonesは作成していない。** 親子・依存は本文リンクとチェックリストによる管理。priorityは本文P0、担当者・期日・labelは未指定。再実行時は`<!-- mdw-plan:ID -->`で照合し、この対応表を参照して二重登録しない。
