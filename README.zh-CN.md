# NeoDisc · 让音乐，慢下来

<img src="assets/neodisc.png" alt="NeoDisc" width="128" />

[English](README.md)

一个面向 Windows 和 macOS 的现代 CD 播放与抓轨软件，使用 Rust、Tauri 和 React 构建。

当前版本：**0.1.0**。

## 当前功能

- 无边框窗口，窗口按钮与界面一体化，提供曲目列表和底部常驻播放器。
- 三套皮肤，每套都有浅色与深色，支持跟随系统外观和定时夜间模式。
- 简体中文与英文，默认跟随系统语言；手动选择后立即生效并保存到本机。
- CD 播放、暂停、上一曲 / 下一曲、进度跳转、音量和列表循环；空格控制播放。
- 可选择音频输出设备，默认跟随系统输出切换，支持刷新设备列表和重新连接。
- 实时 10 段播放 EQ，以 dB 为单位的频率／增益曲线支持拖动节点；提供前级增益与七种预设（平直、低音增强、人声、流行、摇滚、古典、爵士），支持微调、开关与重置。设置自动保存，EQ 不改变抓轨文件。
- 通过 MusicBrainz 和 Cover Art Archive 自动识别专辑、曲名与封面；没有结果或存在歧义时保留原显示，也可以在本地编辑专辑信息。
- FLAC / WAV 抓轨，保留 CD 原始的 44.1 kHz、16-bit、双声道音频。
- MP3 / AAC-LC（M4A）抓轨，可设置采样率、比特率和声道。MP3 还支持 CBR、ABR、VBR 与编码精度；各格式分别记住设置，并提供音质预设。
- FLAC、MP3、M4A 写入曲目标签与专辑封面，导出播放列表及含原始 PCM 哈希的抓轨报告。
- 后台抓轨、进度显示、可选重复读取比对和取消，保留原有输出文件。
- 抓轨记录支持目录状态检查、逐条删除、一键清理和撤销；删除记录保留音频文件。
- 自带音频编码器，无需另装 FFmpeg。

## 使用

1. 打开桌面版，连接光驱并放入音频 CD，必要时刷新光驱列表。macOS 下请先等待音频 CD 出现在 Finder 中。
2. 点击「播放全部」或双击曲目试听，顶部搜索只筛选当前光盘的曲目。
3. 专辑信息会在后台自动识别，也可以通过「编辑信息」修改专辑和曲名。
4. 勾选曲目，选择 FLAC、WAV、MP3 或 AAC 和保存位置。MP3 / AAC 可通过「编码详细设置」调整参数，然后点击「开始抓轨」。
5. 在「抓轨记录」中打开已完成的导出目录。不存在的目录会显示提示，可一键清理对应记录，删除后可撤销。
6. 在「外观与皮肤」中设置配色和夜间模式，在「首选项」中选择语言、音频输出与 EQ。选择 EQ 预设即可启用，拖动曲线节点或用方向键微调，双击节点恢复到 0 dB。切换设备后无声时，可以尝试「重新连接输出」。

抓轨期间占用光驱并停止播放，默认保存到系统音乐目录下的 `NeoDisc` 文件夹。MP3 / AAC 为有损格式，提高采样率不会增加 CD 原本没有的细节。

## 开发与构建

需要 Node.js 24 和 Rust stable。Windows 还需 MSVC 构建工具及 WebView2；macOS 需要 Xcode 命令行工具，配置的最低系统版本为 macOS 12。

```sh
npm ci
npm run desktop
```

首次运行桌面版会准备内置编码器，需要联网。Windows 下载固定版本并校验 SHA-256，macOS 从固定版本源码构建。

在 Windows 上构建安装包：

```sh
npm run package -- --bundles nsis
```

在 macOS 上构建 DMG：

```sh
npm run package -- --bundles dmg
```

构建产物位于 `src-tauri/target/release/bundle`。Windows 便携版需要一起保留 `NeoDisc.exe`、`ffmpeg.exe` 和 `encoders` 文件夹。

## 验证

```sh
npm run prepare:encoder
npm run check:version
npm test
npm run build
npm run test:ui
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
```

界面测试在 Windows 使用 Edge，其他平台使用 Playwright Chromium；macOS / Linux 请先执行 `npx playwright install chromium`。

自动检查覆盖主题、语言选择与持久化、音频输出、EQ 频率响应与实时切换、预设保存、专辑识别、记录清理、编码参数、标签、封面、解码及取消。Windows 播放与抓轨已使用真实 USB 光驱和音频 CD 验证；macOS 光驱行为仍待真机验证。

重复读取比对可能命中光驱或系统缓存，不等同于 AccurateRip 校验。
