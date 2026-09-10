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
 

# 工具系统
搭建一个正经的系统，从工具的注册到执行到截断，每一层都要有明确的职责

- 对于模型来说，Tool是什么样子的存在？
   1. 一段描述 -- 告诉模型这个工具是做什么的，什么时候该用
   2. 一份参数 Schema -- 告诉模型这个工具需要哪些参数，参数的类型，参数的必填性等
   3. 一个执行函数 -- 真正的逻辑
  
   * 在生产环境中，还要注意这个工具能否和别的工具并发执行

   ## 并发控制
    - 模型在一次回复中说要调用多个工具，AI SDK 会并发的执行所有带有 execute 属性的工具
    - 需要 读写锁 来保护工具的执行，防止多个工具同时执行导致的并发问题

    - 经典思路：
     1. 只读工具：获取共享锁，可以和其他只读工具同时持有
     2. 读写工具：获取独占锁，必须等所有其他工具执行完毕后，才能执行

     * 假设同时有三个工具要触发，read_file, write_file, write_file。AI SDK 会同时执行三个 execute 方法。但是在执行逻辑之前，先判断该工具是否安全。如果安全，就执行并记录当前有一个工具正在执行。如果不安全，就在队列中塞入阻塞函数，阻止当前的工具执行，直到其他工具执行完毕。才放开阻塞函数进而带来了当前工具的执行。


  - ToolRegistry 解耦了工具定义和使用
  - 结果截断
  - 读写锁的并发控制

   ## 联网搜索
      1. Tavily 搜索引擎  (免费1000次/月) --- AI原生
      2. Serper 搜索引擎  (免费2500次/月)  --- Google 搜索引擎代理

   - 双引擎实现
      


    ## Agent 接入MCP
      1. 接入 GitHub MCP 服务器
    - MCP的通信协议是 JSON-RPC 2.0, 传输方式支持 stdio 和 Streamable HTTP。我们启用 stdio 本地进程，通过标准的输入输出来收发消息

    - 我们的Agent（client） 启动一个对接 MCP Server 进程，通过 stdio 发JSON消息给github mcp server。github mcpServer 会向我们的进程中返回JSON消息，我们通过 stdout 读取这些消息

      1. 握手  --- Client 发 initialize method 给 Server，Server 会返回一个 JSON-RPC 2.0 的 response，回复它支持的能力
      2. 发现工具 --- client 发 tools/list method 给 server，server 会返回所有的工具名称、描述、参数 schema 等信息
      3. 调用工具 --- 模型决定调用某个MCP工具，client 发 tools/call method 给 server，server 会执行该工具，返回工具的执行结果

    <!-- {
      "tools": [
        {
          "name": "list_issues",
          "description": "List issues in a GitHub repository",
          "inputSchema": {
            "type": "object",
            "properties": {
              "owner": { "type": "string" },
              "repo": { "type": "string" }
            },
            "required": ["owner", "repo"]
          }
        }
        ...
      ]
    } -->


    ## ToolSearch 延迟加载
    - 把不常用的工具藏起来，模型需要的时候才按需搜索，按需发现。将Prompt中的工具数量从几十个减少到几个，同时又不损失Agent的执行能力。

      - 工具分类：
        1. 核心工具：几乎每次都用得到的工具，Read、Write、Edit、Bash、Glob、Grep
        2. 低频工具：偶尔需要的，直接打上标记 shouldDefer: true，比如 WebSearch, NotionSearch，所有MCP接入的工具

        - claudeCode细节：工具被标记为 shouldDefer: true，但是这个延迟工具的 Schema 如果没有超过上下文窗口的 10%， 那依然不延迟加载

        - 打造一个元工具：tool_search：
          用户输入 -》 Agent -》 LLM --》 LLM 发现无法处理问题 Agent就调用 tool_search 工具 -》 找到了需要的工具就执行 -》 执行结果返回给LLM -》 LLM 继续回复

        - 核心工具全量携带进Prompt，延迟工具也要将自己的名字和能搜到它的关键词携带进Prompt

    ## 我们的Agent做了什么？
    1. 搭建了 ToolRegistry 模块，统一注册和管理所有的工具，加了截断和读写锁
    2. 通过MCP协议，接入了 GitHub MCP 服务
    3. 实现了 ToolSearch 延迟加载功能，解决了工具数量过大的问题


# 上下文工程

  ## 持久化上下文  --- 对话存档
   1. SQLite 数据库
   2. Redis 缓存
   3. JSON 文件

    - 我们选择用JSONL （JSON Lines）格式，因为JSONL格式简单，易读，易写
     1. 不怕崩溃，最多就是最后一条数据丢失
     2. 可调式，直接人为打开文件，查看数据
     3. 零依赖，不需要安装任何库
     

  ## 系统提示词处理  --- 让 system prompt 变得可维护，可扩展
    - 设计 Prompt Pipe 模式，将 system prompt 分成多个部分，每个部分负责不同的功能
      1. 核心规则 --- 介绍 Super Agent 的功能和限制
      2. 工具引导 --- 介绍可用的工具和搜索功能
      3. 延迟工具摘要 --- 介绍延迟工具的摘要，帮助模型理解延迟工具的功能
      4. 会话上下文 --- 介绍当前会话的上下文，帮助模型理解会话的上下文

      - 1234 这个拼接顺序是不能打乱的，应该保证不能以发生变更的模块放在最前面，因为LLM的
      KV Cache(在预测当前token时，将上一个token的预测结果作为输入，避免重复预测) 会依赖于上一个token的预测结果，所以容易变更提示词模块如果放在前面，会导致完整的系统提示词全部无法命中 缓存。

  ## 上下文压缩
    - Compaction(紧凑化)：
      1. 移除某些比较大的工具调用的内容
      2. 去重，避免重复的上下文
      3. 图片资源替换成一句 占位符

    - Summarization(摘要化)：
     1. 用LLM 来将上下文的摘要提取出来，作为新对话的上下文

    * 上下文中有哪些内容？
      1. System Prompt  （不能压）
      2. 用户输入         （不能压）
      3. 工具调用的结果    （压）
      4. 历史对话记录     （压）  

      

 




