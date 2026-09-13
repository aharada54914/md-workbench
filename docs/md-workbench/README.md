# 仕様セット v0.2

更新日: 2026-09-13 / 状態: **レビュー用ドラフト**
対象: `aharada54914/md-workbench` / 既定ブランチ: `master`
基準SHA: `c5aecc311f5295e872002309dcf72cfd96a8ad84`

## 読む順番と文書の責務

| 文書 | 責務 |
|---|---|
| [PRODUCT_SPEC](PRODUCT_SPEC.md) | 何を実現するか、20要件、利用者に見える振る舞い |
| [UPSTREAM_AUDIT](UPSTREAM_AUDIT.md) | 現在ある実装・設定・不足を、固定SHAで区別 |
| [ARCHITECTURE](ARCHITECTURE.md) | 基本設計、責務分離、状態遷移、既存コードの再利用 |
| [RESOURCE_FORMAT](RESOURCE_FORMAT.md) | 詳細設計案、保存記法、往復変換、障害回復の契約 |
| [SECURITY](SECURITY.md) | 脅威、権限、描画とAIの安全境界 |
| [TEST_PLAN](TEST_PLAN.md) | 受入試験、性能測定、証跡、品質ゲート |
| [DECISIONS](DECISIONS.md) | 設計判断と未決事項。提案を利用者承認済みとしない |
| [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) | 8 Epic・24タスク・依存関係・実装順 |
| [ISSUE_BACKLOG](ISSUE_BACKLOG.md) | GitHubへの33件の登録データと重複防止手順 |

製品要件をPRODUCT_SPEC、永続形式をRESOURCE_FORMAT、判断履歴をDECISIONSで管理する。Issueは実行状況の正本であり、仕様を勝手に別定義しない。矛盾時は修正PRで合意し、コードの偶然の挙動を仕様へ昇格させない。

## v0.1から修正した点

旧チャット内の英語ドラフトは参考扱いとし、v0.2でレビューを行う。

1. 外部図を見えないHTMLコメントだけで参照する案を、**通常Markdownリンク＋小さなmetadata**へ変更した。
2. 2ファイルを単純にatomic saveできるとはしない。journalと中断後の回復、残った資産の扱いを定義した。
3. 既存AIの直接writeと、今回必要な承認後適用を区別した。
4. Securityを後半工程から基盤ゲートへ移した。
5. fork元のupdater URL・アプリID・自動releaseを初期の分離対象に追加した。
6. Windows優先・性能値・Visimer採用・外部記法を提案として明示した。未測定の軽さを断言しない。

## 現状

仕様と計画の作成であり、新機能は未実装。ビルド・Windows/macOS実機試験・性能測定は未実施。Issue作成APIは`Issues has been disabled in this repository`（HTTP 410）で拒否されたため、GitHubへの実登録は未完了。登録対象はtracking 1件、Epic 8件、task 24件。
