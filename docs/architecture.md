# Ground Station architecture

## Current prototype

```text
Avi_tenkatenn_board USB Serial
            │
            ▼
Electron Main process
  ├─ line framing
  ├─ raw/structured logging + fsync
  ├─ serial port lifecycle
  └─ in-memory line replay buffer
            │ IPC
            ▼
Renderer
  ├─ USB record parser
  ├─ LoRa packet decoder
  ├─ telemetry state/history
  ├─ Three.js
  ├─ charts
  └─ offline map
```

Renderer reloadではMain processとUSB/session loggingが継続する。

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
