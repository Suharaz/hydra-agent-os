---
phase: 3
title: "Agent Autonomous Deduction & Patch Loop"
status: pending
priority: P1
effort: "2h"
dependencies: ["phase-02-swing-engine-modes"]
---

# Phase 3: Agent Autonomous Deduction & Patch Loop

## Overview
Trang bị cho AI Agent (Commander và Coach) khả năng phân tích hiệu suất của từng Mode chiến thuật từ dữ liệu SQLite Ledger, từ đó tự động suy luận chuyển đổi Mode hoặc điều chỉnh tham số (EMA, RSI, SL/TP ATR) thông qua công cụ `engines.patch`.

## Requirements
- **Functional**:
  - Ledger SQLite: Thêm thống kê lệnh theo `mode` và `setup` của engine `swing`.
  - Cập nhật prompt của `Commander` (`src/cold/agents/commander.ts`) để Agent hiểu cơ chế 3 Mode và có dữ liệu hiệu suất của từng Mode.
  - Cập nhật prompt của `Coach` (`src/cold/agents/coach.ts`) để tổng hợp bài học sau mỗi ngày về hiệu suất của Breakout vs Pullback vs Reversal.
  - Đảm bảo Commander có thể gửi bản vá `engines.patch` cho `swing` để đổi `mode` (ví dụ từ 0 sang 2) và đổi tham số trong giới hạn an toàn (`ENGINE_PARAM_BOUNDS`).
- **Non-functional**:
  - Không cho phép Agent đổi Mode nhảy cóc sau từng lệnh; đặt ràng buộc tối thiểu 6 lệnh trước khi đánh giá hiệu suất.
  - Phản hồi đầu ra của LLM phải tuân thủ nghiêm ngặt JSON Schema.

## Architecture
```
SQLite Ledger (Lịch sử lệnh theo Mode)
        │
        ▼
Commander Prompt (Operating Snapshot: Win Rate & PnL per Mode)
        │
        ├──> AI Suy luận: "Breakout đang thua liên tiếp do thị trường Sideway"
        │
        ▼
Tool Call: `engines.patch({ engine: "swing", params: { mode: 2, rsiThreshold: 28 } })`
        │
        ▼
`config/engines.yaml` cập nhật ──> Engine Registry hot-reload (< 200ms)
```

## Related Code Files
- Modify: `src/core/ledger.ts` (thêm query thống kê chi tiết theo setup/mode)
- Modify: `src/cold/agents/commander.ts` (bổ sung context và hướng dẫn suy luận)
- Modify: `src/cold/agents/coach.ts` (bổ sung phân tích post-mortem theo mode)
- Modify: `src/cold/dream.ts` (rút bài học Invariant Rule cho từng mode)

## Implementation Steps
1. Mở rộng `ledger.engineStats` để tách biệt thống kê PnL và Win Rate theo từng `mode` của engine `swing`.
2. Bổ sung hướng dẫn vào system prompt của Commander:
   - Khi Regime = `LOW_VOL` hoặc `ILLIQUID` $\rightarrow$ Ưu tiên Mode 2 (`reversal`) hoặc Mode 1 (`pullback`).
   - Khi Regime = `HIGH_VOL` hoặc `NORMAL` có trend $\rightarrow$ Ưu tiên Mode 0 (`breakout`).
   - Yêu cầu ghi rõ lý do suy luận trong thuộc tính `rationale` của bản vá.
3. Kiểm thử chu trình: Mock dữ liệu 5 lệnh thua Breakout $\rightarrow$ kích hoạt Commander $\rightarrow$ xác nhận Commander đề xuất chuyển sang Mode Reversal.

## Success Criteria
- [ ] Commander nhận diện được thống kê PnL của từng Mode từ Snapshot.
- [ ] Khi một Mode có tỷ lệ thua cao trong điều kiện thị trường không phù hợp, Commander phát sinh `engines.patch` hợp lệ để đổi sang Mode khác.
- [ ] `config/engines.yaml` được ghi đè an toàn và engine `swing` chuyển đổi hành vi thành công.

## Risk Assessment
- **Risk**: AI đổi Mode liên tục khi kết quả chỉ là biến động ngẫu nhiên.
- **Mitigation**: Quy định rõ trong prompt: chỉ đổi Mode khi có tối thiểu 6 lệnh hoặc có sự thay đổi rõ rệt về Market Regime.
