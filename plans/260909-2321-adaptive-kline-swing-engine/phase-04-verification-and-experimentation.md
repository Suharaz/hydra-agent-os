---
phase: 4
title: "Verification, Test Suite, and Production Deployment"
status: pending
priority: P1
effort: "2h"
dependencies: ["phase-03-agent-deduction-patches"]
---

# Phase 4: Verification, Test Suite, and Production Deployment

## Overview
Viết bộ kiểm thử toàn diện cho các chỉ báo kỹ thuật, logic kích hoạt của Engine `swing`, kiểm tra toàn bộ luồng duyệt qua Kernel và Executor, sau đó đồng bộ lên VPS Production để chạy thử nghiệm thực tế với khối lượng an toàn ($15/lệnh).

## Requirements
- **Functional**:
  - Viết unit test cho `indicators.ts` (EMA, RSI, ATR).
  - Viết integration test cho `SwingEngine` (kiểm tra phát sinh Intent khi có nến Breakout hoặc RSI đảo chiều).
  - Kiểm tra toàn bộ 242+ tests hiện có không bị regression (`bun test`).
  - Kiểm tra TypeScript (`bunx tsc --noEmit`).
  - Đồng bộ mã nguồn và cấu hình lên VPS Production (`159.195.47.180`).
  - Khởi động lại PM2 `hydra` và xác nhận log khởi động sạch sẽ.
- **Non-functional**:
  - Đảm bảo an toàn tài khoản: chạy với `sizeUsd: 15` hoặc `20` trên `BTCUSDT` và `ETHUSDT`.
  - Không phá vỡ trạng thái cơ sở dữ liệu `state/hydra.sqlite` hiện có trên VPS.

## Architecture
```
Local Dev (Code & Tests)
        │
        ├──> bun test (100% PASS)
        ├──> bunx tsc --noEmit (Clean)
        │
        ▼
Git Commit & Push to origin/main
        │
        ▼
SSH Deploy to VPS (/opt/hydra) ──> pm2 restart hydra ──> Verify Live PM2 Logs
```

## Related Code Files
- Create: `test/hot/indicators.test.ts`
- Create: `test/hot/engines/swing.test.ts`
- Modify: `test/core/config.test.ts`
- Target: `/opt/hydra/` trên VPS `159.195.47.180`

## Implementation Steps
1. Chạy `bun test` cục bộ để đảm bảo 100% tests vượt qua.
2. Kiểm tra log khởi động trên local để đảm bảo `FeedHub` nạp nến và `SwingEngine` hoạt động mượt mà.
3. Commit mã nguồn và đẩy lên GitHub `main`.
4. Đóng gói và đồng bộ lên VPS qua SSH: `tar -czf ... | ssh root@159.195.47.180 ...`.
5. Restart PM2 `hydra` trên VPS và theo dõi log trong 3 phút đầu tiên.
6. Xác nhận trên Dashboard Web (`https://agent.allinprompts.com/`) hiển thị engine `swing` đang hoạt động.

## Success Criteria
- [ ] Tất cả tests trong hệ thống đều pass (`bun test`).
- [ ] TypeScript biên dịch không có lỗi (`bunx tsc --noEmit`).
- [ ] Production VPS ghi nhận log `engines configured` bao gồm `swing`.
- [ ] Lệnh thử nghiệm đầu tiên được phát sinh và xử lý đúng quy tắc rủi ro của Kernel.

## Risk Assessment
- **Risk**: Lệnh thực chiến mở vị thế sai hướng gây tổn thất.
- **Mitigation**: Cố định `sizeUsd: 15` và đặt hard stop-loss trên sàn Binance ngay lập tức.
