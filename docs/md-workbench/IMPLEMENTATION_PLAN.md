# 実装計画 v0.2

GitHub Issue実番号はまだない。以下のPLAN／E0〜E7／T01〜T24は**計画ID**でありIssue番号ではない。
tracking 1件＋Epic 8件＋実装task 24件＝33件。各taskのscopeと受入条件は[ISSUE_BACKLOG](ISSUE_BACKLOG.md)にある。

## Epic

| ID | 目的 | 子task |
|---|---|---|
| E0 | 基盤検証・fork分離・性能ベースライン | T01, T02, T03 |
| E1 | 安全な閲覧・ファイル起点UX・日本語編集 | T04, T05, T06 |
| E2 | Resource共通層・永続化・操作UI | T07, T08, T09 |
| E3 | 画像・図ソースの内蔵／外部変換 | T10, T11, T12 |
| E4 | Mermaid GUI編集 | T13, T14, T15 |
| E5 | draw.io GUI・編集可能PNG／SVG | T16, T17, T18 |
| E6 | AIへの質問・承認付き修正・描画結果の共有 | T19, T20, T21 |
| E7 | 統合検証・軽量化・配布ゲート | T22, T23, T24 |

## 依存関係と要件対応

`depends_on`は着手前に受入完了を必要とするtask。Epic親子は集約関係であって依存edgeではない。

| Task | Epic | 実装内容 | 先行task | 要件 |
|---|---|---|---|---|
| T01 | E0 | 上流固定・依存環境・既存テストのベースライン | なし | R03, R18 |
| T02 | E0 | アプリID・更新先・release workflowをfork用に分離 | T01 | R18 |
| T03 | E0 | 起動・メモリの比較測定ハーネス | T01 | R16, R17 |
| T04 | E1 | CSP・HTML／SVG描画・IPC権限の安全境界 | T01 | R11, R12 |
| T05 | E1 | OS関連付け・ファイル起動・パス許可を実装 | T02, T04 | R01, R12, R20 |
| T06 | E1 | 閲覧・Source・Visual・Splitと日本語round-trip | T05 | R02, R03, R19 |
| T07 | E2 | Resource形式・parser・revisionモデルの契約 | T01 | R07, R08, R09, R19 |
| T08 | E2 | journal付き保存・CAS・snapshot・障害回復 | T04, T05, T07 | R10, R20 |
| T09 | E2 | Resource toolbar・provider registry・遅延ロード | T06, T07 | R02, R04, R16 |
| T10 | E3 | PNG／SVGのdata URIと外部ファイルの双方向変換 | T08, T09 | R04, R07, R10 |
| T11 | E3 | draw.io metadata検出と安全な画像プレビュー | T04, T10 | R04, R11 |
| T12 | E3 | Mermaid／draw.ioソースの外部化・再内蔵 | T08, T09 | R08, R09, R19 |
| T13 | E4 | Visimer互換性・license・編集能力のspike | T01, T04 | R05, R19 |
| T14 | E4 | Mermaid GUI編集providerを統合 | T09, T13 | R05 |
| T15 | E4 | Mermaidの保存モード・Undo・AI候補の同期 | T08, T12, T14 | R05, R08, R20 |
| T16 | E5 | draw.ioの同梱・隔離・embed protocol spike | T02, T04 | R06, R11, R16, R18 |
| T17 | E5 | draw.io GUIとXML保存を統合 | T08, T09, T12, T16 | R06, R09, R10 |
| T18 | E5 | 編集データ付きPNG／SVG出力と再編集 | T11, T17 | R04, R06, R07 |
| T19 | E6 | AI provider・権限・sessionの契約検証 | T01, T04 | R13, R14, R16 |
| T20 | E6 | Ask／Propose／Review／Applyをホスト制御にする | T08, T19 | R13, R14, R20 |
| T21 | E6 | 図source・描画結果のAI添付と履歴 | T09, T14, T17, T20 | R13, R14, R15 |
| T22 | E7 | 統合E2E・障害注入・security回帰をCIへ追加 | T06, T10, T11, T12, T15, T18, T21 | R01, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, R19, R20 |
| T23 | E7 | 性能最適化・比較再測定・目標判定 | T03, T22 | R16, R17 |
| T24 | E7 | installer・署名・SBOM・更新・release受入 | T02, T23 | R01, R18 |

## 着手順

最初はT01。次にT02／T03／T04／T07を独立範囲で進める。T13／T19はT01＋T04後、T16はT02＋T04後に進められる。正確な先行条件は上表を正とする。

安全なファイル起動T05→編集T06と、resource T07→transaction T08を先に成立させる。T09以降、画像／ソース変換、Mermaid、draw.io、AIを並行化できる。同じdocument保存moduleを複数PRで競合させない。

最後はT22の統合受入→T23の性能実測→T24の配布ゲート。SecurityはT04から継続し、T22で初めて考えるものではない。

## PR単位

原則1 taskにつき1 review可能PR。spikeは証跡・ADR・小さな検証コードまでとし、無断で本番依存を増やさない。T08／T16／T19など大きいtaskは先に契約と負例を確定し、implementation PRを分割して親taskに記録する。

各PRにR番号、task ID、テスト結果、未実機項目、互換性、rollbackを必須記載。上流動作を変更するものと新機能を分ける。mergeとreleaseは別承認にする。

**T02完了前に実装codeをmasterへmergeしない。** 現行release workflowとupdaterが上流設定を引き継ぐため、先に誤更新・誤配布を防ぐ。

## 承認ゲート

G0: T01〜T04とOS／測定条件の合意。
G1: T07／T08、ADR-0002（保存形式）承認。
G2: T10〜T18の対応scope・往復保持・GUI受入。
G3: T19〜T21の原本不変・policy・render証跡。
G4: T22〜T24と未決事項解消。利用者承認なしのバイナリ公開をしない。

## バックログ検証

ローカルで33レコードのID一意性、8 Epic／24task、親子参照、dependency参照、依存graphの循環なし、20要件全てのtask割当、各レコードの3件以上の受入条件を検証した。

12 Markdownファイルの内部リンクとcode fenceの閉じ忘れも検査し、問題なし。アップロード後、仕様ディレクトリ10ファイルのGit blob SHAをローカル検証対象と照合した。PR #1の変更一覧が12 Markdownファイルの追加のみであることも確認した。

これは**仕様・計画データの検証**で、アプリのCI・機能テスト成功ではない。

## GitHub登録状態

HTTP 410: Issues disabled。33件は登録準備済み・実登録未完了。設定変更後、ISSUE_BACKLOGの安定markerで重複を避けて作成し、実番号を本書に追記する。GitHub Projects／Milestoneやnative sub-issueが作成済みとは報告しない。
