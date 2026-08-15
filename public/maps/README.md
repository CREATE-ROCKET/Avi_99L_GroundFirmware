# Offline map data

99L Ground Stationは、射点を中心とする国土地理院「全国最新写真（シームレス）」のXYZ tileをoffline cacheとして使用できる。
地図tile自体は公開repositoryへcommitしない。

## 99L default cache

射点はVaultのGNSS referenceと同じ値を使用する。

- latitude: `40.242865 deg`
- longitude: `140.010450 deg`
- area: launcher-centered `10 km x 10 km`
- zoom: `14..17`
- requested tile count: `2544`
- source: 国土地理院「全国最新写真（シームレス）」
- tile URL: `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg`

repository rootで次を実行する。

```sh
npm run map:download
```

保存先は次の通り。

```text
public/maps/gsi-seamlessphoto/
├── metadata.json
├── 14/<x>/<y>.jpg
├── 15/<x>/<y>.jpg
├── 16/<x>/<y>.jpg
└── 17/<x>/<y>.jpg
```

既存tileはskipするため、中断後も同じcommandで再開できる。通信失敗、HTTP 429、HTTP 5xx等はretryし、最終的に取得できないtileが残った場合だけnon-zeroで終了する。

「全国最新写真（シームレス）」は空中写真のない海域等ではHTTP 404を返すことがある。これはdownload失敗ではなく`unavailable`として扱い、`.jpg.unavailable` markerを保存して次回実行時の無駄な再requestを避ける。再確認したい場合だけ`--refresh-unavailable`を指定する。

```sh
node scripts/download-offline-map.mjs --refresh-unavailable
```

serverへ過剰な負荷を与えないよう、default concurrencyは4に制限している。

`vite.config.js`の`publicDir`により、developmentではこのdirectoryをそのまま配信し、`npm run build:renderer`では`dist/renderer/maps/gsi-seamlessphoto/`へcopyする。

Rendererは以下の方針で表示する。

- Launcher `(0, 0)` と最新のvalid GNSS位置だけが入る最小範囲へfitする。過去の最遠点はzoom決定へ使わない。
- fitは画面aspect ratioを考慮するため、横長mapで不要にzoom outしない。
- 新しいGNSS位置でcenter/scaleが変わる場合は短時間補間し、表示jumpを抑える。
- 写真が存在しないtileは標準地図へ差し替えない。周辺の取得済み写真から平均色を求め、**色だけ**を補間して背景を埋める。
- 色補間部は実写真ではないため、画面に`PHOTO GAP FILL ... / COLOR ONLY`と明示する。
- telemetry更新で画面DOMが再生成されてもmap/3D/chartのCanvas hostを保持し、detach/reattachによるフリッカーを防ぐ。

任意の範囲を取得する場合は次のように指定できる。

```sh
node scripts/download-offline-map.mjs --size-km 10 --min-zoom 14 --max-zoom 17 --concurrency 4
```

## 利用条件

地理院タイルは国土地理院コンテンツ利用規約に従って利用する。Ground Stationのmap表示には`出典: 国土地理院`を表示する。
「全国最新写真（シームレス）」には撮影元が異なる画像が含まれるため、配布時には国土地理院の最新の地理院タイル一覧と個別の出所条件も確認すること。
