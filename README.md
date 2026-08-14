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
@RX usb_v=1 seq=9 board_ms=5000 dt_ms=500 rssi_present=1 rssi_raw=172 rssi_dbm=-84 valid=1 header=0xB1 len=3 error=NONE raw=B107B6
@TX usb_v=1 board_ms=6500 ok=1 kind=0 id=42 command=0x13 prefix=000004 len=11 raw=55002A1385FF0000000016 error=NONE
@FRAG usb_v=1 seq=1 board_ms=6100 reason=UNKNOWN_HEADER len=3 raw=7F12A0
@SYS usb_v=1 board_ms=12 event=BOOT
```

USBは115200 bps、8N1、flow controlなしです。portはVID/PIDから自動選択せず、画面で選びます。byte-based framerはLF/CRLF、任意chunk分割、1 byteずつの受信を処理し、1 lineを2048 bytesへ制限します。上限超過時と非ASCII入力は次のLFまで破棄してparser errorとして保存します。reconnect時には途中lineを破棄します。

`@RX valid=1`だけを既存LoRa application decoderへ渡します。`valid=0`、`@FRAG`、構造不正recordはpacket monitorとsessionへ残しますがcurrent telemetryは更新しません。`SSC_NOT_INITIALIZED`、`GNSS_NO_FIX`等のsemantic unavailableはwire packetが正しければvalidであり、0等へ補正しません。`#`で始まるpretty-printはtelemetry sourceにせず、ESP ROM出力等のunclassified lineもraw sessionから失いません。

USB v1への移行はbreaking changeです。旧Ground Boardの自由文pretty-printだけをtelemetryとしてparseするPC softwareとは互換ではありません。一方、PCからGround Boardへ送る`g`、`ae`、`le`、`local`、`time`、`release`、`help`のcommand text形式は維持します。

詳細は[docs/usb-v1.md](docs/usb-v1.md)を参照してください。

## 保存

application起動ごとに新しいsession directoryを作ります。

Windows例:

```text
Documents\CREATE 99L Ground Station\logs\2026-08-13T12-34-56-789Z\
```

内容:

```text
session.json
events.jsonl
serial.bin
```

`events.jsonl`は接続、全serial chunk/line、parsed record、parser error、command lifecycle、Renderer latency、application decoder mismatchを受信順で保存します。各eventにはPC UTC、string化したmonotonic nanoseconds、portを付けます。`serial.bin`はRX/TXのraw byteを保存します。各appendを`fsync`し、RendererのF5中もElectron Main processが受信・保存を継続します。disk errorはそのsession中stickyなfailureとして表示し、telemetry受信を可能な限り継続します。

Rendererのpacket monitor/historyはboundedです。全履歴の基準はdisk sessionです。

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

NixOS/Linuxではrepository rootで次を使用できます。

```bash
nix develop path:.
bash scripts/nix-deps.sh
npm test
npm run test:pty
npm run build:renderer
npm run dev
```

