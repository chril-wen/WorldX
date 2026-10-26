# 致谢与出处

> **这份文档为什么存在**
>
> 阶段 6 是一次大规模重构（文档 + CLI + 架构收敛）。
> 重构本身不改变归属 —— 但**重构时把出处搞丢**是很常见的事，
> 所以把归属明确写下来。

---

## 许可证

**MIT** —— 见仓库根的 [`LICENSE`](../LICENSE)。

```
MIT License
Copyright (c) 2026 WorldX Contributors
```

> **为什么 LICENSE 里还是 "WorldX"**
>
> 版权声明指向**原作者与原始项目**，不能因为本地改了目录名就改它 ——
> 那会让归属失真。本地项目现在叫 **OWN-World**（2026-10-26 重命名），
> 但著作权归属不变：仍是上游 WorldX 的贡献者。

MIT 允许任何人使用、修改、分发（包括闭源和商用），
唯一要求是**保留版权声明和许可证正文**。

> 重构没有改动 LICENSE 文件，也没有改其中的版权声明。

---

## 项目起源

本项目（现名 **OWN-World**）起源于 **WorldX**，由 **顾伊凡**（guyifan.1@bytedance.com）在 2026-04-18 的
首个提交 `dba3ffa feat: init!`。

后续由多人共同维护：

| 贡献者 | 提交数 |
|---|---|
| bodinggg | 59 |
| YGYOOO / YGY | 22 |
| 顾伊凡 | 7 |

完整的逐条记录在 `git log`。

---

## 致谢

- **[LinuxDO](https://linux.do/)** —— 社区
- 每一位提交过代码、提过 issue、参与过讨论的人

---

## 第三方依赖

本项目使用了大量开源依赖。各依赖的许可证随其分发。

核心依赖：

| 依赖 | 用途 | 许可证 |
|---|---|---|
| `zod` | schema 校验 | MIT |
| `nanoid` | ID 生成 | MIT |
| `easystarjs` | 寻路 | MIT |
| `express` | HTTP 层 | MIT |
| `better-sqlite3` | 持久化 | MIT |
| `phaser` | 游戏画面 | MIT |
| `react` / `react-dom` | UI | MIT |
| `vite` | 构建 | MIT |
| `vitest` | 测试 | MIT |
| `tsx` | TS 直接执行 | MIT |
| `dotenv` | 环境变量 | BSD-2-Clause |

完整的清单见各子项目的 `package.json`。

---

## 重构过程中的归属保持

阶段 4~6 的重构做了这些事，**没有一件碰到归属**：

- 没有改 LICENSE 文件或版权声明
- 没有删掉 README 里的致谢段
- 没有删过 git 历史（所有提交都还在）
- 没有删任何版权头

如果将来要改许可证、加第三方代码、或者改变项目归属，
**先看这份文档**。

---

## 2026-10-26 的重命名

| 改了什么 | 从 | 到 |
|---|---|---|
| 代码目录 | `E:\WordX\WorldX` | `E:\WordX\OWN-World` |
| 设计文档目录 | `E:\WordX\workspace` | `E:\WordX\OWN-World-design` |
| npm 包名 | `worldx` / `@worldx/*` | `own-world` / `@own-world/*` |
| CLI 命令 | `worldx` | `own-world`（`worldx` 保留为别名） |

**没有变的**：

- `LICENSE` 的版权声明 —— 仍写 `Copyright (c) 2026 WorldX Contributors`
- GitHub 远端地址 —— 仍是上游的 `YGYOOO/WorldX`
- git 历史 —— 一个提交都没删
- 归属 —— 仍是上游 WorldX 的贡献者

包名改了**不影响归属**：MIT 授予的是「任何人」，改名不改变
「谁写的」这个事实。想让上游的贡献者知道这件事，走 PR 或 issue，
而不是改 LICENSE。
