# sutepoi-cli

[捨てメアド（メルアドぽいぽい）](https://m.kuku.lu/)をターミナルから利用する非公式CLIです。アドレス作成、受信メールの一覧・本文表示、新着待機に対応します。

Node.js 22以上が必要です。通常コマンドはNode.jsの `fetch` でHTTPS接続します。初回ログイン・追加認証にはPlaywrightの専用Chromiumを使用します。

## インストール

このリポジトリからインストールします。npmレジストリには未公開です。

```sh
npm ci
npm run build
npm install -g .
sutepoi setup
sutepoi login
```

LinuxでChromiumのシステムライブラリが不足している場合は、Playwright公式の[システム要件と依存関係](https://playwright.dev/docs/browsers#install-system-dependencies)を参照してください。

`login` はブラウザを開きます。既存アカウントでログインするか、新規利用を開始し、ターミナルでEnterを押してください。追加認証や利用規約への同意はブラウザで行います。初回のアドレス作成もブラウザで行い、規約を確認してください。CLIは利用規約に自動同意しません。

ログイン完了後、CookieをHTTPS通信用に保存します。旧版から更新した場合も、一度 `sutepoi login` を実行してください。

通常のブラウザとは別のプロファイルを使うため、既存ブラウザのログイン状態は引き継ぎません。新規利用時、サイトが自動的にアカウントや初期アドレスを作る場合があります。

## コマンド

```sh
sutepoi status
sutepoi addresses list
sutepoi addresses create
sutepoi addresses create --name my-name --domain example.com
sutepoi mail list --limit 20
sutepoi mail list --address your-address@example.com
sutepoi mail read 123456789
sutepoi mail watch --interval 30 --timeout 300
sutepoi --json mail list
sutepoi --headed addresses list
sutepoi --help
```

指定作成では `--name` と `--domain` の両方が必要です。例の `example.com` は実際にサイトが提供するドメインへ置き換えてください。サイト側の利用可否や作成制限に従います。

`mail read` に渡すIDは `mail list` に表示されるサイト上のメールIDです。本文を開くと、サイト側で既読になる場合があります。本文はプレーンテキストで出力し、添付ファイルの取得・メール送信・削除は扱いません。

`watch` は起動時に存在するメールを通知せず、以降に見つかったメールをIDで重複排除して表示します。間隔は既定30秒、最短10秒です。タイムアウトを省略するとCtrl+Cまで待機します。ページをまたいで一覧を取得するため、多数のメールがある場合、実際の通知間隔は取得時間の分だけ長くなります。1回の取得は最大1,000ページです。

## 出力

人向けの一覧はタブ区切りです。空の一覧では何も表示しません。

`--json` は一覧を配列、単件をオブジェクトで出力します。`watch` は新着メール1件につき1行のJSONを出力します。エラーとインストール進捗は標準エラーへ出力します。端末制御文字と双方向表示の制御文字を除去します。

アドレスの形式

```json
{"address":"your-address@example.com"}
```

メール一覧の形式（日時はサイトの表示値）

```json
{"id":"123456789","from":"sender@example.com","to":"your-address@example.com","subject":"件名","receivedAt":"2026-11-25 12:00"}
```

本文取得では `body` を追加します。`status` は `saved` と `connected`、`login` は `authenticated`、`setup` は `installed` を返します。

JSONエラーの形式

```json
{"error":{"code":"AUTH","message":"sutepoi loginを実行してください。"}}
```

| 終了コード | 意味 |
| --- | --- |
| 0 | 正常終了・待機タイムアウト |
| 1 | 通信・ブラウザ・サイト操作エラー |
| 2 | 引数・対話端末のエラー |
| 3 | ログイン・利用規約の確認が必要 |
| 4 | メールが見つからない |
| 130 / 143 | SIGINT / SIGTERMで終了 |

## セッション

専用ブラウザのプロファイルとHTTPS通信用Cookie（`http-cookies.json`）を次の設定ディレクトリに保存します。

- macOS `~/Library/Preferences/sutepoi/`
- Linux `${XDG_CONFIG_HOME:-~/.config}/sutepoi/`
- Windows `%APPDATA%\sutepoi\Config\`

POSIX環境では親ディレクトリを所有者のみアクセス可能にします。ブラウザプロファイルはアカウントへのアクセス権を含むため、共有やGitへの追加を避けてください。パスワードの別保存や画面全体のログ出力は行いません。

同じプロファイルの同時実行はできません。別コマンドを使う前に `watch` を終了してください。異常終了後のロックは期限経過後に回復します。認証が切れたり、アカウントが変わった場合は `sutepoi login` で再設定してください。

アドレス作成で通信が途切れた場合は自動再試行しません。`sutepoi addresses list` で作成済みか確認してください。

## 開発と検証範囲

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm pack --dry-run
```

テストはローカルHTTPサーバーと実際のChromiumを使い、公開サイトへのアクセスやメール送信を行いません。既定のHTTPS通信は `HttpTransport` と `HttpSite`、ブラウザ操作は `Site`、保存とロックはセッション層に分離しています。TLS証明書は通常どおり検証し、異なるオリジンへの転送は拒否します。

模擬サーバーでHTTPS通信層のCookie更新・CSRF・本文POST・転送拒否と、ページ送り、アドレス作成、メール本文取得、作成拒否、画面変更、セッション照合、排他制御、新着の重複排除・終了を検証しています。実サイトでは匿名セッションのアドレス一覧と空の受信箱を確認しました。利用者のログイン済みアカウントでの作成・受信メール解析・追加認証は未検証です。

通常コマンドはWeb画面の内部エンドポイントへHTTPSで直接接続します。調査したパスとパラメーターは [内部API調査メモ](docs/internal-api.md) に記載しています。公開APIではないため、サイトの変更で動かなくなる場合があります。`--headed` でブラウザ方式に切り替えて確認できます。サイトの認証や制限を回避する機能はありません。

## ライセンス

MIT
