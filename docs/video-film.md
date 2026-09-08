# HYDRA — Phim giới thiệu (bản đạo diễn)

Một phim, 100 giây, 1920×1080 @ 30fps, có nhạc + hiệu ứng + thuyết minh. Hai bản ngôn ngữ dùng chung một component; **English là bản chính**.

| Bản | File | Thuyết minh | Composition |
|---|---|---|---|
| **English (chính)** | `video/remotion/out/hydra-director-final.mp4` | `en-US-ChristopherNeural` | `HydraDirectorFilm` |
| Tiếng Việt | `video/remotion/out/hydra-director-final-vi.mp4` | `vi-VN-NamMinhNeural` | `HydraDirectorFilmVi` |

- Cả hai: H.264 + AAC stereo, ~100,05s, ~23–24 MB, mean loudness ≈ −20 dB (có tiếng, không câm).
- Dựng hình: Remotion — `video/remotion/src/DirectorFilm.tsx` (nhận prop `lang: "en" | "vi"`; bảng copy `EN`/`VI`; audio tự chọn `director-audio-<lang>.wav`).
- Âm thanh: `video/remotion/public/director-audio-en.wav`, `director-audio-vi.wav` — nhạc synth nguyên bản + SFX + giọng edge-tts.

## Câu chuyện (theo một giao dịch)

| Mốc | Cảnh | Nội dung |
|---|---|---|
| 0–8s | Signals | Thị trường không chờ AI suy nghĩ |
| 8–20s | Two-speed | Hot lane (code) tách khỏi cold lane (agent) |
| 20–39s | Five roles | Commander, Supervisor, Coach, Treasurer, Sales — qua hành động |
| 39–50s | Limits | Đề xuất phải qua Risk Kernel; Shadow chỉ ghi lại |
| 50–59s | A loss trade | Một lệnh mô phỏng thua: breakout vào trước khi xác nhận |
| 59–81s | Dream Coin | Recall → Reflect → Counterfactual → Consolidate; cùng một lệnh gốc |
| 81–92s | Context | Bài học vào ngữ cảnh lượt sau — bộ nhớ quyết định, không huấn luyện lại |
| 92–100s | HYDRA | "A trade concludes. The lesson remains." |

## Nguyên tắc trung thực

- Dream Coin gắn nhãn **"MECHANISM SIMULATION"**; demo dùng bài học dựng sẵn (`executeDreamCycle` chưa phản tỉnh bằng LLM).
- Dữ liệu là **mô phỏng** (SIM / 017), không phải số liệu thật; không tuyên bố lợi nhuận, không "không bao giờ tái phạm", không "an toàn tuyệt đối".
- Vai trò agent bám đúng system prompt trong `src/cold/agents/` (Sales soạn báo cáo chờ người duyệt; Treasurer không chuyển vốn; Shadow record-only).

## Tái tạo

```bash
# 1) (Chỉ khi đổi lời) sinh audio — cần mạng cho edge-tts
NARRATION=narration-en.json python video/audio/generate-audio.py   # -> director-audio-en.wav
NARRATION=narration-vi.json python video/audio/generate-audio.py   # -> director-audio-vi.wav

# 2) Render
cd video/remotion
bun run build                                                       # English -> hydra-director-final.mp4
bunx remotion render src/index.ts HydraDirectorFilmVi out/hydra-director-final-vi.mp4 --crf=18
```

Nguồn lời: `video/audio/narration-en.json`, `narration-vi.json`. Copy trên hình: bảng `EN`/`VI` trong `DirectorFilm.tsx`.
