# Ground Station architecture

## Current prototype

```text
Avi_tenkatenn_board USB Serial
            │
            ▼
Electron Main process
  ├─ GroundSerialService (single SerialPort owner)
  ├─ byte framing + strict USB v1 parser
  ├─ SessionWriter (raw/JSONL + fsync)
  ├─ bounded command queue
  └─ bounded replay + stream ID
            │ typed IPC / isolated preload
            ▼
Renderer
  ├─ valid @RXだけ既存LoRa packet decoderへ
  ├─ telemetry state/history
  ├─ bounded packet monitor / latency samples
  ├─ command lifecycle correlation
  ├─ Three.js
  ├─ charts
  └─ offline map
```

Renderer reloadではMain processとUSB/session loggingが継続する。snapshot replayとlive eventはstream IDでdeduplicateし、replay中は再描画をまとめる。

自動試験では`ground-cli.mjs`がMain processと同じ`GroundSerialService`、byte framer、USB v1 parser、session writerを再利用し、SerialPortのRX/TXをJSON Linesへ記録する。GUIとCLIは同一portを同時に所有しない。

BrowserWindowは`contextIsolation=true`、`nodeIntegration=false`、sandbox有効を維持する。Rendererへserialportやfile handleは公開しない。

## Production hardening candidate

Serial rateやpretty-print量が増えてMain processの同期`fsync`が問題になる場合は、次のutility processへ移す。

```text
Electron Main
       │
       ▼
Telemetry utility process
  ├─ SerialPort
  ├─ line/parser
  ├─ decoder
  ├─ logger + fsync
  └─ current snapshot/history
       │ MessagePort
       ▼
Renderer
```

現行LoRa 2 Hz級ではMain processによる即時flushでも成立するが、最終負荷試験で判断する。
