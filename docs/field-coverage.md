# Telemetry field coverage

## 表示原則

1. 既知packetの全fieldを`ALL VALUES`へ表示する。
2. boolean status bitを個別fieldへ展開する。
3. numeric値、raw count、semantic statusを同時に保持する。
4. invalid/reserved値を0へ置換しない。
5. application packet全byteを`RAW PACKETS`へ表示し、diskへ保存する。
6. 未知packetはraw bytesを保持し、仕様がない値を推測decodeしない。

## A0 CommandReceiveTelemetry

- Status raw 24 bit
- ICM healthy
- LPS healthy
- SSC healthy
- AS5047D healthy
- STS3215 healthy
- Fin zero configured
- Para open configured
- Para close configured
- Logic battery present
- Motor battery present
- Mission SD healthy
- ComBoard SD healthy
- CAN healthy
- Persistence healthy
- Fin busy
- Para busy
- Gyro bias valid
- Gravity reference valid
- SSC zero valid
- Flash backup has data
- Flash backup healthy
- Motor profile valid
- Fin control disabled
- Calibration busy
- Fin mode
- Para mode
- MotorProfile ID
- Tilt magnitude
- Tilt direction
- Fin angle
- Parachute angle
- LPS pressure
- LPS temperature
- Airspeed
- Logic voltage
- Motor voltage
- GNSS East
- GNSS North
- GNSS absolute height
- XOR checksum

## A1 / A2 / A3 FlightTelemetry

- Flight Status raw 16 bit
- LPS liftoff detected
- ICM liftoff detected
- ICM42688 alive
- STS3215 alive
- Roll Control active
- Logic source present
- Motor source present
- ComBoard microSD healthy
- Mission-ComBoard CAN healthy
- ICM data loss/error
- AS5047D error
- AirData error
- Fin motor saturation
- Fin Brake
- Mission reset/recovery event
- Control re-entry inhibited
- Roll
- Roll rate
- Tilt magnitude
- Tilt direction
- Fin angle
- Fin rate
- LPS pressure
- LPS temperature
- Airspeed
- Requested output torque
- Flight elapsed
- GNSS East
- GNSS North
- GNSS absolute height
- XOR checksum

## A4 DescentTelemetry

- Descent Status raw 13 bit
- LPS deployment condition
- Elapsed deployment condition
- Parachute state
- Deployment power cutoff done
- ComBoard microSD healthy
- Mission-ComBoard CAN healthy
- Deployment shock confirmed
- STS overload
- STS overcurrent
- STS overtemperature
- STS encoder fault
- STS voltage fault
- LPS pressure
- LPS temperature
- Parachute angle
- Descent elapsed
- GNSS East
- GNSS North
- GNSS absolute height
- XOR checksum

## A5 RecoveryBeacon

- Logic voltage
- Motor voltage
- GNSS East
- GNSS North
- GNSS absolute height
- Recovery elapsed
- XOR checksum

## A6 RecoveryLogData

- Transfer ID
- Source
- EOF
- Meta raw
- Offset
- Data length
- Data bytes
- XOR checksum

## B0 CommandResult

- Transaction ID
- Command code
- Phase
- Reason
- Detail
- XOR checksum

## B1 GroundTimeRequest

- Request ID
- XOR checksum

## A7 ComBoardFallback

Headerは予約済みだが、field layoutが現projectのsource basisでは確定していない。raw bytesだけを保存し、正式仕様なしに値を推測しない。
