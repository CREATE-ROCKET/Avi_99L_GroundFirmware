# Avi 99L Ground Firmware

99L向けのWindows/Linux Ground Station prototypeです。`CREATE-ROCKET/Avi_tenkatenn_board`のUSB line protocolと、Vaultで定義した99L LoRa application packetを入力として扱います。

本projectはまず、デザイン確定より先に以下を検証することを目的とします。

- `rocket_fin_test.glb`の姿勢・動翼表示
- 2 Hz telemetryを追加500 ms遅延なしで滑らかに表示するcausal prediction
- 打上げ後0〜15 s固定graph
- application起動後からのsystem history graph
- 全packet / 全field / raw bytesの表示
- USB Serialの手動port選択
- packetごとの即時保存と`fsync`
- RendererのF5再読込中もUSB受信・保存を継続
- 完全offline map画像の読込み
- 離床時の枠flash + 単音2回

## 画面構成

Full HD 1920×1080を基準にしています。最小windowは1440×810です。

- **01 ATTITUDE / 3D**
  - shadow無効
  - multi-direction fill light
  - orthographic camera
  - oblique-front default view
  - vehicle bounding sphereを原点へ再配置して、どの姿勢でも画面外へ出にくい構造
  - `COPY VIEW`でcamera position / quaternion / target / zoomをJSONとして取得
  - `PREDICT`と`RAW / HOLD`を切替
- **02 FLIGHT / BIRD'S-EYE MAP**
  - Launcher-relative East/North
  - 全raw GNSS点を保存・描画
  - 1 s以上のgapを跨いで線を接続しない
  - local offline image読込み
- **03 TELEMETRY / ALL VALUES**
  - overview
  - 全known field一覧
  - raw packet monitor
- **04 FLIGHT DYNAMICS / FIXED 0–15 s**
  - 全trackが同一x軸
  - roll / tilt
  - roll rate / fin rate
  - fin angle
  - requested torque
  - airspeed
  - absolute height
  - static pressure
  - 各track内に最新値badge
- **05 SYSTEM HISTORY / ALL RUN TIME**
  - logic/motor voltage
  - RSSI
  - pressure/temperature
  - application起動後からの全期間
  - source packetが途絶えた区間は線を接続しない
- **EVENT / COMMAND CONSOLE**
  - state transition、invalid packet、USB event
  - line-based command送信

全known packet fieldは`ALL VALUES`へ表示され、全application bytesは`RAW PACKETS`とdisk logへ保存されます。

## 3D姿勢表示

World座標は次です。

```text
+X = East
+Y = Up
-Z = North
```

telemetryの`tilt magnitude`、`tilt direction`、`roll`から表示Quaternionを作ります。

`PREDICT` modeでは未来packetを待ちません。

- roll: telemetryのroll rateで最大500 msだけ予測
- tilt/direction:直近2 packetからrateを推定
- 新packetとの誤差:約85 msの短いSLERP correction
- last periodic RX age >= 1.0 s:予測を停止し、最後の姿勢でfreezeしてgray表示

表示補正値は保存しません。diskへ保存するのは受信raw packetとdecoded sampleです。

## GLB camera viewの固定方法

画面上でcameraを調整して`COPY VIEW`を押すと、次のJSONがclipboardへ入ります。

```json
{
  "schema": 1,
  "camera": {
    "projection": "orthographic",
    "position": [0, 0, 0],
    "quaternion": [0, 0, 0, 1],
    "up": [0, 1, 0],
    "zoom": 1
  },
  "target": [0, 0, 0],
  "model": {
    "center": [0, 0, 0],
    "radius": 1,
    "display_frame_quaternion": [0, 0, 0, 1]
  }
}
```

production UIでcamera操作を固定する際、このJSONをdefault camera configへ移します。

## USB input

Vaultの`CREATE/99L Ground Station/00_USBシリアル通信仕様.md`に従い、machine-readableな`@` recordをparseします。

```text
@RX usb_v=1 seq=124 board_ms=183245 dt_ms=501 rssi_present=1 rssi_raw=172 rssi_dbm=-84 valid=1 header=0xA3 len=24 error=NONE raw=A3...
```

`#`で始まるpretty-printはGUI protocolとしてparseしません。unknown/unparseable lineもdisk上のraw logからは失いません。

## 保存

application起動ごとに新しいsession directoryを作ります。

Windows例:

```text
Documents\CREATE 99L Ground Station\logs\2026-08-13T12-34-56-789Z\
```

内容:

```text
session.json
usb-lines.log
records.jsonl
ground-station.jsonl
```

USB RX/TX、decoded record、USB eventを即時appendし、各recordで`fsync`します。RendererのF5ではElectron Main processとsession fileは継続します。

## 開発起動

Windows PowerShell:

```powershell
npm install
npm run dev
```

Linux:

```bash
npm install
npm run dev
```

2回目以降とCIでは、commit済みlockfileを使って`npm ci`を実行してください。

Linuxでserial portへアクセスできない場合は、対象distributionの`dialout`等のgroupまたはudev ruleを設定してください。アプリはportを自動選択せず、ユーザーが選択します。

## build

Windows portable executable:

```powershell
npm run build:win
```

Linux AppImage:

```bash
npm run build:linux
```

生成binaryはElectron/Node/Three.js/SerialPortを同梱します。利用者PCへNode.jsやnpmを要求しません。

GitHub Actionsの`Build desktop artifacts`はpush、pull request、手動実行でtest後にWindows portable `.exe`とLinux AppImageをartifactとして出力します。

## protocol smoke test

```bash
npm test
```

既知9 packet typeについて、length、XOR、decoder、USB `@RX` parsingを確認します。

## Synthetic mode

Serial hardwareがなくても`SYNTHETIC`で以下を確認できます。

- CommandReceive
- LiftoffDetection
- EngineBurn
- Control
- Descent
- 3D姿勢とfin
- graph
- map
- liftoff flash / double beep

F9でも離床alertを手動試験できます。

## 現時点の制約

- `requested torque` scaleはVault上でsimulation確定待ちのため、decoderでは`TEMPORARY_SCALE`と明示します。
- 実機上のfin正方向とGLB正方向の対応は後で符号確認が必要です。
- voltageは、それを含むpacketが届いた時点だけsampleを追加します。Flight packetに電圧が含まれない区間を補間・捏造しません。
- A7 ComBoardFallbackはheaderだけ予約しており、正式field layoutが固定されるまでraw packet表示のみです。
- offline map画像のpixelとENU座標の厳密なgeoreference metadataは今後追加します。現prototypeは画像をpanel背景として読込みます。
- current `CommandReceive` packingはVaultの22 byte v1を前提にしています。変更時はgolden vectorとdecoderを同時更新してください。