----# 文档处理工具（Excel / Word / PDF）

  办公文档是二进制 / 压缩包格式，`read_file` 按 UTF-8 读出来只有乱码 —— 所以单独做了一层解析工具。

  **代码位置：`src/tools/office/`（新增/删除办公文档工具只改这个目录，`src/tools/index.ts` 里通过 `officeTools` 一次性挂载）**

  ```text
  src/tools/office/
    index.ts          # 工具清单（officeTools）+ 统一出口
    document-utils.ts # 共享层：路径防御 / 脏值净化 / 表头识别 / 分页截断 / HTML 块解析
    excel-tools.ts    # read_excel
    word-tools.ts     # read_word
    pdf-tools.ts      # read_pdf
  ```

  ## 依赖

  ```bash
  pnpm add "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz" mammoth pdf-parse
  ```

  - `xlsx`：用 SheetJS 官方 CDN 版本（npm 上的 `xlsx` 停在 0.18.5，有已知漏洞；官方已迁出 npm）
  - `mammoth`：docx → HTML，表格结构不丢（纯 JS，无原生依赖）
  - `pdf-parse` v2：原生 ESM，按页提取文本

  ## 三个工具

  | 工具 | 模式 | 典型用法 |
  | --- | --- | --- |
  | `read_excel` | `overview` / `preview` / `search` | 先 overview 摸清有几张 Sheet、表头在第几行；再 search 查"张三在哪个考场" |
  | `read_word` | `outline` / `text` / `tables` / `search` | 先 outline 看标题树与表格清单；再 search 定位到"表格1 第3行第4列" |
  | `read_pdf` | `info` / `text` / `search` | 按真实页码读取，`pages="1-5,8"` 指定范围 |

  ## 关键设计

  1. **表头动态识别**：扫描前 15 行打分（非空格数、唯一性、文本长度、是否像数字、与下一行密度是否对齐），
     跳过空行与大标题合并行；再依据"横向合并指纹"（合并填充后行内出现重复值）向上/向下扩展，还原 `语文 / 期中` 这类两行复合表头
  2. **合并单元格还原**：按 `!merges` 用左上角值向右/向下填充，纵向合并的重复表头自动去重
  3. **脏值净化**：null / undefined / Date / 数字 / 布尔 / 公式 / 错误值 → 统一 trim 后的字符串；
     日期归一化为 ISO，数值保留原文件显示格式（百分比、金额、学号前导零），需要精确值用 `rawValues: true`
  4. **Token 保护**：单元格截断（`maxCellChars`）+ 行分页（`offset/limit`）+ 整体字符预算（12000）+ 注册表 `maxResultChars` 三层
  5. **依据事实**：每条结果都带 `Sheet 名 + Excel 行号` / `第 N 段` / `表格K 第R行第C列` / `第 N 页`，可回溯原文，查不到就返回"未在文件中检索到"
  6. **工具路由**：`read_file` 遇到 xlsx/docx/pdf 会提示改用对应工具，避免模型读出一堆乱码后产生幻觉
  7. **解析缓存**：同一文件按 mtime+size 缓存最近 3 个工作簿/文档，Agent "先 overview 再 search" 不会重复解析

  ## 自测

  ```bash
  pnpm run fixtures    # 生成脏数据夹具（大标题合并行/空行/复合表头/跨页表头/公式/日期/空表/.xls/.csv/中文 docx/PDF）
  pnpm run test:docs   # 77 项断言：表头识别、跨表检索、分页游标、错误降级、工作区解析、输出体积
  ```

# 工作区：怎么把 Excel 交给 Agent

  问题：所有工具的路径原本都按 `process.cwd()` 解析 —— 换个终端、换个启动脚本，agent 就找不到文件了。

  方案：统一锚定到工作区（`src/workspace.ts`）

  - 工作区目录：环境变量 `WORKSPACE_DIR`，默认 `<项目目录>/workspace`
  - **相对路径**：先在工作区里找 → 找不到再退回项目目录（并回传 `pathNote` 说明）
  - **`./` 开头**：显式相对项目目录（改代码文件用，如 `./src/index.ts`）
  - **绝对路径**：原样使用，工作区外的文件也能读

  投喂流程：

  ```powershell
  copy D:\旅梦资料\成绩表.xlsx workspace\
  pnpm start
  #  You: 读 成绩表.xlsx，统计各班人数
  ```

  启动时会打印工作区目录；系统提示末尾会注入"工作区 + 当前文件清单"，所以直接说文件名即可。
  （放最后是为了不影响前面静态提示词的 KV Cache 命中 —— 文件清单是会变的内容）

  安全与卫生：`.gitignore` 已忽略 `workspace/` 与 `.sessions/`，学生名单、成绩等敏感数据不会被提交。

--------------------- 杂项 -------------------------
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