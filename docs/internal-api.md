# 内部API調査メモ

調査日 2026-11-25。対象は https://m.kuku.lu/ の公開Webページに含まれるJavaScriptと、通常利用時の通信です。公開された外部向けAPI仕様書は今回の調査では見つかりませんでした。以下はWebフロントエンド用の内部エンドポイントで、互換性は保証されません。

## 共通

- ベースURLは `https://m.kuku.lu/`。
- Cookieベースのセッションを使用。観測したCookie名に `cookie_sessionhash` と `cookie_csrf_token` があります。Cookie値・トークン・メール閲覧キーはログに出力しません。
- ページのJavaScriptから `csrf_token_check` を取得。固定値にはしません。受信ページへ移動した際も取り直します。
- Ajaxリクエストには通常 `nopost=1` を付加します。
- 多くの一覧レスポンスはJSONではなく `<!-- [OK] -->` を含むHTML断片です。
- JavaScriptは実行せず、HTMLと静的なJavaScript構文木から必要な情報だけを解析します。
- 新規匿名接続で `recaptcha_createaccount.php` への遷移を要求するページを観測しました。追加認証は `sutepoi login` で利用者が対応します。

## 確認したエンドポイント

| 操作 | メソッド・パス | 主なパラメーター | 応答・補足 |
| --- | --- | --- | --- |
| アカウント画面 | GET `index.php` | — | HTML、アカウントID、CSRF、作成可能なドメイン |
| アドレス一覧 | GET `index._addrlist.php` | `page`, `csrf_token_check`, `nopost` | `[OK]` を含むHTML、`area_mailaddr_*` |
| 自動作成 | GET `index.php` | `action=addMailAddrByAuto`, `by_system=1`, `recaptcha_token`, CSRF | `OK:address` または `NG:...` |
| 指定作成 | GET `index.php` | `action=addMailAddrByManual`, `newuser`, `newdomain`, 上記共通項目 | `OK:address` または `NG:...` |
| 名前確認 | GET `index.php` | `action=checkNewMailUser`, `newuser`, `newdomain`, CSRF | Web画面が使用。CLIでは呼び出していません |
| 受信画面 | GET `recv.php` | `q`, `mailid` など | HTML、受信一覧用CSRF |
| 受信一覧 | GET `recv._ajax.php` | `page`, `q`, `mailid`, CSRF, `nopost` | `[OK]` を含むHTML、メールのID・閲覧キー・メタデータ |
| メール本文 | POST `smphone.app.recv.view.php` | `num`, `key`, `noscroll=1` | 本文HTML。Web画面はiframeへPOST |
| ログイン | GET `index.php` | `action=checkLogin`, `number`, `password`, `confirmcode`, `syncconfirm`, CSRF | 公開JavaScriptで確認。直接ログインは実装せず、ブラウザ経由で認証 |

作成操作もサイトの既存実装に従ってGETを使います。HTTPSで暗号化されますが、URLを含むデバッグログの共有は避けてください。CLIはリクエストURLをログに出しません。

## メール一覧の解析

`link_maildata_<ID>` と、クリックハンドラー内の `openMailData(ID, KEY, PARAMS)` を読み取ります。引数は文字列・数値リテラルのみ受け入れます。任意の式や関数呼び出しは実行しません。

`PARAMS` はセミコロン区切りで、`from` や `to` がURLエンコードされています。サイトの `parseValue` と同様に `#_S_#`, `#_E_#`, `#_A_#` を復元します。閲覧キーは本文取得時だけ使用し、CLIの出力には含めません。

## 検証範囲

- 実サイトの公開JavaScriptで上記操作・パラメーターを確認。
- 実サイトの匿名ブラウザセッションでアドレス一覧と空の受信箱を確認。
- HTTPS直接通信でCookie受信と追加認証画面を確認。
- ローカル模擬サーバーでCookie・CSRF・ページ送り・作成・本文POST・エラー処理を検証。
- 利用者の認証済みアカウントでの作成、受信メールがある場合の一覧・本文取得、2段階認証は未検証。

## CLIの接続方式

既定はHTTPS直接通信です。`login` はブラウザで認証し、CookieをHTTPS通信のCookie jarへエクスポートします。`--headed` を指定すると従来のブラウザ操作を使用できます。旧版からの移行時は一度 `sutepoi login` を実行してください。
