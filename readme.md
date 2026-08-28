# 项目起手
1. pnpm init 初始化项目
2. pnpm install typescript --save-dev 安装typescript
3. tsc --init 初始化tsconfig.json

4. pnpm add ai @ai-sdk/openai dotenv   (ai 这个SDK 主要是以openai的标准用来调用openai的api)
5. pnpm add -D tsx @types/node


# ai 这个SDK 
- generateText 生成文本
- streamText 流式生成文本

# 进程持续
- readline 读取用户输入
- process.stdout.write 写入标准输出
- process.stdin.write 写入标准输入
- process.exit 退出进程

# 模型调用三要素
1. 模型调用： StreamConsumer --- 解析工具调用，推理过程程，token用量等多种事件
<!-- streamText + model -->
2. 消息管理： 四层上下文管理 --- 截断、时间衰减修剪、LLM摘要压缩、Cache优化   <!--messages-->
3. 交互循环： AgentLoop --- while(true) {think - act - observe}   
<!-- ask递归调用 -->


# 从能聊天到能干活
user: 南昌今天的天气怎么样?
agent: [调用get_waether 工具] -> 南昌今天晴，30摄氏度，东南风2级

- SDK ai 提供的 streamText 方法存在自动循环机制
  用户提问 -> 模型说要调用工具 -> 调用工具 -> 得到工具返回结果 -> 再次调用模型 -> 返回给用户

    - 可定制性太差 --- 我们没有办法在循环的步骤中间插入自定义的逻辑（比如：添加日志、添加缓存、添加错误处理等）

# 上保险丝
1. 死循环检测：连续调用相同工具 + 相同参数？ 打断循环
   1. 通用循环：同一个工具，相同参数，相同结果，重复调用
      - 将工具名+参数做一个确定性的JSON序列化，再哈希加密，
      get_weather({city: '南昌', num: 1}) -> 12x3dasd45fadsa6(文件指纹)
      - 滑动窗口：比如就看最近的30轮有没有重复的文件指纹
      - 同样的输入 + 相同的输出 == 无进展  （只有调用指纹和结果指纹都相同，才认为是无进展的）

   2. 乒乓循环：两个工具，交替调用，结果没有进展
   3. 轮询无进展：不断的poll检查状态，但是状态没有变化

2. Token 预算：烧了多少token？ 超过预算？ 打断循环
   - 把每一步的token用量都记录下来，超过预算后，就打断循环 

3. API容错：请求重试，降低模型
   - 错误要分类，有些错误值得重试，有些错误不值得
   - 指数退避 + 随机抖动


 - 从能跑 到 ‘跑不挂’
 




------------------------- 杂项 -------------------------
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