未commitの`flake.nix`も確実に入力へ含めるため、現在のworking treeでは`path:.`を指定します。flakeをcommitした後は通常の`nix develop`でも起動できます。shellはNode.js 22とElectronを固定し、NixOS上ではnpm同梱binaryの代わりにNix packageのElectronを使用します。`nix-deps.sh`は実行bitを保持しないfilesystem上でもnpm package binaryを使えるよう、lockfile hash別のdependencyをuser cacheへ置き、repositoryのignored `node_modules`からsymlinkします。既存の異なる`node_modules`は削除しません。

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
npm run verify:linux-package
```

生成binaryはElectron/Node/Three.js/SerialPortを同梱します。利用者PCへNode.jsやnpmを要求しません。build時はlockfileから一時的なphysical production dependency treeを作ってpackするため、Nix用`node_modules` cache symlinkでもSerialPortのtransitive package/native addonを欠落させません。native addonはNixの新しいglibcで再buildせず、配布済みlinux-x64 glibc prebuildを使用します。`verify:linux-package`は`appimage-run`で生成AppImageそのものを起動し、そのruntimeから`serialport`とnative bindingをloadして実際にport列挙まで行います。

GitHub Actionsの`Build desktop artifacts`はpush、pull request、手動実行でtest後にWindows portable `.exe`とLinux AppImageをartifactとして出力します。

## protocol smoke test

```bash
npm test
```

共有golden vectorで既知9 packet type、length、XOR、strict USB v1 parser、framer、command lifecycle、session error/order、bounded storeを確認します。PTY integrationは実際のOS pseudo terminalと`serialport`を通し、任意chunk、partial disconnect、10回reconnect、single listener、TelemetryStore/sessionまでを確認します。

## Headless serial CLI

GUIを開かずにport確認、timestamp付きcapture、console command送信、session保存を行えます。serial owner、byte framer、strict parser、session writerはElectron Main processと同じ実装です。同一portをGUIや別monitorと同時に開かないでください。

```bash
npm run cli -- --help
npm run cli -- --list
npm run cli -- --port /dev/ttyUSB0 --duration-ms 10000 --send "help"
npm run cli -- --port /dev/ttyUSB0 --duration-ms 10000 --session-dir /tmp/99l-cli
```

CH340のDTR/RTS状態によりESP32がdownload bootへ入っている場合は、同一processでportを保持したままrun modeへresetできます。

```sh
npm run cli -- --port /dev/ttyUSB0 --reset-to-run --duration-ms 10000 --send "help"
```

`--reset-to-run`はDTRをdeassertしたままRTSを100 ms pulseし、送信前にESP32を通常bootへ戻します。通常のread-only captureでは指定しないため、CLI接続だけで基板を自動resetしません。

`--send`はport open直後の取こぼしを避けるため既定で250 ms待ってから、入力文字列をそのままGround Boardへ送ります。必要なら`--settle-ms`で変更できます。actuator commandの安全確認はoperator側で行います。接続中はstdinからもcommandを送信できます。

## Validation (2026-08-14)

- **PASS (host)**: USB v1共通golden vector 22 record、strict parser、byte framer、既存application decoder、command lifecycle、session/store unit test。
- **PASS (PTY service path)**: pseudo terminal上の実`serialport`からMain process service、parser、TelemetryStore、session writerまでを通し、10回reconnect後もlistener重複なし。**PARTIAL (PTY full path)**: このtest単体はElectron IPC / preload / Renderer paintを起動していません。この区間は下記development GUI / AppImage実port試験で別途確認しました。
- **PASS (build/package)**: `nix develop path:.`でtest、PTY、renderer、Linux AppImage buildを実行しました。生成AppImage自身のFHS runtimeでpackaged `serialport` loadと7 port列挙まで成功しています。実機試験artifactは132,502,094 bytes、SHA-256 `8cd4dd13b529a375b99193ef9449fc1f4328619b4d1d467b5bee8d5ffd999435`です。
- **PASS (development GUI)**: `/dev/ttyUSB0`を画面選択と同じUI経路で開き、151 `@RX`（A0 149 / B0 2）をGUIとsessionへ151件ずつ保存しました。invalid、parser error、duplicate、sequence gapは0です。受信→storeは最小3 / 平均4.477 / p95 6 / p99 7 / 最大8 ms、受信→paintは9 / 25.470 / 29 / 37 / 48 msでした。10回disconnect/connect後もlistenerは各1、切断中commandは無効、RSSは773860→772168 KiB、threadは104→104です。証跡は`/tmp/99l_usb_v1_9JOjDs71/gui_dev_actual_v2/cdp.json`です。
- **PASS (AppImage USB/parser/session/GUI)**: 600.133秒で`@RX` / disk session / GUIを816件ずつ一致させ、parser error、duplicate、USB sequence gapは0でした。受信→storeは最小2 / 平均3.675 / p95 5 / p99 6 / 最大14 ms、受信→paintは9 / 26.993 / 30 / 45 / 63 msで、engineering targetのp95 50/100 ms、paint最大200 msを満たしました。invalid 1件はraw付きpacket monitor/sessionだけへ残り、telemetry更新に使っていません。この10分区間はMission CANが停止していたため、USB/App/RF受信経路の検証であり3基板telemetry E2Eには数えません。証跡は`/tmp/99l_usb_v1_9JOjDs71/gui_appimage_final_8cd_10min/combined_analysis.json`です。
- **FAIL (10分RF rate target)**: A0は目標約1200件に対して816件（valid 815 / invalid 1、1.361 Hz）でした。1秒超gap 97、5秒超gap 5、RSSI最小-139 / 平均-131.705 / 最大-125 dBmで、weak-RF受信欠落が支配的です。USB sequence gap 0、session/GUI count一致のため、この不足をparserやRenderer dropへ置き換えていません。
- **PARTIAL (10分memory)**: crash、freeze、listener増加はなく、threadは111〜112でした。process RSSは969896→978768 KiB、先頭20 sample平均969910.6→末尾20 sample平均977612.6 KiBであり、10分を超える長期plateauまでは立証していません。
- **PARTIAL (A0-only command)**: 55 UI試行（`g 0x7F` 28 / `le` 27）に対して`@TX` 55、final 50でした。`g` final 27件はUI→final最小527 / 平均721.556 / p95 989 / p99・最大998 ms、`le` final 23件は531 / 740.826 / 986 / 1001 / 1001 msです。final outcomeはそれぞれRejected/NotSupported、Rejected/InvalidStateで、TX→final平均は225.667 / 225.565 msです。RFでfinalを失った5件をfailureへ推測せず、auto retry 0、operatorがID 49 / 34 / 61 / 65 / 67をmanual releaseしました。ID 67の`@SYS`はport open途中lineへ重なってunclassified保存され、`# released`は確認したもののapp側で成功相関していません。各50回の計画数は未達です。集計は`/tmp/99l_usb_v1_9JOjDs71/a0_command_aggregate.json`です。
- **PARTIAL (A0+B1 command)**: 10 UI試行（`g` 5 / `le` 5）に対して`@TX` 9、final 7でした。成功した`g` 3件のUI→finalは最小827 / 平均1035.333 / p95・最大1294 ms、`le` 4件は711 / 1215.5 / 2703 / 2703 msです。2.703秒finalを1秒でtimeout/retryせず同じtransactionへ相関しました。残りはRF送信前boundary timeout 1件と`@TX`後final欠落2件で、operator release以外の自動処理はありません。集計は`/tmp/99l_usb_v1_9JOjDs71/mixed_command_aggregate.json`です。
- **PASS (TimeRequest/TimeResponse)**: B1 ID 7をUIへ表示し、`time 7 ...`から`@TX kind=4 id=7 command=0x02 ok=1`を生成しました。PC側でIDを再採番せず、送信前発行済みのB1 ID 8以後はA0 128件が継続しB1は停止しました。証跡は`/tmp/99l_usb_v1_9JOjDs71/gui_appimage_time_response_current/`です。
- **PASS (final three-board passive) / FAIL→PASS (safe command)**: Mission productionをclean build/uploadしてCAN正常を確認した後、最終productionの69.565秒sessionはA0 129件、valid 129、session/GUI一致、parser error、duplicate、sequence gap 0でした。最初の`g 0x7F`は`@TX ok=1`後のfinalをRFで失いましたが自動再送せず、別sessionでoperatorが再試行した`g 0x7F`は713 ms、`le`は950 msで期待したfinalへ到達しました。証跡は`/tmp/99l_usb_v1_9JOjDs71/gui_appimage_final_production_65s/`、`gui_appimage_final_g_retry1/`、`gui_appimage_final_le_retry1/`です。
- **PASS (GUI reconnect) / PARTIAL (board reset) / BLOCKED (physical unplug)**: GUI disconnect/connect 10回はcrash、二重listener、二重packet表示なしでした。Ground Board resetも10回実行し最終valid A0復帰を確認しましたが、全10回をGUI接続中に観測してはいません。物理USB抜去は自動化環境から実施していません。

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
- serial sessionは順序と即時永続化を優先してMain processで同期write/fsyncします。高packet rateでlatency targetを超える場合は、bounded utility process化を別途評価します。
- disk write failureは同じsession内で自動的に「回復済み」へ戻しません。新しいsessionで明示的に再試行します。
- B0 Accepted後もpendingを維持し、Completed/Rejected/Failedでのみfinalにします。1秒timeout、自動retry、自動releaseは行いません。
- Ground BoardがUSBをresetした`@SYS event=BOOT`ではcurrent telemetryとsequence基準をclearしますが、pending commandを成功/失敗へ推測しません。
- Ground BoardがE220へ書く前にboundary timeoutした場合、USB v1には対応するmachine-readable failure recordがありません。`#`をtelemetry sourceにしないためcommandは`USB_WRITTEN`のまま保持し、operatorが基板状態を確認して解決します。自動failure/retryへは変換しません。
