# Offline map data

99L Ground Stationは、射点を中心とする国土地理院「全国最新写真（シームレス）」のXYZ tileをoffline cacheとして使用できる。
地図tile自体は公開repositoryへcommitしない。

## 99L default cache

射点はVaultのGNSS referenceと同じ値を使用する。

- latitude: `40.242865 deg`
- longitude: `140.010450 deg`
- area: launcher-centered `10 km x 10 km`
- zoom: `14..17`
- tile count: `2544`
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

既存tileはskipするため、中断後も同じcommandで再開できる。通信失敗はretryし、最終的に欠落tileが残った場合はnon-zeroで終了する。
serverへ過剰な負荷を与えないよう、default concurrencyは4に制限している。

`vite.config.js`の`publicDir`により、developmentではこのdirectoryをそのまま配信し、`npm run build:renderer`では`dist/renderer/maps/gsi-seamlessphoto/`へcopyする。
Rendererはこのlocal XYZ cacheを自動使用し、表示範囲に応じてz14..z17を動的に選択する。tileが存在しない範囲では従来のENU gridを維持し、`MAP TILE MISSING`を表示する。

任意の範囲を取得する場合は次のように指定できる。

```sh
node scripts/download-offline-map.mjs --size-km 10 --min-zoom 14 --max-zoom 17 --concurrency 4
```

## 利用条件

地理院タイルは国土地理院コンテンツ利用規約に従って利用する。Ground Stationのmap表示には`出典: 国土地理院`を表示する。
「全国最新写真（シームレス）」には撮影元が異なる画像が含まれるため、配布時には国土地理院の最新の地理院タイル一覧と個別の出所条件も確認すること。
