---
title: "Adaptive Kline & Swing Strategy Engine"
description: "Xây dựng Engine giao dịch nến 15m/30m đa chế độ (Breakout, EMA Pullback, RSI Reversal) tích hợp vòng lặp tự suy luận và tối ưu tham số của AI Agent."
status: pending
priority: P1
effort: "9h"
tags: [trading, kline, swing, ai-agents, machine-learning, binance]
created: 2026-09-09
---

# Adaptive Kline & Swing Strategy Engine

## Overview
Dự án HYDRA hiện tại có hai engine HFT chủ lực là `liqfade` (bắt râu thanh lý) và `basis` (chênh lệch giá Spot-Futures). Tuy nhiên, trên tài khoản thông thường (VIP 0), các chiến lược này có tần suất vào lệnh thấp và bị bào mòn bởi phí sàn Binance.

Kế hoạch này phát triển một chiến lược hoàn toàn mới: **Engine Giao dịch Nến Đa Chế Độ (`swing`)** hoạt động trên khung **15m và 30m** cho cả Spot và Futures. Hệ thống được thiết kế theo nguyên lý **Thực nghiệm & Tiến hóa tự thân**:
1. Ban đầu bắt đầu với các chế độ nến cơ bản (Breakout theo sóng, Pullback EMA, Reversal RSI).
2. Chạy thử nghiệm với khối lượng an toàn ($15 - $20/lệnh) để thu thập mẫu dữ liệu giao dịch thực tế vào SQLite.
3. AI Agent (Commander / Coach) đọc dữ liệu hiệu suất, nhận diện trạng thái thị trường và **tự suy luận chuyển đổi chế độ hoặc tinh chỉnh tham số** (SL/TP ATR, chu kỳ EMA, ngưỡng RSI) thông qua các bản vá `engines.patch` hot-reload (< 200ms).

## Architecture Overview

```
                      ┌────────────────────────────────────────────────────────┐
                      │                 COLD LANE (AI AGENTS)                  │
                      │  Claude Fable / DeepSeek / GPT (Mỗi 15m - 1h)         │
                      │  - Phân tích hiệu suất từng Mode từ SQLite Ledger      │
                      │  - Tự suy luận: "Mode nào đang ăn, Mode nào đang thua?"│
                      │  - Gửi bản vá `engines.patch` (đổi Mode, đổi SL/TP)    │
                      └───────────────────────────┬────────────────────────────┘
                                                  │
                                                  ▼ Hot-reload (< 200ms)
                      ┌────────────────────────────────────────────────────────┐
                      │                 HOT LANE (DETERMINISTIC)               │
                      │           Engine `swing` (TypeScript < 1ms)            │
                      │  - Nến 15m & 30m (Circular Buffer: 50 nến)             │
                      │  - 3 Mode: 0: Breakout | 1: Pullback | 2: Reversal     │
                      │  - Dynamic SL/TP theo ATR (R:R >= 1 : 2)               │
                      │  - Bắn Intent ra Kernel Guard -> Binance Executor      │
                      └────────────────────────────────────────────────────────┘
```

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Mở rộng Binance REST client để lấy nến Klines 15m/30m và tính toán EMA/RSI/ATR | P1 |
| 2 | Xây dựng Engine `swing` đa chế độ với Stop-Loss/Take-Profit động theo ATR | P1 |
| 3 | Tích hợp vòng lặp suy luận và vá tham số tự động cho AI Agent (Commander/Coach) | P1 |
| 4 | Kiểm thử 100% test suite và triển khai thử nghiệm trực tiếp trên VPS Production | P1 |

## Phases

| # | Phase | Effort | Status | Deliverables |
|---|-------|--------|--------|--------------|
| 1 | [Phase 1: Kline Ingestion & Technical Indicators](./phase-01-start.md) | 2h | Pending | `rest-futures.ts`, `rest-spot.ts`, `indicators.ts` |
| 2 | [Phase 2: Swing Engine Multi-Mode Implementation](./phase-02-swing-engine-modes.md) | 3h | Pending | `src/hot/engines/swing.ts`, đăng ký engine |
| 3 | [Phase 3: Agent Autonomous Deduction & Patch Loop](./phase-03-agent-deduction-patches.md) | 2h | Pending | Mở rộng `commander.ts`, `coach.ts`, `ledger.ts` |
| 4 | [Phase 4: Verification, Test Suite, and Production Deployment](./phase-04-verification-and-experimentation.md) | 2h | Pending | Unit tests, test suite 100% pass, deploy VPS |

## Success Criteria

- [ ] Lấy dữ liệu nến 15m và 30m từ Binance REST API ổn định, không bị dính mã lỗi 429 Rate Limit.
- [ ] Engine `swing` thực hiện chính xác 3 chế độ chiến thuật và tính toán SL/TP theo ATR.
- [ ] AI Agent (Commander) phân tích được hiệu suất từng Mode và phát sinh lệnh đổi Mode hợp lệ khi thị trường thay đổi.
- [ ] Toàn bộ 242+ tests đều vượt qua, hệ thống chạy trơn tru trên VPS `159.195.47.180`.

<!-- slug: adaptive-kline-swing-engine -->
