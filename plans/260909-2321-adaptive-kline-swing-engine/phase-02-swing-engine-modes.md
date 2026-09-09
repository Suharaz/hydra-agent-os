---
phase: 2
title: "Swing Engine Multi-Mode Implementation"
status: pending
priority: P1
effort: "3h"
dependencies: ["phase-01-start"]
---

# Phase 2: Swing Engine Multi-Mode Implementation

## Overview
Xây dựng Engine `swing` (`src/hot/engines/swing.ts`) kế thừa base class `Engine<Params>`, hỗ trợ đa chế độ chiến thuật (Breakout, EMA Pullback, RSI Reversal), tự động tính Stop-Loss và Take-Profit động theo ATR, và phát sinh Intent cho cả Futures lẫn Spot.

## Requirements
- **Functional**:
  - Hỗ trợ 3 Mode cơ bản được cấu hình qua tham số:
    - Mode 0 (`breakout`): Đua theo sóng khi nến 15m phá đỉnh/đáy N nến gần nhất.
    - Mode 1 (`pullback`): Đánh thuận xu hướng khi giá kiểm tra lại đường EMA.
    - Mode 2 (`reversal`): Bắt đảo chiều khi RSI vượt ngưỡng cực trị (< 30 hoặc > 70).
  - Tự động đặt mức chốt lời $\text{TP} = \text{Entry} \pm \text{tpAtr} \times \text{ATR}$ và cắt lỗ $\text{SL} = \text{Entry} \mp \text{slAtr} \times \text{ATR}$.
  - Ghi nhãn chi tiết lý do vào lệnh (`setup`, `mode`, `rsi`, `atr`) vào metadata của Intent/OpportunityContract.
- **Non-functional**:
  - Tốc độ xử lý tín hiệu microsecond, tuân thủ `ENGINE_PARAM_BOUNDS`.
  - Hỗ trợ cả hai thị trường: Futures (Long/Short) và Spot (Buy/Sell).

## Architecture
```
Event Tick (Nến mới) ──> Mode Evaluation (0: Breakout / 1: Pullback / 2: Reversal)
                               │
                               ├──> Thỏa mãn điều kiện?
                               │         │
                               │      (Có)
                               ▼         ▼
               Tính SL/TP (ATR) ──> emitIntent(IntentDraft) ──> Kernel Guard ──> Executor
```

## Related Code Files
- Create: `src/hot/engines/swing.ts`
- Modify: `src/core/types.ts` (thêm `swing` vào `ENGINE_IDS`)
- Modify: `src/hot/engines/engine.ts` (thêm schema Zod và bounds cho `swing`)
- Modify: `src/hot/engines/registry.ts` (đăng ký `SwingEngine`)
- Modify: `config/engines.yaml` (thêm cấu hình khởi đầu cho `swing`)

## Implementation Steps
1. Định nghĩa Zod schema cho tham số của `swing`:
   - `mode`: enum hoặc int [0: Breakout, 1: Pullback, 2: Reversal]
   - `timeframe`: 15m hoặc 30m
   - `lookbackCandles`: 3-20
   - `fastEma`: 9-50, `slowEma`: 20-200
   - `rsiThreshold`: 20-40
   - `slAtr`: 1.0-3.0, `tpAtr`: 1.5-5.0
   - `maxHoldMs`: 1800000 (30 phút) - 14400000 (4 tiếng)
2. Viết class `SwingEngine extends Engine<Params>` trong `src/hot/engines/swing.ts`.
3. Tích hợp kiểm tra điều kiện nến đóng và tính toán IntentDraft.
4. Đăng ký engine vào `registry.ts` và export bounds cho Commander.

## Success Criteria
- [ ] `SwingEngine` khởi tạo thành công và lắng nghe sự kiện nến.
- [ ] Khi giả lập nến Breakout hoặc RSI quá bán, engine phát sinh đúng Intent mua/bán kèm SL/TP theo ATR.
- [ ] Tham số nạp và reload nóng (`hot-reload`) < 200ms khi cấu hình thay đổi.

## Risk Assessment
- **Risk**: Tín hiệu kích hoạt lệnh quá dày gây lạm phát phí sàn.
- **Mitigation**: Cài đặt thời gian hồi chiêu (`cooldownMs`) tối thiểu bằng độ dài 1 cây nến (15 phút) trên mỗi symbol.
