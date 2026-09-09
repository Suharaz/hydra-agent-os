---
phase: 1
title: "Kline Ingestion & Technical Indicators"
status: pending
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Kline Ingestion & Technical Indicators

## Overview
Tích hợp API lấy dữ liệu nến Klines (15m & 30m) cho Binance Futures và Spot, xây dựng Ring Buffer lưu trữ 50 nến gần nhất trong RAM, và module tính toán chỉ báo kỹ thuật cơ bản (EMA, RSI, ATR, High/Low N-candles) với độ trễ microsecond.

## Requirements
- **Functional**:
  - Thêm phương thức `klines(symbol, interval, limit)` vào `FuturesRest` (`/fapi/v1/klines`) và `SpotRest` (`/api/v3/klines`).
  - Xây dựng `KlineHub` hoặc tích hợp vào `FeedHub` để duy trì nến 15m và 30m cho các symbol được whitelist (`BTCUSDT`, `ETHUSDT`).
  - Hàm tính toán toán học thuần túy: EMA(period), RSI(14), ATR(14), Highest(N), Lowest(N).
- **Non-functional**:
  - Không vượt quá giới hạn Rate Limit của Binance (tối đa 1 REST call/phút/symbol, hoặc cập nhật qua WebSocket).
  - Khởi tạo nến lịch sử khi boot để các chỉ số có đủ dữ liệu tính toán (warm-up).

## Architecture
```
Binance REST (/fapi/v1/klines) ──> KlineHub (Circular Ring Buffer: 50 nến)
                                          │
                                          ├──> EMA(fast, slow)
                                          ├──> RSI(14)
                                          ├──> ATR(14)
                                          └──> Range High/Low(N)
                                                  │
                                                  ▼
                                      Engine `swing` consumes state
```

## Related Code Files
- Modify: `src/venues/binance/rest-futures.ts` (thêm `klines`)
- Modify: `src/venues/binance/rest-spot.ts` (thêm `klines`)
- Create: `src/hot/indicators.ts` (toán học EMA, RSI, ATR, Range)
- Modify: `src/hot/feed-hub.ts` hoặc `src/hot/feed/` (quản lý buffer nến)

## Implementation Steps
1. Thêm interface `KlineRow` và method `klines` trong `rest-futures.ts` và `rest-spot.ts`.
2. Tạo module `src/hot/indicators.ts` chứa các hàm tính toán EMA, RSI, ATR, Highest, Lowest với unit tests độc lập.
3. Tạo cơ chế định kỳ đồng bộ nến 15m và 30m trong `FeedHub` khi có cặp nến mới đóng.
4. Viết unit tests kiểm tra độ chính xác của các công thức tính toán.

## Success Criteria
- [ ] `FuturesRest.klines("BTCUSDT", "15m", 50)` trả về 50 nến OHLCV hợp lệ.
- [ ] Module `indicators.ts` tính đúng giá trị EMA, RSI, ATR so sánh với giá trị chuẩn.
- [ ] Không có memory leak hoặc blocking event loop khi duy trì buffer nến.

## Risk Assessment
- **Risk**: Binance trả mã lỗi 429 nếu gọi API nến quá dồn dập.
- **Mitigation**: Cache nến trong bộ nhớ; chỉ gọi refresh khi hết chu kỳ nến hoặc giãn cách tối thiểu 30 giây.
