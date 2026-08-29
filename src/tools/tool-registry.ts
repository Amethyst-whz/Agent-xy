import { jsonSchema } from "ai";


export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (input: any) => Promise<unknown>;

    isConcurrencySafe?: boolean;
    isReadOnly?: boolean;
    maxResultChars?: number;

   }


const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
    private tools= new Map<string, ToolDefinition>();

    // 用三个状态变量来构成一把读写锁
    private exclusiveLock = false;  // 当前是否有独占锁的持有者
    private concurrentCount = 0;  // 当前共享锁的持有数
    private waitQueue: Array<() => void> = [];  // 等待队列, 阻塞等待中的 resolve 函数

    register(...tools: ToolDefinition[]):void {
        for(const tool of tools) {
            this.tools.set(tool.name, tool);
        }
    }

    get(name: string):ToolDefinition | undefined {
        return this.tools.get(name);
    }

    getAll():ToolDefinition[] {
        return [...this.tools.values()];
    }

    // 获取共享锁
    private async acquireConcurrent(): Promise<void> {
        while (this.exclusiveLock) {
            await new Promise<void>(resolve => this.waitQueue.push(resolve));
        }
        this.concurrentCount++;
    }

    // 释放共享锁
    private releaseConcurrent(): void {
        this.concurrentCount--;
        if (this.concurrentCount === 0) this.drainQueue();
    }

    // 获取独占锁
    private async acquireExclusive(): Promise<void> {
        while (this.exclusiveLock || this.concurrentCount > 0) {
            await new Promise<void>(resolve => this.waitQueue.push(resolve));
        }
        this.exclusiveLock = true;
    }

    // 释放独占锁
    private releaseExclusive(): void {
        this.exclusiveLock = false;
        this.drainQueue();
    }

    // 锁释放时，唤醒等待队列中的 resolve，让它们重新去抢锁
    private drainQueue(): void {
        const waiting = this.waitQueue.splice(0);
        for(const resolve of waiting) {
            resolve();
        }
    }

toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 执行前按 isConcurrencySafe 决定加共享锁还是独占锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(` [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(` [串行] ${name} 获得独占锁，等待其他工具完成`);
          }

          try {
            const raw = await executeFn(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 无论成功失败都要释放锁
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS) {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略${dropped}个字符] \n\n${tail}`;
}
