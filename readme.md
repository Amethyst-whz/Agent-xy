# 项目名字 ：小因（xy）

## 常用 Git 操作

```bash
# 1. 提交（一次）
git add .
git commit -m "feat: xxx"

# 2. 分别推送
git push origin main   # GitHub
git push gitee main    # Gitee

# 一键双推（GitHub + Gitee 同时）
git push both main

# 3. 拉取最新（以 GitHub 为准，防止两边分叉）
git pull origin main
```

### 远程仓库

| 远程 | 用途 | 地址 |
| --- | --- | --- |
| `origin` | GitHub | https://github.com/Amethyst-whz/Agent-xy.git |
| `gitee` | Gitee | https://gitee.com/amethyst_whz/agent-xy.git |
| `both` | 一键双推 | fetch: GitHub / push: GitHub + Gitee |

---

# 项目起手
1. pnpm init 初始化项目
2. pnpm install typescript --save-dev 安装typescript
3. tsc --init 初始化tsconfig.json

4. pnpm add ai @ai-sdk/openai dotenv   (ai 这个SDK 主要是以openai的标准用来调用openai的api)
5. pnpm add -D tsx @types/node