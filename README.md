# MiaoYan Tauri

本项目是基于 [MiaoYan](https://github.com/tw93/MiaoYan)（原作者：@tw93）的 **AI 辅助重构跨平台版本**。

## 声明

- **版权归原作者所有**：原 MiaoYan 项目的所有设计、品牌及核心创意归属于原作者 [@tw93](https://github.com/tw93)。
- **个人学习用途**：当前仓库仅作为个人技术学习与研究使用，探索将原生 Swift/macOS 应用迁移至 **Tauri + React + TypeScript + Rust** 跨平台技术栈的可行性。
- **非官方版本**：本项目与原版 MiaoYan 无官方关联，不具备任何商业用途授权。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 19 + TypeScript |
| 构建工具 | Vite 7 |
| 桌面框架 | Tauri 2 (Rust) |
| 编辑器 | CodeMirror 6 |
| Markdown 渲染 | pulldown-cmark (Rust) + highlight.js |
| 状态管理 | Zustand |
| 样式 | Tailwind CSS |

## 构建

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 本地打包（根据当前操作系统自动生成对应安装包）
npm run tauri build
```

### 各平台产物

| 平台 | 命令 | 输出产物 |
|------|------|----------|
| macOS | `npm run tauri build` | `.app` / `.dmg` |
| Windows | `npm run tauri build` | `.msi` / `.exe` |
| Linux | `npm run tauri build` | `.AppImage` / `.deb` |

跨平台打包需在目标系统上执行（例如 macOS 无法直接编译 Windows `.msi`）。推荐通过 [GitHub Actions](.github/workflows/build.yml) 自动构建：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 原版项目

- GitHub: [tw93/MiaoYan](https://github.com/tw93/MiaoYan)
- 作者: [Tw93](https://github.com/tw93)
