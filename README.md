# NeoDisc · 让音乐，慢下来

<img src="assets/neodisc.png" alt="NeoDisc" width="128" />

[English](README_EN.md) · [GitHub Actions](https://github.com/ylzz1997/NeoDisc/actions)

当前开发版本：**0.1.0**。发布由版本标签触发；普通提交只运行检查。

一个面向实体 CD 的桌面播放器与抓轨工具。Rust 负责读盘、音频输出、无损编码及任务管理，随包 FFmpeg 负责 MP3 / AAC 编码，Tauri 2 + React / TypeScript 负责界面。布局参考现代音乐客户端：无系统标题栏、左侧导航、专辑与曲目列表、底部常驻播放器。

## 当前功能

- 无边框窗口，顶部可拖动，最小化 / 最大化 / 关闭按钮与界面一体化。
- 简体中文 / English，默认跟随系统语言；在首选项手动切换后立即生效并记住选择。系统语言不受支持时回退英文，专辑、曲名、设备名称和文件路径保持原样。
- 默认暖夜琥珀；另有石墨珊瑚、深林青苔，每套都有浅色和深色。
- 深色 / 浅色 / 跟随系统 / 定时夜间模式；定时支持跨午夜，按照电脑本地时间执行。
- 读取 CD 曲目目录，播放 / 暂停 / 上下曲 / 进度跳转 / 音量 / 列表循环；空格控制播放。
- 首选项可查看、选择音频输出设备与实际输出格式；默认跟随系统切换，支持刷新列表和手动重连，记住设备选择。
- 切换输出时保留曲目、位置和暂停状态；输出连接失败时暂停，设备恢复后可从原位置继续。
- 本地编辑专辑、艺术家、曲目名称，按光盘目录指纹记忆信息。
- 勾选曲目导出 FLAC 或 WAV，保留 44.1 kHz、16-bit、双声道 PCM。
- 也可导出 MP3 或 AAC-LC（`.m4a`）；详细设置支持 16 / 22.05 / 24 / 32 / 44.1 / 48 kHz、兼容码率与声道选择。
- MP3 支持 CBR、ABR、VBR（V0–V9）、联合立体声 / 立体声 / 单声道，以及 0–9 编码精度；AAC 使用目标码率、立体声或单声道。设置分别记忆，提供高音质 / 均衡 / 小体积预设。
- FLAC 内嵌 TITLE、ARTIST、ALBUMARTIST、ALBUM、TRACKNUMBER、TRACKTOTAL 标签及 PCM MD5。
- 每次导出生成播放列表 `playlist.m3u8` 和含每轨原始 CD PCM SHA-256 的 `rip-report.json`；压缩格式也记录编码参数。哈希对应重采样 / 有损编码之前的源音频。
- 可选重复读取比对；失败最多重试三轮。不一致时明确报错，不用静音填补。
- 后台抓轨、进度、取消、关闭保护、完成记录、打开输出目录。
- 抓轨记录可逐条删除并撤销，只清除记录，保留音频文件；目录被删除或移动后显示「目录不存在」，权限或检查异常显示「无法访问目录」。
- 记录页提供「一键清理」：重新检查全部目录后，一次移除目录不存在的记录，保留无法访问的记录，并可整批撤销。
- 新建独立导出目录，重名自动增加编号；取消或出错时清理本次未完成文件，保留完成曲目。
- 读入 CD 后自动通过 MusicBrainz 查询专辑、曲名和艺术家，并从 Cover Art Archive 获取封面；只发送光盘 Disc ID，不上传音频。
- 匹配失败、网络超时或信息有歧义时静默保留默认显示；识别不阻塞播放和抓轨，保留手动编辑。
- 获取到的封面显示在专辑与播放器中，抓轨时嵌入 FLAC、MP3 或 M4A，并在导出目录保存封面文件。Windows 安装包和完整便携包自带编码器，用户无需另装 FFmpeg。

## 平台与验证状态

| 平台 | 光盘读取方式 | 状态 |
| --- | --- | --- |
| Windows x64 | `IOCTL_CDROM_READ_TOC` / `IOCTL_CDROM_RAW_READ` | 已在本机 USB 光驱和真实音频 CD 上验证 |
| macOS Apple Silicon / Intel | 读取系统 cddafs 挂载的 AIFF / AIFC 音轨 | 适配代码、AIFF 单元测试和双架构构建配置已完成，**尚未在 Mac 上构建或验证光驱** |

Windows 实测包括：10 轨 CD 目录、三秒 WAV/FLAC 抽样、完整第一轨 FLAC 导出、独立 Claxon 解码后逐样本 / SHA-256 比对、静音播放、暂停、恢复、跳转、自然结束，以及取消清理。本次还通过完整第一轨 MP3（48 kHz / 192 kbps / 立体声）、AAC（32 kHz / 96 kbps / 单声道）抓取，核对格式、时长、标签、播放列表及源 PCM 哈希一致性，并验证读取与编码阶段取消后无临时文件残留。Mac 适配模块在 Windows 单元测试中也参与类型检查，但这不替代 Mac 真机验证。

macOS 仅列出已由系统挂载的音频 CD，空光驱不会显示。需要连接兼容的 USB 光驱；放入 CD，待 Finder 中出现音轨后刷新。最低系统版本配置为 macOS 12。正式对外分发的 Mac 应用仍需开发者签名与公证；此仓库未配置签名凭据。

## 使用

1. 打开桌面版，插入音频 CD。应用启动时扫描光驱，也可以手动刷新。
2. 单击「播放全部」或双击曲目试听。顶部搜索仅过滤当前光盘曲目。
3. 专辑信息在后台自动识别，没有结果时保留原显示，不弹出搜索或选择框。「编辑信息」仍可修改文字。
4. 勾选曲目，在右侧选择 FLAC / WAV / MP3 / AAC 和保存位置。MP3 / AAC 下点击「编码详细设置」选择参数，再点击「开始抓轨」。
5. 「外观与皮肤」中选择皮肤和自动夜间方式。设置立即保存到本机。
6. 左侧「首选项」或播放器右下角的设置按钮可查看音频输出。通常选择「跟随系统默认」；只想使用某副耳机时，直接选择该设备。无声时可点击「重新连接输出」。

跟随系统模式约每秒检查默认输出，设备变化时重建音频连接。指定设备按名称记忆；设备未连接时暂停并显示原因，不会自动改用其他音箱。重新连上后点击播放继续。若有多个完全同名的设备，请先在系统中重命名。

抓轨期间停止播放并占用光驱。完成后可以在抓轨记录中打开文件夹。默认保存到系统音乐目录下的 `NeoDisc` 文件夹。

MP3 / AAC 为有损格式，码率越高通常保留更多细节；提高采样率不会增加 CD 原本没有的细节。AAC 使用兼容性较广的 AAC-LC 与 M4A 封装，不提供 HE-AAC。低采样率或单声道下会自动收窄可选码率，后端也会再次校验；VBR 文件大小随音乐内容变化。

压缩抓轨逐曲先将原始 PCM 写入本次输出目录的临时文件，完成读取与可选比对后再编码。每轨需要额外的原始音频临时空间；完成、取消或失败后清理该轨临时文件，保留先前完成的曲目。读取占该轨进度的 90%，随后显示编码阶段。

记录页右侧的垃圾桶按钮删除单条记录，页面内的「撤销」可恢复最近删除的一条。删除结果自动保存，重启后仍生效；这项操作不删除磁盘上的音频文件。进入记录页、切回窗口及记录页可见时每 5 秒检查保存目录，也可点击右上角刷新。目录不可用时禁用「打开文件夹」，恢复到原位置后会重新启用。

右上角「一键清理」会先重新检查目录，再删除所有确认为「目录不存在」的记录，按钮上的数字表示最近一次检查发现的失效记录数。「无法访问目录」和检查失败的记录会保留；刚恢复的目录也不会因旧状态被清理。完成后可一次撤销整批清理；检查期间离开记录页会取消这次清理。

识别成功缓存 30 天，未收录结果缓存 1 天；网络错误仅短时避重复请求。缓存保存在系统缓存目录下的 `NeoDisc/metadata-v1`，已有正向缓存可离线使用。抓轨使用开始时的元数据快照，后台识别不会改写正在导出的文件。

原型曾使用 Lucent 名称；当前版本保留应用标识与原设置键，以兼容已有皮肤、输出设备、专辑编辑和抓轨记录。新用户默认使用暖夜琥珀，已保存的个人皮肤选择继续保留。

## 开发与构建

需要 Node.js 24+、npm、稳定版 Rust，以及 [Tauri 对应系统构建环境](https://v2.tauri.app/start/prerequisites/)。Windows 需要 MSVC C++ 构建工具与 WebView2；macOS 需要 Xcode Command Line Tools。

```sh
npm ci
npm run desktop
```

仅查看浏览器界面：

```sh
npm run dev
```

浏览器版本有明确的「界面预览」提示，显示示例曲目；不会模拟成功播放或生成假的抓轨文件。

Windows 安装包：

```sh
npm run package -- --bundles nsis
```

输出为 `src-tauri/target/release/bundle/nsis/NeoDisc_0.1.0_x64-setup.exe`。便携版需一起携带 `NeoDisc.exe`、`ffmpeg.exe` 和 `encoders` 许可 / 来源目录；仅复制主程序无法进行 MP3 / AAC 编码。便携版也需要 WebView2。

`npm run desktop` / 打包时会自动准备编码器。Windows 使用固定版本、校验 SHA-256 的 [BtbN LGPL 构建](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59)；macOS 准备脚本从固定版本 FFmpeg 与 LAME 源码构建仅需的音频功能，不依赖用户电脑上的 Homebrew 动态库。首次准备需要联网，结果缓存在 `artifacts/encoder-download`，许可与来源清单随包附带。macOS 的准备脚本仍待在 Mac 上验证。

在 Mac 上构建当前架构：

```sh
npm ci
npm run package
```

或分别构建 Apple Silicon / Intel：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
NEODISC_ENCODER_TARGET=aarch64-apple-darwin npm run tauri build -- --target aarch64-apple-darwin
NEODISC_ENCODER_TARGET=x86_64-apple-darwin npm run tauri build -- --target x86_64-apple-darwin
```

## GitHub Actions 与发布

- `.github/workflows/desktop.yml`：推送 `main`、提交 PR 或手动触发时，检查版本一致性、前端与翻译、界面交互及 Windows / macOS 双架构编译。普通提交不会发布 Release。
- `.github/workflows/release.yml`：只在推送 `v*` 标签时运行。先检查标签与应用版本一致，再执行全部检查，生成 Windows x64 安装 EXE、Apple Silicon DMG、Intel DMG。三个安装包全部成功后，一次发布 GitHub Release 和 `SHA256SUMS.txt`。
- 使用 GitHub 自动提供的 `GITHUB_TOKEN`，仅发布任务需要 `contents: write`；无需保存个人访问令牌。当前构建不配置开发者签名或 Apple 公证。

准备好发布时再执行以下命令（仅示例，不会由普通提交自动执行）：

```sh
node scripts/set-version.mjs 0.1.0
npm run check:version
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "Prepare v0.1.0"
git tag v0.1.0
git push origin main v0.1.0
```

版本已正确设置时无需重复提交；只在准备正式发布时推送标签。包含 `-beta.1` 等后缀的版本会标记为预发布。

## 翻译与图标

界面翻译位于 `src/locales/en.json`，引擎状态与错误提示位于 `src/locales/native-en.json`；简体中文使用源文案。`src/i18n.ts` 处理系统语言、即时切换、插值和日期语言。新增文案使用 `tr()`，插值参数保留原始曲名和路径，翻译覆盖检查随 `npm test` 执行。

图标源文件为 `assets/neodisc.png`，采用扁平 CD 与圆角矩形，外侧透明。平台图标位于 `src-tauri/icons`；修改源图后使用 `npm run tauri icon -- assets/neodisc.png` 重新生成。

## 验证

```sh
npm run prepare:encoder
npm test
npm run test:ui
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

0.1.0 本机通过 23 项 Rust 测试、8 项前端逻辑测试与 23 项界面测试。覆盖历史记录删除、批量清理、目录恢复、撤销和音频文件保留；多语言覆盖系统默认、手动覆盖、即时切换、持久化、英文回退、参数插值、错误翻译和最小窗口尺寸。

真实内置编码器测试覆盖 MP3 CBR / ABR / VBR、AAC、多个采样率和声道；使用 FFprobe 检查格式、标签与封面，并解码检查时长和音频样本。另验证拒绝覆盖已有输出及终止正在编码的进程。在线使用 MusicBrainz 文档示例 TOC 成功取得曲名与封面；本机实体 CD 查询返回未收录。

UI 测试在 Windows 使用已安装的 Edge，在其他平台使用 Playwright Chromium（先运行 `npx playwright install chromium`）。测试包括皮肤与系统主题切换、跨午夜时间判断、设置持久化、搜索、曲目选择、元数据编辑和最小窗口尺寸。

音频路由单元测试覆盖默认设备变化、同名端点替换、设备断开、连接失败、旧音频流回调和重连。首选项 UI 测试通过模拟 IPC 验证选择持久化、状态更新与错误恢复。Windows 本机已对 3 个实际输出设备进行静音切换，并用真实 CD 验证重连、暂停位置保留与恢复；未自动修改操作系统默认设备，Mac 音频路由仍待真机验证。

音频输出诊断（不传光驱参数时只列出设备；传入光驱后静音测试切换与恢复，不修改系统默认输出）：

```sh
cd src-tauri
cargo run --example audio_output_smoke -- E:
```

光驱诊断（会旋转光盘，保存三秒音频到指定目录；输出文件若已存在会拒绝覆盖）：

```sh
cd src-tauri
cargo run --example probe -- E: ../artifacts/hardware-probe
```

完整硬件测试（静音播放、导出第一首完整 FLAC、再次启动并取消导出）：

```sh
cd src-tauri
cargo run --example hardware_smoke -- E: ../artifacts/hardware-smoke
```

Mac 下将 `E:` 替换为实际挂载路径，例如 `/Volumes/Audio CD`，路径含空格时用引号包裹。硬件测试不随普通单元测试执行。

压缩抓轨硬件测试（完整第一轨 MP3 / AAC 导出、参数与标签检查、原始 PCM 哈希一致性、读取和编码阶段取消清理）：

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example compressed_smoke -- E: artifacts/compressed-hardware
```

在线识别诊断（`--reference` 使用 MusicBrainz 官方文档的示例 TOC，并非光驱中的 CD）：

```sh
cd src-tauri
cargo run --example metadata_probe -- E:
cargo run --example metadata_probe -- --reference
```

## 当前边界

- 重复比对可能命中光驱 / 系统缓存；这**不是** EAC / cdparanoia 级安全抓轨，也未接入 AccurateRip、C2 指针、抖动修复或光驱采样偏移校正。
- 不处理 HTOA、INDEX 00 / pregap 提取和精确 gapless 曲目拼接；混合模式 / 多区段 CD 尚未做硬件验证。
- Windows 识别 TOC 预加重标志并提示，但保留原始采样、不应用去加重；macOS 当前不提取该标志。
- 播放经过系统共享音频输出，不提供独占模式或 DAC bit-perfect 保证。
- 自动识别仅接受精确 Disc ID 匹配；同一光盘的多个发行版本文字一致时自动选择，否则跳过。不做模糊匹配或手动搜索。混合模式 / 多区段盘暂跳过自动识别。
- 暂无 CD-TEXT 文字读取、歌词或本地文件音乐库；压缩抓轨目前提供 MP3 与 AAC-LC。
- 硬件断开或坏盘会报错；操作系统正在等待光驱的同步读取调用不能被强制中断，取消可能要等该次调用返回。

## 代码入口

```text
src/App.tsx                    窗口、主题、播放与抓轨界面
src/styles.css                 三套皮肤、明暗配色及响应式布局
src/theme.ts                   跨午夜夜间模式与设置
src/Preferences.tsx            音频设备选择、状态与重连界面
src/HistoryPage.tsx            抓轨历史删除、撤销与目录状态
src/EncodingSettings.tsx       压缩格式选择、预设与详细编码设置
src/encoding.ts                编码参数兼容规则与设置迁移
src-tauri/src/lib.rs            IPC 命令、光驱占用与任务协调
src-tauri/src/history.rs        保存目录的只读状态检查
src-tauri/src/audio.rs          设备枚举、默认输出监测与音频流重建
src-tauri/src/metadata.rs       精确 Disc ID 匹配、封面与本地缓存
src-tauri/src/device/windows.rs Windows CD-DA 扇区读取
src-tauri/src/device/macos.rs   macOS cddafs 挂载盘适配
src-tauri/src/aiff.rs           AIFF / AIFC 解析及大小端转换
src-tauri/src/playback.rs       读盘预缓冲、音频线程与播放状态
src-tauri/src/encode.rs         流式 WAV / FLAC 编码
src-tauri/src/lossy.rs          MP3 / AAC 编码进程、参数与取消
src-tauri/src/rip.rs            重复比对、取消、文件与抓轨日志
scripts/prepare-encoder.mjs    校验、准备及打包平台编码器
```

实现参考：[Microsoft CD-ROM RAW_READ_INFO](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddcdrm/ns-ntddcdrm-__raw_read_info)、[Apple cddafs](https://github.com/apple-oss-distributions/cddafs)、[flacenc](https://docs.rs/flacenc/0.5.1/flacenc/)、[Rodio](https://docs.rs/rodio/0.21.1/rodio/)。
