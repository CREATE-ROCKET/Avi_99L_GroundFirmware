# Offline map data

このdirectoryへ配布時のoffline mapを置けるが、公開repositoryへ地図tileを直接commitしない。

推奨構成:

```text
public/maps/
├── README.md
└── local-map.example.json
```

実mapは利用者がアプリの`LOAD OFFLINE MAP`から選択するか、release artifact生成時に利用条件を確認したものだけを同梱する。

国土地理院データを使用する場合は、対象layerの利用条件、出典、加工表示を確認し、画面と配布物にattributionを含める。
