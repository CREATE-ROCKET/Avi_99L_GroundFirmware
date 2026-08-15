# ForceStartSequence operator仕様

## 1. 目的

`ForceStartSequence`は、Mission Boardのpreflight異常、未設定、未検証項目、またはpreflight checker自体の不具合をoperatorが認識した上で、シーケンス開始を優先するための非常用操作である。

通常の`StartSequence`と同一操作にしない。

Mission generic commandは次を使用する。

- `StartSequence`: command `0x01`
- `ForceStartSequence`: command `0x04`

`ForceStartSequence`のargs0..5はすべて0とする。

## 2. GUI表示

通常StartとForce Startは別buttonまたは別操作として表示する。

Force操作時は最低限、次を表示する。

- `FORCED START / PREFLIGHT BYPASS`相当の明確な危険表示
- 現在Groundが把握しているFAULT / INVALID / STALE / UNAVAILABLE / NOT CONFIGURED項目
- provisional / `TODO(HW_TEST)` / `TODO(SIMULATION)`相当の未qualification項目
- 「表示されていない未知の異常も存在し得る」こと
- Force後もControl gateやdeployment Safetyは通常どおり動作し、異常sensorを正常扱いにはしないこと

一覧に何も表示されない場合でもForceを通常Startと同等に見せない。

## 3. 二段階確認

Force buttonの1 clickだけでcommandを送信してはならない。

1. operatorがForce Startを選択する。
2. 現在のbypass項目一覧をdialogへ表示する。
3. operatorが「preflight条件を無視して開始する」ことを明示確認する。
4. 最終確認後にのみMissionGeneric `0x04`を送信する。

通常`StartSequence 0x01`が`NotConfigured`等で拒否された場合、自動的に`0x04`へfallbackしてはならない。Forceへの切替は必ずoperatorの明示操作とする。

## 4. Command lifecycle

送信後は通常generic commandと同じtransaction lifecycleを使用する。

- nonzero transaction IDを割り当てる
- `Accepted`だけで開始成功と表示しない
- 終端`Completed`または`Failed/Rejected`を追跡する
- retry時は同一transaction/requestのreplay規則を守る

MissionStateが実際に`LiftoffDetection`へ移行したこともtelemetryで確認する。

## 5. Force後の継続警告

`ForceStartSequence`がCompletedとなったsessionでは、少なくともflight終了まで次を継続表示する。

`FORCED START / PREFLIGHT BYPASSED`

通常flightと同じ表示へ無言で戻さない。

GroundがMission側のforced-start latchをtelemetryで取得できるようになるまでは、Ground自身のcommand transaction記録をsession-local sourceとして警告を維持してよい。ただしMission/Ground再起動をまたぐ正式な状態復元はMission protocolのversioned extensionへ移行する。

## 6. Session log

Force操作時は最低限、次をsession logへ保存する。

- operator操作時刻
- transaction ID
- command code `0x04`
- 送信時点のMissionState
- Groundが把握していたbypass対象一覧
- `Accepted` / terminal result
- terminal result時刻
- Force後に受信した最初のMissionState

後日、通常StartだったかForce Startだったかを一意に判定できることを要求する。

## 7. Console

command consoleからraw generic commandとして`0x04`を送信できてもよい。

console経路ではGUI二段階dialogを通らないため、operatorが直接危険操作を行ったものとしてsession logへ明示する。consoleから送ったForceを通常Startへ変換しない。

## 8. Ground側で行わないこと

Ground StationはForce時に以下を行わない。

- sensor HealthをVALIDへ書き換える
- stale値をlive値として扱う
- Mission側Control gateをGround判断で成立させる
- `StartSequence`拒否後の自動Force retry
- 通信断中にForce commandをqueueして復帰後に自動送信する

ForceはMission Boardへ「preflight判定をbypassしてsequence開始を試みる」意思を伝えるcommandであり、GroundがMission safety stateを偽装する機能ではない。

## 9. 必須UI test

1. normal StartとForce Startが別操作である。
2. Forceの1 clickだけでは送信されない。
3. bypass一覧が確認dialogへ表示される。
4. cancelで`0x04`が送られない。
5. confirm後だけ`0x04`が送られる。
6. normal Start rejectionから自動Forceしない。
7. `Accepted`だけで成功表示しない。
8. `Completed`後に継続警告が表示される。
9. `Rejected/Failed`ではforced-flight開始済み表示にしない。
10. session logからForce操作とtransaction lifecycleを復元できる。
