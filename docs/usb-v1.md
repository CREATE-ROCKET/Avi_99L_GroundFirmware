# USB Serial line protocol v1 integration

## Ownershipとdata flow

USB SerialはElectron Main processの`GroundSerialService`だけが所有します。Rendererへ`SerialPort` objectやfile handleを渡しません。

```text
Ground Board / USB 115200 8N1
        │ arbitrary byte chunks
        ▼
UsbLineFramer (LF/CRLF、2048 byte上限)
        │ complete ASCII line
        ▼
shared strict USB v1 parser
        ├─ SessionWriter → serial.bin / events.jsonl
        └─ typed IPC → TelemetryStore → packet monitor / UI
                              │
                              └─ valid @RXだけ既存LoRa decoderへ
```

preloadは`contextIsolation=true`、`nodeIntegration=false`、sandbox有効のまま、port列挙・connect・disconnect・command送信・session snapshotとtyped event購読だけを公開します。Rendererの入力はMain process側で検証します。

CLIも`GroundSerialService`、`UsbLineFramer`、USB v1 parser、`SessionWriter`をそのまま再利用します。GUIとCLIでparserを複製していません。

## Record validation

- `@RX`: mandatory field、uint32/uint8範囲、known header length、raw/header、RSSI式、valid/error整合を検証します。`valid=1`のみapplication decodeし、boardとPC decoderの判定が食い違う場合は`APP_DECODE_MISMATCH`としてcurrent telemetryを更新しません。
- `@TX`: 11 byte、`0x55` header、kind/id/command、XOR、ok/error整合を検証します。
- `@FRAG`: `UNKNOWN_HEADER`、`FRAME_TIMEOUT`、`FRAME_OVERFLOW`、`RESYNC`だけを受理し、telemetryへ反映しません。
- `@SYS`: mandatoryの`usb_v`、`board_ms`、`event`を検証します。既知event固有fieldを検証し、将来のunknown event/unknown keyは`extras`へ保持します。`READY`を接続handshakeには要求しません。
- duplicate key、missing key、numeric overflow、lowercase/odd-length hex、length/header/RSSI不一致はdefaultへ補正せずparser errorです。

`#` lineとunclassified ROM boot lineはmonitor/sessionへ残しますがtelemetry sourceではありません。Rendererへ表示するraw textはHTML escapeします。

## Command lifecycle

PCからのcommandは32件のbounded serial write queueで順序を保ちます。Ground Boardがtransaction IDを割り当てるため、PCはIDを先取りしません。

```text
LOCAL_QUEUED → USB_WRITTEN → BOARD_TX_OK → ACCEPTED → FINAL
                         └→ BOARD_TX_FAILED
USB write失敗             → USB_WRITE_FAILED
manual release成功        → RESULT_UNKNOWN
```

- `@TX`を受信して初めてkind/id/commandを確定します。
- Generic/Local resultはrequested command、`ae`は`0xF0`、`le`は`0xF1`を期待し、IDとcommandの両方が一致したB0だけを関連付けます。
- Acceptedはpendingのままです。Completed/Rejected/Failedだけがfinalです。
- duplicate finalはidempotentに扱い、FINAL後のlate non-duplicate resultで状態を巻き戻しません。
- unmatched/wrong-command resultはmonitorへ出し、別transactionを解放しません。
- `@SYS TRANSACTION_RELEASE ok=1`は対象pendingを`RESULT_UNKNOWN`にしてmappingを外します。`ok=0`は対象pendingを変更しません。
- 自動retry、自動release、1秒timeoutによるfailure化は行いません。

## Session format

起動ごとのdirectoryに以下を保存します。

- `session.json`: schema、開始UTC、app version、platform、architecture。
- `serial.bin`: USB RX/TX raw bytes。
- `events.jsonl`: connection、serial chunk/line、parsed classification、parser error、command transition、Renderer latency、application decode mismatch。

各eventは`pcUtc`、stringの`pcMonotonicNs`、portを持ちます。write順を保ち、partial writeもerrorにし、各append後にfsyncします。disk failureはUIへ通知し、そのsession中はstickyに保持します。RendererのF5中もMain processのcaptureは継続し、最大4096 replay eventをstream IDでdeduplicateして戻します。

Rendererのpacket monitor、history、latency sampleはboundedです。全履歴はsession fileを参照します。

## Reconnectとboard reset

- connect中の二重connectは拒否します。
- connect open中にdisconnectされたattemptはgenerationでcancelし、開いたportを直ちにcloseします。
- disconnect/reconnectでframerのpartial lineを破棄し、listenerをdetachしてから再登録します。
- disconnect時はcurrent telemetryをclearします。history/sessionとpending transactionは残し、結果を推測しません。
- ttyがopenのままGround Boardがresetした場合も、`@SYS event=BOOT`をboard-session boundaryとしてcurrent telemetry/RSSI/time request/sequence baselineをclearします。

