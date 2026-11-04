# 小柯機器人SUNO工具 https://achir1015.github.io/xiaoke-suno/
<img width="1918" height="1079" alt="image" src="https://github.com/user-attachments/assets/a5dc79bb-0bb6-47fd-a21d-ec3658d51ef3" />

把您在 [Suno](https://suno.com) 做的歌，一次批量下載成 **MP3 音檔** 和 **SRT 字幕**，檔名和 Suno 上的歌名一模一樣；下載前後都能「**邊聽邊看字幕**」，確認歌聲和字幕時間對得上。全面繁體中文介面。

系統開發：吳玉柱 先生 與 Claude AI Opus 5.5

## 怎麼用

1. 安裝後點桌面的「小柯機器人SUNO工具」。第一次開啟會有小柯機器人語音導覽（之後按 F1 或「使用說明」再聽）。
2. 左邊「🌐 Suno 網頁」裡登入您的 Suno 帳號（帳號密碼直接交給 Suno，本工具看不到）。
3. 回到「🎵 歌曲庫」按「☁️ 讀取我的全部歌曲」；只要某個工作區或播放清單，就在 Suno 網頁打開那一頁再按「📥 抓取這一頁的歌曲」。
4. 勾選歌曲、選格式（MP3、SRT、LRC、歌詞、封面、WAV），按「⬇️ 下載所選」。
5. 點封面就開始播放，下方播放列的字幕會跟著歌聲一句一句亮起；按 🎤 放大成卡拉 OK 畫面。

## 功能

- **批量下載**：MP3、SRT、LRC、純文字歌詞、封面 JPG、WAV；同時 1～4 首、可暫停、取消、重試。
- **Suno 下載次數**：2026 年 11 月起 Suno 的 MP3／WAV 要用官方「解鎖並下載」，每首用掉 1 次方案的下載次數（解鎖過的不再扣）。小柯走同一個官方流程，下載前會顯示會用掉幾次、還剩幾次，請您確認；也可以只下載已解鎖的歌。SRT、LRC、歌詞、封面不受影響。
- **檔名同 Suno**：用歌名當檔名；Suno 一次產生兩首同名的歌時，第二首加 (1)（也可改加 ID 或覆蓋）。同一首歌的 MP3 與 SRT 一定同名。
- **SRT 字幕**：用 Suno 的對時歌詞產生，可設定「提早 0～0.5 秒」，自動去掉 [Verse] 等段落標籤與英文風格指示行，修復異常的字間隔。
- **邊聽邊看字幕**：已下載的歌播放本機 MP3＋讀取下載好的 SRT；未下載的用 Suno 線上音檔＋即時字幕。點任一句跳到那裡。
- **標記、小圖案與顏色**：自訂標記（最愛、影片用、字幕待修…）、深淺色外觀與主題色。
- **小柯助手（AI）**：使用您自己的 OpenAI 金鑰，幫您找歌、批量下載、檢查字幕、寫歌詞與 Suno 風格提示。
- **雲端儲存**：歌曲清單與標記存到您的 Google 雲端硬碟「小柯SUNO」資料夾，也可自動備份 SRT、MP3。
- **自動更新**、**語音文字使用說明**。

## 雲端儲存設定（Apps Script）

1. 打開「小柯上傳」Apps Script 專案，新增檔案 `suno.gs`，貼上本專案 `gas/suno.gs` 的內容（不要再寫 `doGet`）。
2. 在 `doPost` 第一行加上：`if (e && e.parameter && e.parameter.app === 'suno') return sunoPost_(e);`
3. 部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署（網址不變）。
4. 函式選 `setupSuno` 按「執行」，執行記錄會印出 `XKS1.` 開頭的設定碼。
5. App 的 設定 → 雲端儲存 → 貼上設定碼。

## 開發

```bash
npm install
npm start          # 開發模式
npm test           # 單元測試（SRT、檔名、雲端程式）
npm run e2e        # 端對端測試（假的 Suno、OpenAI、Apps Script）
npm run dist:win   # 建 Windows 安裝檔（需 Node 22）
```

發新版：改 `package.json` 的版本推上 main，GitHub Actions 會建好 Windows／Mac 安裝檔並發佈 Release。

## 注意

本工具為非官方工具，與 Suno 公司無關，依賴 Suno 網站未公開的介面，Suno 改版時可能需要更新。只會下載您自己帳號裡有權限的歌曲，請遵守 Suno 的服務條款。SRT 時間校正規則改寫自 cityedge/suno_srt_downloader（MIT），詳見 THIRD_PARTY_NOTICES.md。

授權：MIT