## Test

```bash
nix develop path:. --command npm test
nix develop path:. --command npm run test:pty
nix develop path:. --command npm run build:linux
nix develop path:. --command npm run verify:linux-package
```

`npm test`はGround Board repositoryとbyte-identicalな`testdata/99l_usb_v1_vectors.txt`を使用します。PTY testは`socat`でpseudo terminal pairを作り、実`serialport`→service→store/session経路、1 byte分割、malformed/pretty/unclassified、partial reconnect、10回reconnectとsingle listenerを確認します。Electron IPC/preload/paintを含む最終経路はdevelopment GUIとAppImageの実port試験で検証します。

desktop packageは一時directoryへruntime fileをcopyし、`npm ci --omit=dev`でlockfileどおりのphysical production dependency treeを作ってからelectron-builderへ渡します。これにより開発用`node_modules`がNix cacheへのsymlinkでも、`@serialport/*`、`node-gyp-build`、native `.node`をasar/unpackedへ確実に含めます。Nixの新しいglibcへ依存するlocal rebuildを禁止し、serialport配布済みlinux-x64 glibc prebuildを収録します。Linux package verificationは`appimage-run`で生成AppImageそのものを起動し、そのFHS runtime内からpackaged `serialport`をrequireして`SerialPort.list()`の成功まで確認します。

## 実機validation（2026-08-14）

実機試験にはSHA-256 `8cd4dd13b529a375b99193ef9449fc1f4328619b4d1d467b5bee8d5ffd999435`のAppImage、Ground Board `/dev/ttyUSB0`、ComBoard `/dev/ttyACM0`、Mission Board `/dev/ttyACM1`を使用しました。共有golden vectorのSHA-256は両repositoryとも`ce525d862e754128f1044eedb456eef7131b2c418f0ebc732a57a78960e2af6b`です。

- **PASS（line/parser/session/GUI）**: 10分試験の816 `@RX`をsessionとGUIへ816件ずつ保存しました。parser error、duplicate、USB sequence gapは0です。valid 815、invalid 1で、invalid rawをcurrent telemetryへ反映しませんでした。この区間はMission CAN停止中だったためUSB/App/RF受信経路の検証であり、Mission production復旧後の3基板E2Eは別の69.565秒試験で確認しました。
- **PASS（latency）**: 受信→storeは最小2 / 平均3.675 / p95 5 / p99 6 / 最大14 ms、受信→paintは9 / 26.993 / 30 / 45 / 63 msでした。
- **FAIL（RF rate）**: 500 ms周期の約1200件目標に対して816件、1秒超gap 97、5秒超gap 5でした。RSSI平均-131.705 dBmのweak-RF条件であり、PC経路のdropとは分離しています。
- **PARTIAL（command delivery）**: A0-onlyは55試行、`@TX` 55、final 50、A0+B1は10試行、`@TX` 9、final 7でした。2.703秒のlate finalも同じpendingへ相関し、1秒timeout、自動retry、自動releaseは0です。RFでB0を失ったtransactionだけをoperatorが明示的にreleaseしました。
- **PASS（TimeResponse）**: B1 ID 7を再採番せず`@TX kind=4 id=7 command=0x02`で応答し、その後B1が停止してA0が継続しました。
- **PASS（GUI reconnect）/ PARTIAL（board reset）/ BLOCKED（physical unplug）**: GUI disconnect/connect 10回でlistener重複とpacket重複は0です。board resetは10回成功し最終valid A0を確認しましたが、全cycleをGUI経路で観測していません。物理抜去は未実施です。
- **PARTIAL（PTY full path）**: PTY testは実`serialport`、service、parser、store、sessionと10 reconnectを通しますが、Electron IPC / preload / Renderer paintは含みません。それらはdevelopment GUIとAppImageの実port試験で確認しました。
- **NOT_IMPLEMENTED（pre-uplink failure correlation）**: Ground BoardがE220へ書く前にboundary timeoutした1件は`@TX`対象外で、machine-readable failure recordもUSB v1にありません。`#`をprotocol入力へ昇格せず、PC側は`USB_WRITTEN`をoperator確認まで保持します。

詳細集計は`/tmp/99l_usb_v1_9JOjDs71/gui_appimage_final_8cd_10min/combined_analysis.json`、`/tmp/99l_usb_v1_9JOjDs71/a0_command_aggregate.json`、`/tmp/99l_usb_v1_9JOjDs71/mixed_command_aggregate.json`、`/tmp/99l_usb_v1_9JOjDs71/gui_appimage_time_response_current/`、`/tmp/99l_usb_v1_9JOjDs71/gui_appimage_final_production_65s/`にあります。
